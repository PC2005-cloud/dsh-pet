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
  regex,
  strictObject,
  string,
} from 'valibot';

const encoder = new TextEncoder();
const count = pipe(number(), integer(), minValue(0), maxValue(4102444800));
const revision = pipe(number(), integer(), minValue(1), maxValue(2147483647));
function text(bytes: number) {
  return pipe(
    string(),
    minLength(1),
    check(
      (value) =>
        encoder.encode(value).length <= bytes &&
        [...value].every((character) => {
          const point = character.codePointAt(0)!;
          return point >= 32 && (point < 127 || point > 159) && (point < 0xd800 || point > 0xdfff);
        }),
      'Invalid loadout text',
    ),
  );
}

const itemSchema = pipe(
  strictObject({
    itemID: revision,
    itemGUID: nullable(text(128)),
    link: text(1024),
    name: nullable(text(128)),
    type: nullable(text(128)),
    subtype: nullable(text(128)),
    equipLoc: nullable(text(128)),
    quality: nullable(pipe(number(), integer(), minValue(0), maxValue(8))),
    itemLevel: nullable(pipe(number(), finite(), minValue(0), maxValue(100000))),
    requiredLevel: nullable(pipe(number(), integer(), minValue(0), maxValue(255))),
    stats: pipe(
      array(strictObject({ key: text(64), value: pipe(number(), finite(), minValue(-1e12), maxValue(1e12)) })),
      maxLength(32),
    ),
    tooltip: pipe(array(text(256)), maxLength(48)),
    infoComplete: boolean(),
    statsComplete: boolean(),
    tooltipComplete: boolean(),
    truncated: boolean(),
  }),
  check(
    (item) =>
      Number(/item:(\d+)/.exec(item.link)?.[1]) === item.itemID &&
      new Set(item.stats.map((stat) => stat.key)).size === item.stats.length &&
      (!item.infoComplete ||
        [item.name, item.type, item.subtype, item.equipLoc, item.quality, item.itemLevel, item.requiredLevel].every(
          (value) => value !== null,
        )) &&
      (!item.tooltipComplete || item.tooltip.length > 0) &&
      (!item.truncated || !item.infoComplete || !item.statsComplete || !item.tooltipComplete) &&
      encoder.encode(JSON.stringify(item)).length <= 8192,
    'Invalid equipped item',
  ),
);

/** A complete slot list from one capture revision. Unknown slots never imply empty slots. */
export const equipmentLoadoutSchema = pipe(
  strictObject({
    v: literal(1),
    id: revision,
    session: pipe(text(40), regex(/^[\w-]+$/)),
    guid: pipe(text(48), regex(/^[\w-]+$/)),
    observedAt: count,
    reason: picklist(['login', 'equipment_acquired', 'equipment_changed', 'refresh']),
    slots: pipe(
      array(
        pipe(
          strictObject({
            slot: pipe(number(), integer(), minValue(1), maxValue(19)),
            state: picklist(['equipped', 'empty', 'unknown']),
            item: nullable(itemSchema),
          }),
          check((value) => (value.state === 'equipped') === (value.item !== null), 'Invalid loadout slot state'),
        ),
      ),
      minLength(19),
      maxLength(19),
    ),
  }),
  check(
    (value) =>
      value.slots.every((slot, index) => slot.slot === index + 1) &&
      encoder.encode(JSON.stringify(value)).length <= 196608,
    'Invalid loadout slots or size',
  ),
);

export type EquipmentLoadout = InferOutput<typeof equipmentLoadoutSchema>;

/** The last saved complete revision for a game profile, local account, and character. */
export interface SavedLoadout {
  account: string;
  name: string;
  realm: string;
  receivedAt: number;
  loadout: EquipmentLoadout;
}

/** Login precedence survives disconnects without turning old equipment into a current observation. */
export interface LoadoutCharacter {
  account: string;
  guid: string;
  session: string;
  name: string;
  realm: string;
  loginObservedAt: number;
}

/** Main owns persisted equipment. Callers receive an immutable cached projection until the next change. */
export interface EquipmentLoadoutsState {
  entries: readonly SavedLoadout[];
  latestCharacter: LoadoutCharacter | null;
  storageError: string | null;
}
