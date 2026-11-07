import {
  check,
  integer,
  literal,
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
} from 'valibot';

const count = pipe(number(), integer(), minValue(0), maxValue(40));
const sequence = pipe(number(), integer(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER));

/** Addon observations expire in the bridge after six seconds. Missing or restricted data never establishes a missing buff. */
export const groupBuffSchema = optional(
  nullable(
    pipe(
      object({
        v: literal(1),
        kind: literal('buff'),
        s: pipe(string(), minLength(1), maxLength(40)),
        g: pipe(string(), minLength(1), maxLength(48)),
        e: sequence,
        q: pipe(sequence, minValue(1)),
        st: picklist(['inactive', 'waiting', 'ready']),
        spell: picklist([0, 6673, 1459, 21562, 1126, 462854, 364342]),
        name: pipe(
          string(),
          maxLength(96),
          // eslint-disable-next-line no-control-regex -- Reject control codes and game markup in untrusted buff names.
          check((value) => !/[\u0000-\u001F\u007F|]/u.test(value)),
        ),
        missing: count,
        checked: count,
        total: count,
        instanceType: picklist(['unknown', 'party', 'raid', 'pvp', 'scenario']),
        instanceID: pipe(number(), integer(), minValue(0), maxValue(2147483647)),
      }),
      check(
        (value) =>
          value.missing <= value.checked &&
          value.checked <= value.total &&
          Boolean(value.spell) === Boolean(value.name) &&
          (value.st === 'inactive'
            ? value.spell === 0 && value.total === 0 && value.instanceID === 0 && value.instanceType === 'unknown'
            : value.e > 0 && value.instanceID > 0 && value.instanceType !== 'unknown') &&
          (value.st !== 'ready' || (value.spell > 0 && value.missing > 0 && value.total >= 2)),
        'Invalid group buff observation',
      ),
    ),
  ),
);
