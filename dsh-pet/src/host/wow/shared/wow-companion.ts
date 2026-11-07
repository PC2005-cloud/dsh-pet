import type { InferOutput } from 'valibot';

import type { EquipmentComparisonsState } from './wow-companion-equipment-comparisons';
import type { EquipmentHistoryState } from './wow-companion-equipment-history';
import type { GoldState } from './wow-companion-gold';
import type { LevelHistoryState } from './wow-companion-level-history';
import type { EquipmentLoadoutsState } from './wow-companion-loadout';

import {
  array,
  boolean,
  check,
  finite,
  integer,
  literal,
  looseObject,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  object,
  optional,
  picklist,
  pipe,
  string,
  transform,
} from 'valibot';

import { calendarSchema } from './wow-companion-calendar';
import { equipmentSchema } from './wow-companion-equipment';
import { equipmentComparisonSchema } from './wow-companion-equipment-comparisons';
import { equipmentOfferSchema } from './wow-companion-equipment-offer';
import { equipmentSwapsSchema } from './wow-companion-equipment-swaps';
import { copperSchema, moneyIdSchema } from './wow-companion-gold';
import { groupBuffSchema } from './wow-companion-group-buffs';
import { equipmentLoadoutSchema } from './wow-companion-loadout';

const count = pipe(number(), integer(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER));
const mapCoordinate = pipe(number(), finite(), integer(), minValue(0), maxValue(10000));
const label = pipe(string(), maxLength(256));
const encoder = new TextEncoder();
const raceLabel = pipe(
  string(),
  minLength(1),
  check((value) => encoder.encode(value).length <= 48, 'Race exceeds 48 UTF-8 bytes'),
  check(
    (value) =>
      [...value].every((character) => {
        const point = character.codePointAt(0)!;
        return point >= 32 && (point < 127 || point > 159) && (point < 0xd800 || point > 0xdfff);
      }),
    'Race contains invalid text',
  ),
);

/** A fixed profile selects the local decoder, settings, and ledger. Renderer input cannot select paths or ports. */
export const gameVersionSchema = picklist(['retail', 'forever']);
export type GameVersion = InferOutput<typeof gameVersionSchema>;

export const gameProfiles = {
  retail: {
    port: 18765,
    protocol: 'WCP1',
    captureFile: 'bridge-config.json',
    settingsNamespace: 'wow-companion',
    goldFile: 'wow-companion-gold-v1.json',
    historyFile: 'wow-companion-equipment-history-v1.json',
    levelsFile: 'wow-companion-level-history-v1.json',
    comparisonsFile: 'wow-companion-equipment-comparisons-v1.json',
    loadoutsFile: 'wow-companion-loadouts-v1.json',
  },
  forever: {
    port: 18766,
    protocol: 'WCF1',
    captureFile: 'bridge-config-forever.json',
    settingsNamespace: 'wow-companion-forever',
    goldFile: 'wow-companion-forever-gold-v1.json',
    historyFile: 'wow-companion-forever-equipment-history-v1.json',
    levelsFile: 'wow-companion-forever-level-history-v1.json',
    comparisonsFile: 'wow-companion-forever-equipment-comparisons-v1.json',
    loadoutsFile: 'wow-companion-forever-loadouts-v1.json',
  },
} as const satisfies Record<GameVersion, object>;

const snapshotFieldsSchema = looseObject({
  v: literal(3),
  session: label,
  seq: count,
  tick: count,
  guid: label,
  name: label,
  realm: label,
  level: pipe(count, maxValue(255)),
  class: label,
  faction: nullable(picklist(['Alliance', 'Horde', 'Neutral'])),
  race: nullable(raceLabel),
  spec: count,
  map: count,
  zone: label,
  // Scene observations are optional. Missing values do not identify an outdoor scene.
  instanceType: optional(picklist(['none', 'party', 'raid', 'pvp', 'arena', 'scenario', 'unknown'])),
  instanceID: optional(nullable(pipe(number(), integer(), minValue(1), maxValue(2147483647)))),
  // Snapshot v3 coordinates are additive. Earlier v3 senders omit both fields.
  // The map ID scopes the pair. Each integer is the normalized map fraction multiplied by 10,000.
  px: optional(nullable(mapCoordinate)),
  py: optional(nullable(mapCoordinate)),
  combat: boolean(),
  dead: boolean(),
  online: boolean(),
  account: moneyIdSchema,
  moneyEpoch: moneyIdSchema,
  copper: nullable(copperSchema),
  earned: copperSchema,
  spent: copperSchema,
});

/** Validated observations from the local screen decoder. The outer bridge protocol identifies the game. */
export const snapshotSchema = pipe(
  snapshotFieldsSchema,
  check((snapshot) => {
    const hasX = Object.hasOwn(snapshot, 'px');
    const hasY = Object.hasOwn(snapshot, 'py');
    return (
      (!hasX && !hasY) ||
      (hasX &&
        hasY &&
        ((snapshot.px === null && snapshot.py === null) ||
          (typeof snapshot.px === 'number' && typeof snapshot.py === 'number')))
    );
  }, 'Map coordinates require both values or two nulls.'),
  check(
    (snapshot) =>
      snapshot.instanceID == null ||
      (snapshot.instanceType !== undefined && !['none', 'unknown'].includes(snapshot.instanceType)),
    'Instance IDs require an observed instance type.',
  ),
  transform((snapshot): InferOutput<typeof snapshotFieldsSchema> => ({
    ...snapshot,
    // An absent pair is unknown. Offline observations and unknown maps cannot retain a current position.
    px: snapshot.online && snapshot.map > 0 ? (snapshot.px ?? null) : null,
    py: snapshot.online && snapshot.map > 0 ? (snapshot.py ?? null) : null,
    ...(!snapshot.online && snapshot.instanceType !== undefined ? { instanceType: 'unknown' as const } : {}),
    ...(!snapshot.online && snapshot.instanceID !== undefined ? { instanceID: null } : {}),
  })),
);

export const eventSchema = object({
  id: count,
  type: picklist(['connected', 'level_up', 'zone', 'death', 'revive', 'combat_start', 'combat_end', 'offline']),
  timestamp: string(),
  title: label,
  detail: pipe(string(), maxLength(2048)),
  snapshot: nullable(snapshotSchema),
  demo: boolean(),
});

export const captureSchema = object({
  x: pipe(number(), integer(), minValue(-32768), maxValue(32767)),
  y: pipe(number(), integer(), minValue(-32768), maxValue(32767)),
  cellSize: pipe(number(), integer(), minValue(1), maxValue(12)),
  pollMs: pipe(number(), integer(), minValue(100), maxValue(5000)),
  paused: boolean(),
});

export const bridgeSchema = looseObject({
  // The selected profile also checks these labels when the bridge supplies them.
  game: optional(gameVersionSchema),
  protocol: optional(picklist(['WCP1', 'WCF1'])),
  instanceId: label,
  status: picklist(['live', 'stale', 'waiting', 'demo', 'paused']),
  source: picklist(['screen', 'demo']),
  snapshot: nullable(snapshotSchema),
  lastSeen: nullable(string()),
  ageSeconds: nullable(pipe(number(), finite())),
  calendar: calendarSchema,
  groupBuff: groupBuffSchema,
  eventCursor: count,
  events: pipe(array(eventSchema), maxLength(500)),
  // Published bridges without equipment support remain a supported source of character observations.
  equipment: optional(pipe(array(equipmentSchema), maxLength(10))),
  equipmentError: optional(nullable(pipe(string(), maxLength(2048)))),
  // Published bridges without confirmation results remain supported for their existing observations.
  equipmentSwaps: optional(equipmentSwapsSchema),
  equipmentSwapError: optional(nullable(pipe(string(), maxLength(2048)))),
  // Bridges without offers still provide character observations and equipment history.
  equipmentOffer: optional(nullable(equipmentOfferSchema)),
  equipmentOfferError: optional(nullable(pipe(string(), maxLength(2048)))),
  equipmentComparisons: pipe(array(equipmentComparisonSchema), maxLength(10)),
  equipmentComparisonError: nullable(pipe(string(), maxLength(2048))),
  equipmentLoadout: nullable(equipmentLoadoutSchema),
  equipmentLoadoutError: nullable(pipe(string(), maxLength(2048))),
  config: captureSchema,
  error: nullable(string()),
});

/** Persisted user choices. Demo forwarding is separate from synthetic capture. */
export const settingsSchema = object({
  enabled: boolean(),
  muted: boolean(),
  quietInCombat: boolean(),
  allowDemo: boolean(),
  levelUp: boolean(),
  zone: boolean(),
  death: boolean(),
  revive: boolean(),
  cooldownSeconds: pipe(number(), integer(), minValue(0), maxValue(300)),
});

export type Snapshot = InferOutput<typeof snapshotSchema>;
export type CompanionEvent = InferOutput<typeof eventSchema>;
export type CaptureSettings = InferOutput<typeof captureSchema>;
export type BridgeStatus = InferOutput<typeof bridgeSchema>;
export type CompanionSettings = InferOutput<typeof settingsSchema>;

export const defaultSettings: CompanionSettings = {
  enabled: true,
  muted: false,
  quietInCombat: true,
  allowDemo: false,
  levelUp: true,
  zone: true,
  death: true,
  revive: true,
  cooldownSeconds: 20,
};

/** Main owns this cache. A null bridge or an error means no current game observation. */
export interface CompanionState {
  game: GameVersion;
  settings: CompanionSettings;
  bridge: BridgeStatus | null;
  error: string | null;
  updatedAt: number;
  gold: GoldState;
  equipmentHistory: EquipmentHistoryState;
  levelHistory: LevelHistoryState;
  equipmentComparisons: EquipmentComparisonsState;
  equipmentLoadouts: EquipmentLoadoutsState;
}

export const demoSchema = object({
  enabled: boolean(),
  action: picklist(['none', 'level_up', 'zone', 'death', 'revive', 'combat']),
});

export type DemoRequest = InferOutput<typeof demoSchema>;
