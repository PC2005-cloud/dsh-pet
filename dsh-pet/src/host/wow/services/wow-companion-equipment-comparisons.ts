import type { InferOutput } from 'valibot';

import type { BridgeStatus, Snapshot } from '../shared/wow-companion';
import type { EquipmentComparison, EquipmentComparisonsState } from '../shared/wow-companion-equipment-comparisons';

import { createHash, randomUUID } from 'node:crypto';
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
  minValue,
  number,
  parse,
  pipe,
  regex,
  safeParse,
  strictObject,
  string,
} from 'valibot';

import { snapshotSchema } from '../shared/wow-companion';
import { equipmentComparisonSchema } from '../shared/wow-companion-equipment-comparisons';
import { companionError } from '../shared/wow-companion-errors';
import { moneyIdSchema } from '../shared/wow-companion-gold';

const entrySchema = strictObject({
  account: moneyIdSchema,
  name: pipe(string(), maxLength(256)),
  realm: pipe(string(), maxLength(256)),
  receivedAt: pipe(number(), integer(), minValue(0), maxValue(4102444800000)),
  comparison: equipmentComparisonSchema,
});
const historySchema = pipe(
  strictObject({
    version: literal(1),
    entries: pipe(array(entrySchema), maxLength(10)),
    seen: pipe(array(pipe(string(), maxLength(64), regex(/^[a-f0-9]{64}$/))), maxLength(512)),
  }),
  check((value) => {
    const identities = value.entries.map((entry) => identity(entry.account, entry.comparison));
    return (
      new Set(value.seen).size === value.seen.length &&
      new Set(identities).size === identities.length &&
      identities.every((key) => value.seen.includes(key))
    );
  }, 'Invalid saved equipment identities'),
);

type SavedHistory = InferOutput<typeof historySchema>;

function identity(account: string, record: EquipmentComparison) {
  return createHash('sha256')
    .update(JSON.stringify([account, record.guid, record.session, record.id]))
    .digest('hex');
}

/**
 * Saves ten acquisition comparisons per game across characters, in first-receipt order.
 * The latest 512 identity hashes reject repeated decoder frames, including discarded records, across desktop restarts.
 * Writes are serialized and atomic. A corrupt source blocks mutations and remains untouched.
 */
export class CompanionEquipmentComparisons {
  private history: SavedHistory = { version: 1, entries: [], seen: [] };
  private storageError: string | null = null;
  private blocked = false;
  private dirty = false;
  private loading: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Loads once before observations. A failed read remains visible until the next desktop start. */
  load() {
    this.loading ??= this.loadFile();
    return this.loading;
  }

  /** Returns saved comparisons even after disconnects or character changes. The result cannot mutate the owned history. */
  read(): EquipmentComparisonsState {
    return { entries: structuredClone(this.history.entries), storageError: this.storageError };
  }

  /** Accepts valid comparisons from the current live character session. Demo and connection errors never enter history. */
  observe(bridge: BridgeStatus | null, error: string | null = null) {
    return this.enqueue(async () => {
      await this.load();
      if (this.blocked) return;
      if (error === null && bridge?.error === null && bridge.status === 'live' && bridge.source === 'screen') {
        const snapshot = safeParse(snapshotSchema, bridge.snapshot);
        if (snapshot.success && snapshot.output.online && Array.isArray(bridge.equipmentComparisons)) {
          for (const candidate of bridge.equipmentComparisons) {
            const record = safeParse(equipmentComparisonSchema, candidate);
            if (
              record.success &&
              record.output.guid === snapshot.output.guid &&
              record.output.session === snapshot.output.session
            )
              this.accept(snapshot.output, record.output);
          }
        }
      }
      await this.save();
    });
  }

  /** Waits for accepted observations and retries the latest unsaved history before exit. */
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

  private async loadFile() {
    try {
      this.history = parse(historySchema, JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      this.blocked = true;
      this.storageError = companionError('comparisons-read', {
        path: this.filePath,
        detail: errorMessageFrom(error) ?? '',
      });
    }
  }

  private accept(snapshot: Snapshot, record: EquipmentComparison) {
    const key = identity(snapshot.account, record);
    if (this.history.seen.includes(key)) return;
    this.history.entries.push({
      account: snapshot.account,
      name: snapshot.name,
      realm: snapshot.realm,
      receivedAt: Date.now(),
      comparison: record,
    });
    this.history.entries = this.history.entries.slice(-10);
    this.history.seen.push(key);
    this.history.seen = this.history.seen.slice(-512);
    this.dirty = true;
  }

  private async save() {
    if (this.blocked || !this.dirty) return;
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const file = await open(temporaryPath, 'wx');
      try {
        await file.writeFile(JSON.stringify(this.history), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      this.dirty = false;
      this.storageError = null;
    } catch (error) {
      this.storageError = companionError('comparisons-write', {
        path: this.filePath,
        detail: errorMessageFrom(error) ?? '',
      });
    } finally {
      // Cleanup cannot replace the write error that explains the unsaved history.
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
