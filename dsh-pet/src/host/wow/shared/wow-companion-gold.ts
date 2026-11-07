import type { InferOutput } from 'valibot';

import { integer, maxLength, maxValue, minValue, number, object, pipe, regex, string, trim } from 'valibot';

/** The addon reports exact copper integers. Account totals use decimal strings to preserve larger sums. */
export const copperSchema = pipe(number(), integer(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER));
export const moneyIdSchema = pipe(
  string(),
  regex(/^[\w-]{1,40}$/, 'Money IDs must contain 1 to 40 ASCII letters, digits, underscores, or hyphens'),
);

export const accountNameSchema = object({
  account: moneyIdSchema,
  name: pipe(string(), trim(), maxLength(64)),
});

export type AccountNameRequest = InferOutput<typeof accountNameSchema>;

/** A character balance is the last accepted observation, not an online balance for every character. */
export interface GoldCharacterSummary {
  guid: string;
  name: string;
  realm: string;
  copper: number;
  earned: string;
  spent: string;
  net: string;
  firstSeen: number;
  lastSeen: number;
}

/** All money fields are copper amounts. Totals include the observed characters in one local addon account. */
export interface GoldAccountSummary {
  account: string;
  name: string;
  earned: string;
  spent: string;
  net: string;
  balance: string;
  characterCount: number;
  firstSeen: number;
  lastSeen: number;
  characters: GoldCharacterSummary[];
}

/** Main owns the saved ledger. A storage error identifies totals that cannot currently be saved or loaded. */
export interface GoldState {
  accounts: GoldAccountSummary[];
  storageError: string | null;
}
