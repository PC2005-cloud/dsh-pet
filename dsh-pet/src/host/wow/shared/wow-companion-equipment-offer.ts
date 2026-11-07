import type { InferOutput } from 'valibot';

import {
  check,
  finite,
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

const encoder = new TextEncoder();
const id = pipe(number(), integer(), minValue(1), maxValue(2147483647));

/** A current game confirmation, ordered by q within one character session. It grants no desktop control of the game. */
export const equipmentOfferSchema = pipe(
  strictObject({
    v: literal(1),
    kind: literal('offer'),
    s: pipe(
      string(),
      minLength(1),
      maxLength(40),
      check((value) => !/[^\w-]/.test(value), 'Invalid offer session'),
    ),
    g: pipe(
      string(),
      minLength(1),
      maxLength(48),
      check((value) => !/[^\w-]/.test(value), 'Invalid offer character'),
    ),
    id,
    q: id,
    st: picklist(['ready', 'closed']),
    slot: pipe(number(), integer(), minValue(1), maxValue(19)),
    item: id,
    n: pipe(
      string(),
      minLength(1),
      check(
        (value) =>
          encoder.encode(value).length <= 96 &&
          [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
        'Invalid offer item name',
      ),
    ),
    il: pipe(number(), finite(), minValue(0), maxValue(100000)),
    old: pipe(number(), integer(), minValue(0), maxValue(2147483647)),
    ol: pipe(number(), finite(), minValue(-1), maxValue(100000)),
    until: pipe(number(), integer(), minValue(1), maxValue(4102444800)),
  }),
  check(
    (value) => value.il >= value.ol && (value.old === 0 ? value.ol === -1 : value.ol >= 0),
    'Offer is not an item-level upgrade',
  ),
);

export type EquipmentOffer = InferOutput<typeof equipmentOfferSchema>;
