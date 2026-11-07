import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** User configuration is committed before replacing the in-memory value. Invalid files are preserved. */
export class WowJsonSettings<T> {
  private value: T;
  private blocked = false;
  private readonly file: string;
  private readonly validate: (input: unknown) => T;

  constructor(file: string, defaults: T, validate: (input: unknown) => T) {
    this.file = file;
    this.validate = validate;
    this.value = structuredClone(defaults);
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file);
        if (raw.byteLength > 1024 * 1024) throw new Error('settings-too-large');
        this.value = validate(JSON.parse(raw.toString('utf8')));
      } catch {
        this.blocked = true;
      }
    }
  }

  read(): T {
    return structuredClone(this.value);
  }
  get error(): string | null {
    return this.blocked ? 'wow-settings-unreadable' : null;
  }

  save(input: unknown): T {
    if (this.blocked) throw new Error('wow-settings-unreadable');
    const next = this.validate(input);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
      this.value = next;
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.read();
  }
}
