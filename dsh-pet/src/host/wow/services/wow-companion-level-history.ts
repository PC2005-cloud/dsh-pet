import type { InferOutput } from 'valibot';

import type { BridgeStatus, Snapshot } from '../shared/wow-companion';
import type { LevelHistoryRecord, LevelHistoryState } from '../shared/wow-companion-level-history';

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { errorMessageFrom } from './errors';
import {
  array,
  boolean,
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
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
} from 'valibot';

import { snapshotSchema } from '../shared/wow-companion';
import { companionError } from '../shared/wow-companion-errors';
import { moneyIdSchema } from '../shared/wow-companion-gold';

const count = pipe(number(), integer(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER));
/** JavaScript Date and the settings formatter reject later timestamps. */
const maximumTimestamp = 8_640_000_000_000_000;
const timestamp = pipe(count, maxValue(maximumTimestamp));
const level = pipe(number(), integer(), minValue(1), maxValue(255));
const label = pipe(string(), maxLength(256));
const identity = pipe(label, minLength(1));
const recordSchema = strictObject({
  id: pipe(count, minValue(1)),
  fromLevel: nullable(level),
  level,
  recordedAt: timestamp,
  source: picklist(['baseline', 'live', 'gap', 'decrease', 'clock-change']),
  durationMs: nullable(count),
  durationBasis: picklist(['complete', 'partial', 'unknown']),
});
const characterSchema = pipe(
  strictObject({
    account: moneyIdSchema,
    guid: identity,
    name: label,
    realm: label,
    currentLevel: level,
    firstSeen: timestamp,
    lastSeen: timestamp,
    records: pipe(array(recordSchema), minLength(1)),
    session: identity,
    seq: count,
    tick: count,
    retiredSessions: array(identity),
    clockChanged: boolean(),
  }),
  check((character) => {
    const records = character.records;
    return (
      character.firstSeen === records[0]?.recordedAt &&
      character.currentLevel === records.at(-1)?.level &&
      new Set(character.retiredSessions).size === character.retiredSessions.length &&
      !character.retiredSessions.includes(character.session) &&
      records.every((record, index) => {
        const previous = records[index - 1];
        if (record.id !== index + 1 || record.fromLevel !== (previous?.level ?? null)) return false;
        if (!previous)
          return record.source === 'baseline' && record.durationMs === null && record.durationBasis === 'unknown';
        if (record.level === previous.level || record.source === 'baseline') return false;
        if (record.source !== 'clock-change' && record.recordedAt < previous.recordedAt) return false;
        if (record.source === 'live') {
          return (
            record.level === previous.level + 1 &&
            record.recordedAt >= previous.recordedAt &&
            record.durationMs === record.recordedAt - previous.recordedAt &&
            record.durationBasis === (previous.source === 'live' ? 'complete' : 'partial')
          );
        }
        if (record.durationMs !== null || record.durationBasis !== 'unknown') return false;
        if (record.source === 'gap') return record.level > previous.level;
        if (record.source === 'decrease') return record.level < previous.level;
        return true;
      })
    );
  }, 'Invalid saved level history'),
);
const historySchema = pipe(
  strictObject({
    version: literal(1),
    characters: array(characterSchema),
  }),
  check((history) => {
    const keys = history.characters.map((character) => JSON.stringify([character.account, character.guid]));
    return new Set(keys).size === keys.length;
  }, 'Duplicate saved character history'),
);

type SavedHistory = InferOutput<typeof historySchema>;
type SavedCharacter = InferOutput<typeof characterSchema>;

interface Observation {
  account: string;
  guid: string;
  session: string;
  instanceId: string;
  seq: number;
  tick: number;
  receivedAt: number;
}

/**
 * Persists level receipt times per account and character. Real elapsed time includes offline periods and desktop restarts.
 * Saved cursors reject replay. A process-local observation checks continuity and never treats a reconnect as a witnessed upgrade.
 * Atomic writes retain every level record. Invalid files block mutations and remain untouched.
 */
export class CompanionLevelHistory {
  private history: SavedHistory = { version: 1, characters: [] };
  private active: Observation | null = null;
  private storageError: string | null = null;
  private blocked = false;
  private dirty = false;
  private lastSavedAt = 0;
  private loading: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Loads once before observations. A corrupt file remains blocked until the next desktop start. */
  load() {
    this.loading ??= this.loadFile();
    return this.loading;
  }

  /** Returns all saved records in receipt order without exposing mutable storage or replay cursors. */
  read(): LevelHistoryState {
    return {
      characters: this.history.characters.map((character) => ({
        account: character.account,
        guid: character.guid,
        name: character.name,
        realm: character.realm,
        currentLevel: character.currentLevel,
        firstSeen: character.firstSeen,
        lastSeen: character.lastSeen,
        records: structuredClone(character.records),
      })),
      storageError: this.storageError,
    };
  }

  /** Accepts fresh screen observations. Disconnects break continuity, but keep the saved level and its starting time. */
  observe(bridge: BridgeStatus | null, error: string | null = null) {
    const receivedAt = Date.now();
    return this.enqueue(async () => {
      await this.load();
      if (this.blocked) return;
      let changed = false;
      const fresh =
        error === null &&
        bridge?.error === null &&
        bridge.status === 'live' &&
        bridge.source === 'screen' &&
        typeof bridge.ageSeconds === 'number' &&
        bridge.ageSeconds >= 0 &&
        bridge.ageSeconds <= 5 &&
        typeof bridge.instanceId === 'string' &&
        bridge.instanceId.length > 0 &&
        Number.isSafeInteger(receivedAt) &&
        receivedAt >= 0 &&
        receivedAt <= maximumTimestamp;
      const result = fresh ? safeParse(snapshotSchema, bridge.snapshot) : null;
      if (
        bridge &&
        result?.success &&
        result.output.online &&
        result.output.guid &&
        result.output.session &&
        result.output.level >= 1
      )
        changed = this.accept(result.output, bridge.instanceId, receivedAt);
      else this.active = null;
      await this.save(changed || this.storageError !== null);
    });
  }

  /** Writes pending records and observation checkpoints before the profile exits. */
  flush() {
    return this.enqueue(async () => {
      await this.load();
      await this.save(true);
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
      this.lastSavedAt = Date.now();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      this.blocked = true;
      this.storageError = companionError('levels-read', { path: this.filePath, detail: errorMessageFrom(error) ?? '' });
    }
  }

  private accept(snapshot: Snapshot, instanceId: string, now: number) {
    let character = this.history.characters.find(
      (candidate) => candidate.account === snapshot.account && candidate.guid === snapshot.guid,
    );
    if (!character) {
      character = {
        account: snapshot.account,
        guid: snapshot.guid,
        name: snapshot.name,
        realm: snapshot.realm,
        currentLevel: snapshot.level,
        firstSeen: now,
        lastSeen: now,
        records: [
          {
            id: 1,
            fromLevel: null,
            level: snapshot.level,
            recordedAt: now,
            source: 'baseline',
            durationMs: null,
            durationBasis: 'unknown',
          },
        ],
        session: snapshot.session,
        seq: snapshot.seq,
        tick: snapshot.tick,
        retiredSessions: [],
        clockChanged: false,
      };
      this.history.characters.push(character);
      this.activate(snapshot, instanceId, now);
      this.dirty = true;
      return true;
    }

    if (
      character.retiredSessions.includes(snapshot.session) ||
      (character.session === snapshot.session && (snapshot.seq < character.seq || snapshot.tick < character.tick))
    ) {
      return false;
    }

    const clockReversed = now < character.lastSeen;
    if (clockReversed) {
      character.clockChanged = true;
      character.lastSeen = now;
      this.active = null;
      this.dirty = true;
    }
    const repeated =
      character.session === snapshot.session && snapshot.seq === character.seq && snapshot.tick === character.tick;
    if (repeated) {
      // A fresh unchanged level can re-establish a reconnect baseline once. Repeated polls never extend its continuity window.
      if (
        snapshot.level === character.currentLevel &&
        (!this.active || this.active.account !== snapshot.account || this.active.guid !== snapshot.guid)
      )
        this.activate(snapshot, instanceId, now);
      return clockReversed;
    }

    const continuous =
      this.active?.account === snapshot.account &&
      this.active.guid === snapshot.guid &&
      this.active.session === snapshot.session &&
      this.active.instanceId === instanceId &&
      now >= this.active.receivedAt &&
      now - this.active.receivedAt <= 5000 &&
      snapshot.seq >= this.active.seq &&
      snapshot.tick >= this.active.tick;
    const changed = snapshot.level !== character.currentLevel;
    if (changed) this.record(character, snapshot.level, now, continuous);

    const sessionChanged = character.session !== snapshot.session;
    if (sessionChanged) {
      character.retiredSessions.push(character.session);
      character.session = snapshot.session;
    }
    const labelsChanged = character.name !== snapshot.name || character.realm !== snapshot.realm;
    character.name = snapshot.name;
    character.realm = snapshot.realm;
    character.currentLevel = snapshot.level;
    character.lastSeen = now;
    character.seq = snapshot.seq;
    character.tick = snapshot.tick;
    this.activate(snapshot, instanceId, now);
    this.dirty = true;
    return changed || labelsChanged || sessionChanged || clockReversed;
  }

  private activate(snapshot: Snapshot, instanceId: string, receivedAt: number) {
    this.active = {
      account: snapshot.account,
      guid: snapshot.guid,
      session: snapshot.session,
      seq: snapshot.seq,
      tick: snapshot.tick,
      instanceId,
      receivedAt,
    };
  }

  private record(character: SavedCharacter, level: number, now: number, continuous: boolean) {
    const previous = character.records[character.records.length - 1]!;
    let source: LevelHistoryRecord['source'] = 'gap';
    let durationMs: number | null = null;
    let durationBasis: LevelHistoryRecord['durationBasis'] = 'unknown';
    if (character.clockChanged || now < previous.recordedAt) {
      source = 'clock-change';
    } else if (level < character.currentLevel) {
      source = 'decrease';
    } else if (continuous && level === character.currentLevel + 1) {
      source = 'live';
      durationMs = now - previous.recordedAt;
      durationBasis = previous.source === 'live' ? 'complete' : 'partial';
    }
    character.records.push({
      id: previous.id + 1,
      fromLevel: character.currentLevel,
      level,
      recordedAt: now,
      source,
      durationMs,
      durationBasis,
    });
    character.clockChanged = false;
  }

  private async save(force: boolean) {
    // Heartbeat checkpoints need periodic persistence. Level changes and shutdown always write immediately.
    if (this.blocked || !this.dirty || (!force && Date.now() - this.lastSavedAt < 60_000)) return;
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
      this.lastSavedAt = Date.now();
    } catch (error) {
      this.storageError = companionError('levels-write', {
        path: this.filePath,
        detail: errorMessageFrom(error) ?? '',
      });
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
