import type { InferOutput } from 'valibot';

import {
  array,
  check,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  picklist,
  pipe,
  strictObject,
  string,
} from 'valibot';

const id = pipe(number(), integer(), minValue(1), maxValue(2147483647));

/** One terminal result from a game confirmation. It does not describe the current equipment layout. */
export const equipmentSwapSchema = pipe(
  strictObject({
    v: literal(1),
    kind: literal('swap'),
    s: pipe(
      string(),
      minLength(1),
      maxLength(40),
      check((value) => !/[^\w-]/.test(value), 'Invalid equipment result session'),
    ),
    g: pipe(
      string(),
      minLength(1),
      maxLength(48),
      check((value) => !/[^\w-]/.test(value), 'Invalid equipment result character'),
    ),
    id,
    e: id,
    st: picklist(['equipped', 'declined', 'failed', 'expired']),
    r: picklist([
      'confirmed',
      'user',
      'timeout',
      'combat',
      'changed',
      'unavailable',
      'locked',
      'cursor',
      'dead',
      'restricted',
      'disabled',
      'left_world',
    ]),
    at: pipe(number(), integer(), minValue(0), maxValue(4102444800)),
    slot: pipe(number(), integer(), minValue(1), maxValue(19)),
    item: id,
    old: pipe(number(), integer(), minValue(0), maxValue(2147483647)),
  }),
  check((result) => {
    switch (result.st) {
      case 'equipped':
        return result.r === 'confirmed';
      case 'declined':
        return result.r === 'user';
      case 'expired':
        return result.r === 'timeout';
      case 'failed':
        return result.r !== 'confirmed' && result.r !== 'user';
    }
  }, 'Equipment result and reason do not match'),
);

export type EquipmentSwap = InferOutput<typeof equipmentSwapSchema>;

/** Result identifiers are unique within one character session, independently from equipment observation identifiers. */
export const equipmentSwapsSchema = pipe(
  array(equipmentSwapSchema),
  maxLength(10),
  check(
    (results) => new Set(results.map((result) => `${result.s}:${result.g}:${result.id}`)).size === results.length,
    'Equipment result identifiers must be unique',
  ),
);

export const emptyEquipmentSwaps: readonly EquipmentSwap[] = Object.freeze([]);
