import type { InferOutput } from 'valibot';

import type { BridgeStatus } from '../shared/wow-companion';
import type { AccountNameRequest, GoldAccountSummary, GoldState } from '../shared/wow-companion-gold';

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { errorMessageFrom } from './errors';
import { array, check, literal, maxLength, minLength, object, parse, pipe, regex, safeParse, string } from 'valibot';

import { snapshotSchema } from '../shared/wow-companion';
import { companionError } from '../shared/wow-companion-errors';
import { accountNameSchema, copperSchema, moneyIdSchema } from '../shared/wow-companion-gold';

const labelSchema = pipe(string(), maxLength(256));
const totalSchema = pipe(string(), regex(/^(?:0|[1-9]\d*)$/));
const characterSchema = pipe(
  object({
    guid: pipe(labelSchema, minLength(1)),
    name: labelSchema,
    realm: labelSchema,
    copper: copperSchema,
    earned: totalSchema,
    spent: totalSchema,
    epoch: moneyIdSchema,
    counterEarned: copperSchema,
    counterSpent: copperSchema,
    retiredEpochs: array(moneyIdSchema),
    session: labelSchema,
    seq: copperSchema,
    tick: copperSchema,
    firstSeen: copperSchema,
    lastSeen: copperSchema,
  }),
  check(
    (character) =>
      BigInt(character.earned) >= BigInt(character.counterEarned) &&
      BigInt(character.spent) >= BigInt(character.counterSpent) &&
      character.lastSeen >= character.firstSeen &&
      !character.retiredEpochs.includes(character.epoch) &&
      new Set(character.retiredEpochs).size === character.retiredEpochs.length,
    'Invalid saved character ledger',
  ),
);
const accountSchema = pipe(
  object({
    account: moneyIdSchema,
    name: accountNameSchema.entries.name,
    characters: pipe(array(characterSchema), minLength(1)),
  }),
  check(
    (account) => new Set(account.characters.map((character) => character.guid)).size === account.characters.length,
    'Duplicate saved character',
  ),
);
const ledgerSchema = pipe(
  object({
    version: literal(1),
    accounts: array(accountSchema),
  }),
  check(
    (ledger) => new Set(ledger.accounts.map((account) => account.account)).size === ledger.accounts.length,
    'Duplicate saved account',
  ),
);

type Ledger = InferOutput<typeof ledgerSchema>;

/**
 * Saves cumulative addon counters without counting repeated frames as new money.
 * Corrupt files remain untouched. Failed writes stay visible and are retried.
 */
export class CompanionGoldLedger {
  private ledger: Ledger = { version: 1, accounts: [] };
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

  /** Loads once before accepting observations or account names. */
  load() {
    this.loading ??= this.loadFile();
    return this.loading;
  }

  /** Returns exact copper totals and the last known balance of each observed character. */
  read(): GoldState {
    const accounts: GoldAccountSummary[] = this.ledger.accounts.map((account) => {
      const characters = account.characters.map((character) => ({
        guid: character.guid,
        name: character.name,
        realm: character.realm,
        copper: character.copper,
        earned: character.earned,
        spent: character.spent,
        net: (BigInt(character.earned) - BigInt(character.spent)).toString(),
        firstSeen: character.firstSeen,
        lastSeen: character.lastSeen,
      }));
      let earned = 0n;
      let spent = 0n;
      let balance = 0n;
      let firstSeen = Number.MAX_SAFE_INTEGER;
      let lastSeen = 0;
      for (const character of characters) {
        earned += BigInt(character.earned);
        spent += BigInt(character.spent);
        balance += BigInt(character.copper);
        firstSeen = Math.min(firstSeen, character.firstSeen);
        lastSeen = Math.max(lastSeen, character.lastSeen);
      }
      return {
        account: account.account,
        name: account.name,
        earned: earned.toString(),
        spent: spent.toString(),
        net: (earned - spent).toString(),
        balance: balance.toString(),
        characterCount: characters.length,
        firstSeen,
        lastSeen,
        characters,
      };
    });
    return { accounts, storageError: this.storageError };
  }

  /** Ignores demo, stale, offline, invalid, and failed bridge observations. */
  observe(bridge: BridgeStatus | null, error: string | null = null) {
    return this.enqueue(async () => {
      await this.load();
      if (this.blocked) return;
      let changed = false;
      if (error === null && bridge?.error === null && bridge.status === 'live' && bridge.source === 'screen') {
        const result = safeParse(snapshotSchema, bridge.snapshot);
        if (result.success && result.output.online && result.output.copper !== null && result.output.guid)
          changed = this.accept(result.output, result.output.copper);
      }
      await this.save(changed || this.storageError !== null);
    });
  }

  /** Empty names restore the account ID label. Invalid or unknown accounts are rejected. */
  setAccountName(input: AccountNameRequest) {
    const request = parse(accountNameSchema, input);
    return this.enqueue(async () => {
      await this.load();
      if (this.blocked) return;
      const account = this.ledger.accounts.find((account) => account.account === request.account);
      if (!account) throw new Error(companionError('gold-account-unknown'));
      account.name = request.name;
      this.dirty = true;
      await this.save(true);
    });
  }

  /** Waits for pending mutations and writes the latest observation times before exit. */
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
      this.ledger = parse(ledgerSchema, JSON.parse(await readFile(this.filePath, 'utf8')));
      this.lastSavedAt = Date.now();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      this.blocked = true;
      this.storageError = companionError('gold-read', { path: this.filePath, detail: errorMessageFrom(error) ?? '' });
    }
  }

  private accept(snapshot: InferOutput<typeof snapshotSchema>, copper: number) {
    const now = Date.now();
    let account = this.ledger.accounts.find((account) => account.account === snapshot.account);
    if (!account) {
      account = { account: snapshot.account, name: '', characters: [] };
      this.ledger.accounts.push(account);
    }
    const character = account.characters.find((character) => character.guid === snapshot.guid);
    if (!character) {
      account.characters.push({
        guid: snapshot.guid,
        name: snapshot.name,
        realm: snapshot.realm,
        copper,
        earned: String(snapshot.earned),
        spent: String(snapshot.spent),
        epoch: snapshot.moneyEpoch,
        counterEarned: snapshot.earned,
        counterSpent: snapshot.spent,
        retiredEpochs: [],
        session: snapshot.session,
        seq: snapshot.seq,
        tick: snapshot.tick,
        firstSeen: now,
        lastSeen: now,
      });
      this.dirty = true;
      return true;
    }

    if (character.retiredEpochs.includes(snapshot.moneyEpoch)) return false;
    if (character.session === snapshot.session && (snapshot.seq < character.seq || snapshot.tick < character.tick))
      return false;
    if (
      character.epoch === snapshot.moneyEpoch &&
      (snapshot.earned < character.counterEarned || snapshot.spent < character.counterSpent)
    )
      return false;

    const newEpoch = character.epoch !== snapshot.moneyEpoch;
    const earned = snapshot.earned - (newEpoch ? 0 : character.counterEarned);
    const spent = snapshot.spent - (newEpoch ? 0 : character.counterSpent);
    const changed =
      newEpoch ||
      earned > 0 ||
      spent > 0 ||
      character.copper !== copper ||
      character.name !== snapshot.name ||
      character.realm !== snapshot.realm ||
      character.session !== snapshot.session;
    if (newEpoch) {
      character.retiredEpochs.push(character.epoch);
      character.epoch = snapshot.moneyEpoch;
    }
    character.earned = (BigInt(character.earned) + BigInt(earned)).toString();
    character.spent = (BigInt(character.spent) + BigInt(spent)).toString();
    character.counterEarned = snapshot.earned;
    character.counterSpent = snapshot.spent;
    character.copper = copper;
    character.name = snapshot.name;
    character.realm = snapshot.realm;
    character.session = snapshot.session;
    character.seq = snapshot.seq;
    character.tick = snapshot.tick;
    character.lastSeen = Math.max(now, character.lastSeen);
    this.dirty = true;
    return changed;
  }

  private async save(force: boolean) {
    if (this.blocked || !this.dirty || (!force && Date.now() - this.lastSavedAt < 60_000)) return;
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const file = await open(temporaryPath, 'wx');
      try {
        await file.writeFile(JSON.stringify(this.ledger), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      this.dirty = false;
      this.lastSavedAt = Date.now();
      this.storageError = null;
    } catch (error) {
      this.storageError = companionError('gold-write', { path: this.filePath, detail: errorMessageFrom(error) ?? '' });
    } finally {
      // The original write error remains visible if temporary-file cleanup also fails.
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
