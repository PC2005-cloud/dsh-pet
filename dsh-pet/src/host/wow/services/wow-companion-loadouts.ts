import type { InferOutput } from 'valibot';

import type { BridgeStatus, Snapshot } from '../shared/wow-companion';
import type { EquipmentLoadout, EquipmentLoadoutsState } from '../shared/wow-companion-loadout';

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { errorMessageFrom } from './errors';
import {
  array,
  check,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  parse,
  pipe,
  regex,
  safeParse,
  strictObject,
  string,
} from 'valibot';

import { snapshotSchema } from '../shared/wow-companion';
import { companionError } from '../shared/wow-companion-errors';
import { moneyIdSchema } from '../shared/wow-companion-gold';
import { equipmentLoadoutSchema } from '../shared/wow-companion-loadout';

const timestamp = pipe(number(), integer(), minValue(0), maxValue(4102444800000));
const label = pipe(string(), maxLength(256));
const identity = pipe(string(), minLength(1), maxLength(48), regex(/^[\w-]+$/));
const characterSchema = strictObject({
  account: moneyIdSchema,
  guid: identity,
  session: pipe(identity, maxLength(40)),
  name: label,
  realm: label,
  loginObservedAt: timestamp,
});
const entrySchema = strictObject({
  account: moneyIdSchema,
  name: label,
  realm: label,
  receivedAt: timestamp,
  loadout: equipmentLoadoutSchema,
});
const fileSchema = pipe(
  strictObject({
    version: literal(1),
    entries: array(entrySchema),
    latestCharacter: nullable(characterSchema),
    seenSessions: pipe(array(pipe(string(), maxLength(256))), maxLength(512)),
  }),
  check(
    (value) =>
      new Set(value.entries.map((entry) => JSON.stringify([entry.account, entry.loadout.guid]))).size ===
        value.entries.length && new Set(value.seenSessions).size === value.seenSessions.length,
    'Duplicate saved loadout identities',
  ),
);

type SavedFile = InferOutput<typeof fileSchema>;

function freeze(value: object) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) freeze(child);
  }
}

/**
 * Owns one latest equipment revision per account and character, without the acquisition history's ten-entry limit.
 * Only live matching sessions can replace equipment. Login precedence changes once per observed session, including across desktop restarts.
 */
export class CompanionLoadouts {
  private data: SavedFile = { version: 1, entries: [], latestCharacter: null, seenSessions: [] };
  private storageError: string | null = null;
  private blocked = false;
  private dirty = false;
  private loading: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private projection: EquipmentLoadoutsState | undefined;
  private lastRecord: string | undefined;
  private readonly sessionOwners = new Map<string, string>();

  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Loads once. Corrupt source files remain untouched and block automatic replacement. */
  load() {
    this.loading ??= this.loadFile();
    return this.loading;
  }

  /** This cached frozen projection changes only after accepted equipment, a new login, or a storage error. */
  read(): EquipmentLoadoutsState {
    if (!this.projection) {
      this.projection = structuredClone({
        entries: this.data.entries,
        latestCharacter: this.data.latestCharacter,
        storageError: this.storageError,
      });
      freeze(this.projection);
    }
    return this.projection;
  }

  /** Saves only complete bridge revisions. Fragment progress cannot expose a mixture of old and new slots. */
  observe(bridge: BridgeStatus | null, error: string | null = null) {
    return this.enqueue(async () => {
      await this.load();
      if (this.blocked || error || bridge?.error || bridge?.status !== 'live' || bridge.source !== 'screen') return;
      const parsed = safeParse(snapshotSchema, bridge.snapshot);
      if (!parsed.success || !parsed.output.online) return;
      const snapshot = parsed.output;
      this.observeLogin(snapshot, bridge);
      const candidate = bridge.equipmentLoadout;
      if (
        !bridge.equipmentLoadoutError &&
        candidate &&
        candidate.session === snapshot.session &&
        candidate.guid === snapshot.guid
      ) {
        const key = JSON.stringify([snapshot.account, candidate.guid, candidate.session, candidate.id]);
        // The bridge owns immutable revisions. Repeated polls never serialize or clone the full equipment again.
        if (key !== this.lastRecord) {
          const record = safeParse(equipmentLoadoutSchema, candidate);
          if (record.success) {
            this.accept(snapshot, record.output);
            this.lastRecord = key;
          }
        }
      }
      await this.save();
    });
  }

  /** Flushes accepted observations during normal application exit. */
  flush() {
    return this.enqueue(async () => {
      await this.load();
      await this.save();
    });
  }

  private enqueue(operation: () => Promise<void>) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private observeLogin(snapshot: Snapshot, bridge: BridgeStatus) {
    const key = JSON.stringify([snapshot.account, snapshot.guid, snapshot.session]);
    if (this.data.seenSessions.includes(key)) return;
    let loginObservedAt: number | undefined;
    for (const event of bridge.events) {
      const player = event.snapshot;
      if (
        event.type !== 'connected' ||
        event.demo ||
        !player ||
        player.account !== snapshot.account ||
        player.guid !== snapshot.guid ||
        player.session !== snapshot.session
      )
        continue;
      const at = Date.parse(event.timestamp);
      if (Number.isFinite(at) && at >= 0 && at <= Date.now() && (loginObservedAt === undefined || at < loginObservedAt))
        loginObservedAt = at;
    }
    // Without a connection timestamp, first receipt is the only observed login time.
    loginObservedAt ??= Date.now();
    this.data.seenSessions.push(key);
    this.data.seenSessions = this.data.seenSessions.slice(-512);
    this.sessionOwners.set(JSON.stringify([snapshot.account, snapshot.guid]), snapshot.session);
    if (!this.data.latestCharacter || loginObservedAt >= this.data.latestCharacter.loginObservedAt) {
      this.data.latestCharacter = {
        account: snapshot.account,
        guid: snapshot.guid,
        session: snapshot.session,
        name: snapshot.name,
        realm: snapshot.realm,
        loginObservedAt,
      };
    }
    this.dirty = true;
    this.projection = undefined;
  }

  private accept(snapshot: Snapshot, loadout: EquipmentLoadout) {
    // A known old session cannot regain ownership through a late bridge response or screen replay.
    if (this.sessionOwners.get(JSON.stringify([snapshot.account, snapshot.guid])) !== loadout.session) return;
    const index = this.data.entries.findIndex(
      (entry) => entry.account === snapshot.account && entry.loadout.guid === loadout.guid,
    );
    const previous = this.data.entries[index];
    if (previous?.loadout.session === loadout.session && previous.loadout.id >= loadout.id) return;
    const entry = {
      account: snapshot.account,
      name: snapshot.name,
      realm: snapshot.realm,
      receivedAt: Date.now(),
      loadout: structuredClone(loadout),
    };
    if (index < 0) this.data.entries.push(entry);
    else this.data.entries[index] = entry;
    this.projection = undefined;
    this.dirty = true;
  }

  private async loadFile() {
    try {
      this.data = parse(fileSchema, JSON.parse(await readFile(this.filePath, 'utf8')));
      for (const key of this.data.seenSessions) {
        const value: unknown = JSON.parse(key);
        if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== 'string'))
          throw new Error('Invalid saved loadout session');
        this.sessionOwners.set(JSON.stringify(value.slice(0, 2)), String(value[2]));
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      this.blocked = true;
      this.storageError = companionError('loadouts-read', {
        path: this.filePath,
        detail: errorMessageFrom(error) ?? '',
      });
      this.projection = undefined;
    }
  }

  private async save() {
    if (this.blocked || !this.dirty) return;
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const file = await open(temporaryPath, 'wx');
      try {
        await file.writeFile(JSON.stringify(this.data), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      this.dirty = false;
      if (this.storageError) {
        this.storageError = null;
        this.projection = undefined;
      }
    } catch (error) {
      this.storageError = companionError('loadouts-write', {
        path: this.filePath,
        detail: errorMessageFrom(error) ?? '',
      });
      this.projection = undefined;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
