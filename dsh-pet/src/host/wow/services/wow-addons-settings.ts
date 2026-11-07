import type { AddonGame, AddonSettings, AddonSettingsUpdate, InstalledAddon } from '../shared/wow-addons';

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  array,
  boolean,
  integer,
  literal,
  maxLength,
  maxValue,
  minValue,
  nullable,
  number,
  object,
  optional,
  parse,
  picklist,
  pipe,
  string,
} from 'valibot';

export const addonGameSchema = picklist(['retail', 'classic', 'forever']);
export const addonIdSchema = pipe(number(), integer(), minValue(1), maxValue(2147483647));
const directorySchema = pipe(string(), maxLength(32768));
const clientSchema = object({ directory: directorySchema, gameVersionTypeId: nullable(addonIdSchema) });
const clientsSchema = object({ retail: clientSchema, classic: clientSchema, forever: clientSchema });

export const addonSettingsUpdateSchema = object({
  apiKey: optional(pipe(string(), maxLength(4096))),
  clearApiKey: optional(boolean()),
  clients: clientsSchema,
});

const installedSchema = object({
  game: addonGameSchema,
  clientDirectory: directorySchema,
  modId: addonIdSchema,
  fileId: addonIdSchema,
  name: pipe(string(), maxLength(512)),
  version: pipe(string(), maxLength(512)),
  gameVersionTypeId: addonIdSchema,
  folders: pipe(array(pipe(string(), maxLength(256))), maxLength(128)),
  installedAt: pipe(string(), maxLength(64)),
  backupPath: optional(directorySchema),
});

const storedSchema = object({
  version: literal(1),
  apiKeyCipher: nullable(pipe(string(), maxLength(16384))),
  clients: clientsSchema,
  installed: pipe(array(installedSchema), maxLength(5000)),
});

export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Owns encrypted credentials and installation receipts outside the game directories. Writes commit before in-memory state changes. */
export class WowAddonSettings {
  private stored = parse(storedSchema, {
    version: 1,
    apiKeyCipher: null,
    clients: {
      retail: { directory: '', gameVersionTypeId: null },
      classic: { directory: '', gameVersionTypeId: null },
      forever: { directory: '', gameVersionTypeId: null },
    },
    installed: [],
  });

  private loadError = false;

  private readonly filePath: string;
  private readonly secrets: SecretStorage;

  constructor(filePath: string, secrets: SecretStorage) {
    this.filePath = filePath;
    this.secrets = secrets;
    if (!existsSync(filePath)) return;
    try {
      if (readFileSync(filePath).byteLength > 4 * 1024 * 1024) throw new Error('wow-addons-settings-invalid');
      this.stored = parse(storedSchema, JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      // Preserve invalid settings on disk. A fresh default must never overwrite an unreadable key or ownership record.
      this.loadError = true;
    }
  }

  read(): AddonSettings {
    this.assertReadable();
    return { hasApiKey: Boolean(this.stored.apiKeyCipher), clients: structuredClone(this.stored.clients) };
  }

  apiKey(): string {
    this.assertReadable();
    if (!this.stored.apiKeyCipher) throw new Error('curseforge-api-key-required');
    try {
      return this.secrets.decryptString(Buffer.from(this.stored.apiKeyCipher, 'base64'));
    } catch {
      throw new Error('wow-addons-key-unreadable');
    }
  }

  save(input: AddonSettingsUpdate): AddonSettings {
    this.assertReadable();
    const update = parse(addonSettingsUpdateSchema, input);
    const key = update.apiKey?.trim();
    let cipher = this.stored.apiKeyCipher;
    if (update.clearApiKey) cipher = null;
    if (key) {
      if (!this.secrets.isEncryptionAvailable()) throw new Error('wow-addons-key-storage-unavailable');
      cipher = this.secrets.encryptString(key).toString('base64');
    }
    this.commit({ ...this.stored, apiKeyCipher: cipher, clients: update.clients });
    return this.read();
  }

  installed(game: AddonGame): InstalledAddon[] {
    this.assertReadable();
    // Receipts identify the canonical directory as well as the game. Moving a configured path never grants ownership of another installation.
    return structuredClone(this.stored.installed.filter((record) => record.game === game));
  }

  recordInstallation(record: InstalledAddon): void {
    this.assertReadable();
    const next = parse(installedSchema, record);
    const remaining = this.stored.installed.filter(
      (item) => item.game !== next.game || item.clientDirectory !== next.clientDirectory || item.modId !== next.modId,
    );
    this.commit({ ...this.stored, installed: [...remaining, next] });
  }

  private assertReadable(): void {
    if (this.loadError) throw new Error('wow-addons-settings-invalid');
  }

  private commit(next: typeof this.stored): void {
    const parsed = parse(storedSchema, next);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600 });
      renameSync(temporary, this.filePath);
      this.stored = parsed;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
