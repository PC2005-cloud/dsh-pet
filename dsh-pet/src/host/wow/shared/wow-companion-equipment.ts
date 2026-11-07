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
  pipe,
  strictObject,
  string,
} from 'valibot';

const encoder = new TextEncoder();
const equipmentId = pipe(number(), integer(), minValue(1), maxValue(2147483647));
const plainText = pipe(
  string(),
  check(
    (value) => [...value].every((character) => character.charCodeAt(0) >= 32),
    'Equipment text contains control characters',
  ),
);
const equipmentLabel = pipe(
  plainText,
  check((value) => encoder.encode(value).length <= 128, 'Equipment text exceeds 128 UTF-8 bytes'),
);
const finiteStat = pipe(number(), finite(), minValue(-1e12), maxValue(1e12));

/** Complete reassembled observations from one character session, never inferred from partial screen frames. */
export const equipmentSchema = pipe(
  strictObject({
    v: literal(1),
    id: equipmentId,
    session: pipe(
      string(),
      minLength(1),
      maxLength(40),
      check((value) => !/[^\w-]/.test(value), 'Invalid equipment session'),
    ),
    guid: pipe(
      string(),
      minLength(1),
      maxLength(48),
      check((value) => !/[^\w-]/.test(value), 'Invalid equipment character'),
    ),
    itemID: equipmentId,
    itemGUID: nullable(equipmentLabel),
    link: pipe(
      plainText,
      check((value) => encoder.encode(value).length <= 1024, 'Equipment link exceeds 1024 UTF-8 bytes'),
    ),
    name: nullable(equipmentLabel),
    type: nullable(equipmentLabel),
    subtype: nullable(equipmentLabel),
    equipLoc: nullable(equipmentLabel),
    quality: nullable(pipe(number(), integer(), minValue(0), maxValue(8))),
    itemLevel: nullable(pipe(number(), finite(), minValue(0), maxValue(100000))),
    requiredLevel: nullable(pipe(number(), integer(), minValue(0), maxValue(255))),
    stats: pipe(
      array(
        strictObject({
          key: pipe(
            plainText,
            minLength(1),
            check((value) => encoder.encode(value).length <= 64, 'Stat key exceeds 64 UTF-8 bytes'),
          ),
          value: finiteStat,
        }),
      ),
      maxLength(32),
      check((values) => new Set(values.map((value) => value.key)).size === values.length, 'Stat keys must be unique'),
    ),
    tooltip: pipe(
      array(
        pipe(
          plainText,
          check((value) => encoder.encode(value).length <= 256, 'Tooltip line exceeds 256 UTF-8 bytes'),
        ),
      ),
      maxLength(48),
    ),
    quantity: pipe(number(), integer(), minValue(1), maxValue(100000)),
    observedAt: pipe(number(), integer(), minValue(0), maxValue(4102444800)),
    source: literal('bag_added'),
    infoComplete: boolean(),
    statsComplete: boolean(),
    tooltipComplete: boolean(),
    truncated: boolean(),
  }),
  check((value) => encoder.encode(JSON.stringify(value)).length <= 8192, 'Equipment record exceeds 8192 UTF-8 bytes'),
);

export type EquipmentRecord = InferOutput<typeof equipmentSchema>;

/** Stable empty collection for sessions without equipment records. */
export const emptyEquipment: readonly EquipmentRecord[] = Object.freeze([]);
