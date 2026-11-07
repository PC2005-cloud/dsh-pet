import type { InferOutput } from 'valibot';

import {
  array,
  boolean,
  check,
  finite,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  picklist,
  pipe,
  strictObject,
  string,
} from 'valibot';

const encoder = new TextEncoder();
const count = pipe(number(), integer(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER));
const itemId = pipe(number(), integer(), minValue(0), maxValue(2147483647));
function text(bytes: number) {
  return pipe(
    string(),
    check(
      (value) =>
        encoder.encode(value).length <= bytes &&
        [...value].every((character) => {
          const point = character.codePointAt(0)!;
          return point >= 32 && (point < 127 || point > 159) && (point < 0xd800 || point > 0xdfff);
        }),
      'Invalid comparison text',
    ),
  );
}
const identity = pipe(
  text(48),
  minLength(1),
  check((value) => /^[\w-]+$/.test(value), 'Invalid comparison identity'),
);
const statSchema = strictObject({
  key: pipe(text(64), minLength(1)),
  value: pipe(number(), finite(), minValue(-1e12), maxValue(1e12)),
});
const itemSchema = pipe(
  strictObject({
    itemID: itemId,
    name: text(128),
    itemLevel: pipe(number(), finite(), minValue(-1), maxValue(100000)),
    equipLoc: text(128),
    type: text(128),
    subtype: text(128),
    stats: pipe(array(statSchema), maxLength(32)),
    complex: boolean(),
    complete: boolean(),
  }),
  check(
    (item) =>
      new Set(item.stats.map((stat) => stat.key)).size === item.stats.length &&
      (item.itemID === 0 ? item.itemLevel === -1 && item.stats.length === 0 : item.itemLevel >= 0) &&
      (!item.complete ||
        item.itemID === 0 ||
        [item.name, item.equipLoc, item.type, item.subtype].every((value) => value.length > 0)),
    'Invalid comparison item',
  ),
);

/** Captures a candidate and its target slot at acquisition time. It is not a current full equipment inventory. */
export const equipmentComparisonSchema = pipe(
  strictObject({
    v: literal(1),
    id: pipe(itemId, minValue(1)),
    session: pipe(identity, maxLength(40)),
    guid: identity,
    class: pipe(
      text(32),
      check((value) => /^[A-Z_]{1,32}$/.test(value), 'Invalid comparison class'),
    ),
    spec: count,
    primary: picklist([0, 1, 2, 4]),
    observedAt: pipe(count, maxValue(4102444800)),
    slot: pipe(count, maxValue(19)),
    usable: boolean(),
    specMatch: nullable(boolean()),
    current: nullable(itemSchema),
    candidate: itemSchema,
  }),
  check(
    (value) =>
      value.candidate.itemID > 0 && value.candidate.name.length > 0 && (value.slot === 0) === (value.current === null),
    'Invalid comparison slot',
  ),
);

export type EquipmentComparison = InferOutput<typeof equipmentComparisonSchema>;
/** Separates supported numeric improvements, known rejections, and comparisons that require manual review. */
export interface EquipmentAssessment {
  verdict: 'upgrade' | 'not_upgrade' | 'review';
  reason:
    | 'empty_slot'
    | 'stats_upgrade'
    | 'unusable'
    | 'wrong_spec'
    | 'weaker_stats'
    | 'equivalent'
    | 'incomplete'
    | 'unknown_spec'
    | 'weapon_change'
    | 'complex_item'
    | 'stat_tradeoff'
    | 'primary_upgrade_tradeoff'
    | 'no_target';
}

const primaryKeys = {
  1: 'ITEM_MOD_STRENGTH_SHORT',
  2: 'ITEM_MOD_AGILITY_SHORT',
  4: 'ITEM_MOD_INTELLECT_SHORT',
} as const;
const supportedKeys = new Set([
  ...Object.values(primaryKeys),
  'ITEM_MOD_STAMINA_SHORT',
  'ITEM_MOD_CRIT_RATING_SHORT',
  'ITEM_MOD_HASTE_RATING_SHORT',
  'ITEM_MOD_MASTERY_RATING_SHORT',
  'ITEM_MOD_VERSATILITY',
  'ITEM_MOD_DAMAGE_PER_SECOND_SHORT',
  'RESISTANCE0_NAME',
  'ITEM_MOD_ARMOR_SHORT',
  'ITEM_MOD_ATTACK_POWER_SHORT',
  'ITEM_MOD_SPELL_POWER_SHORT',
  'ITEM_MOD_DODGE_RATING_SHORT',
  'ITEM_MOD_PARRY_RATING_SHORT',
  'ITEM_MOD_BLOCK_RATING_SHORT',
  'ITEM_MOD_DEFENSE_SKILL_RATING_SHORT',
  'ITEM_MOD_HIT_RATING_SHORT',
  'ITEM_MOD_EXPERTISE_RATING_SHORT',
  'ITEM_MOD_LIFESTEAL_SHORT',
  'ITEM_MOD_AVOIDANCE_SHORT',
  'ITEM_MOD_SPEED_SHORT',
]);
const primarySet = new Set<string>(Object.values(primaryKeys));
const secondaryKeys = new Set([
  'ITEM_MOD_CRIT_RATING_SHORT',
  'ITEM_MOD_HASTE_RATING_SHORT',
  'ITEM_MOD_MASTERY_RATING_SHORT',
  'ITEM_MOD_VERSATILITY',
  'ITEM_MOD_DODGE_RATING_SHORT',
  'ITEM_MOD_PARRY_RATING_SHORT',
  'ITEM_MOD_BLOCK_RATING_SHORT',
  'ITEM_MOD_DEFENSE_SKILL_RATING_SHORT',
  'ITEM_MOD_HIT_RATING_SHORT',
  'ITEM_MOD_EXPERTISE_RATING_SHORT',
  'ITEM_MOD_LIFESTEAL_SHORT',
  'ITEM_MOD_AVOIDANCE_SHORT',
  'ITEM_MOD_SPEED_SHORT',
]);
const canonicalSlot = (value: string) => (value === 'INVTYPE_ROBE' ? 'INVTYPE_CHEST' : value);

/** Both clients use these conservative rules. A higher item level alone cannot prove a benefit. */
export function assessEquipment(comparison: EquipmentComparison): EquipmentAssessment {
  const { current, candidate } = comparison;
  if (!comparison.usable) return { verdict: 'not_upgrade', reason: 'unusable' };
  if (comparison.specMatch === false) return { verdict: 'not_upgrade', reason: 'wrong_spec' };
  if (!comparison.slot || !current) return { verdict: 'review', reason: 'no_target' };
  if (!candidate.complete || !current.complete) return { verdict: 'review', reason: 'incomplete' };
  if (comparison.specMatch === null || comparison.spec === 0 || comparison.primary === 0)
    return { verdict: 'review', reason: 'unknown_spec' };
  if (
    candidate.complex ||
    current.complex ||
    candidate.equipLoc === 'INVTYPE_TRINKET' ||
    current.equipLoc === 'INVTYPE_TRINKET'
  )
    return { verdict: 'review', reason: 'complex_item' };
  if (current.itemID === 0) return { verdict: 'upgrade', reason: 'empty_slot' };
  if (
    canonicalSlot(candidate.equipLoc) !== canonicalSlot(current.equipLoc) ||
    candidate.type !== current.type ||
    candidate.subtype !== current.subtype
  )
    return { verdict: 'review', reason: 'weapon_change' };
  const selectedPrimary = primaryKeys[comparison.primary];
  const values = new Map<string, [number, number]>();
  for (const [index, item] of [current, candidate].entries()) {
    for (const stat of item.stats) {
      if (!supportedKeys.has(stat.key)) return { verdict: 'review', reason: 'incomplete' };
      if (primarySet.has(stat.key) && stat.key !== selectedPrimary) continue;
      const pair = values.get(stat.key) ?? [0, 0];
      pair[index] = stat.value;
      values.set(stat.key, pair);
    }
  }
  let increased = false;
  let decreased = false;
  let onlySecondaryLosses = true;
  for (const [key, [oldValue, newValue]] of values) {
    increased ||= newValue - oldValue > 1e-6;
    decreased ||= oldValue - newValue > 1e-6;
    if (oldValue - newValue > 1e-6 && !secondaryKeys.has(key)) onlySecondaryLosses = false;
  }
  if (!increased && !decreased) return { verdict: 'not_upgrade', reason: 'equivalent' };
  if (!increased) return { verdict: 'not_upgrade', reason: 'weaker_stats' };
  if (!decreased && candidate.itemLevel >= current.itemLevel) return { verdict: 'upgrade', reason: 'stats_upgrade' };
  const primary = values.get(selectedPrimary);
  if (
    decreased &&
    onlySecondaryLosses &&
    candidate.itemLevel > current.itemLevel &&
    primary &&
    primary[1] - primary[0] > 1e-6
  )
    return { verdict: 'review', reason: 'primary_upgrade_tradeoff' };
  return { verdict: 'review', reason: 'stat_tradeoff' };
}

/** Each fixed game profile retains ten acquisition comparisons independently of its existing item history. */
export interface EquipmentComparisonsState {
  entries: { account: string; name: string; realm: string; receivedAt: number; comparison: EquipmentComparison }[];
  storageError: string | null;
}
