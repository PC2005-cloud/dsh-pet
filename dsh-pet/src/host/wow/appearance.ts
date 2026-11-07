import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { findPetInstance, isValidPetId, readAllConfig, readPetConfigEntry, saveUserConfig } from '../config.ts';
import type { ConfigPaths } from '../config.ts';
import { effectiveUserFile, readJsonc } from '../config/jsonc.ts';

export interface CompanionAppearanceOption {
  id: string;
  name: string;
  entry: string;
  builtin: boolean;
  avatarRoot: string;
  display: string;
}

export interface CompanionAppearanceState {
  selectedPetId: string;
  resolvedPetId: string;
  options: CompanionAppearanceOption[];
  error?: string;
}

export interface CompanionAppearanceSelection extends CompanionAppearanceState {
  changedPetIds: string[];
}

interface FilePlan {
  path: string;
  before?: Buffer;
  after: Buffer;
  temporary: string;
  mode: number;
  committed: boolean;
}

/** Selects already installed pet instances. The renderer continues using its existing animation roots. */
export class WowAppearance {
  private readonly paths: ConfigPaths;
  private operation: Promise<void> = Promise.resolve();

  constructor(paths: ConfigPaths) {
    this.paths = paths;
  }

  /** Empty selection is the first built-in instance, independently of the order of installed custom pets. */
  read(selectedPetId = ''): CompanionAppearanceState {
    try {
      const merged = readAllConfig(this.paths);
      const options = this.options(merged);
      const defaultId = options.find((option) => option.builtin)?.id ?? '';
      const selected = options.find((option) => option.id === selectedPetId);
      const userFile = effectiveUserFile(this.paths);
      const raw = userFile ? readJsonc(userFile) : undefined;
      const malformed = Boolean(userFile && (!raw || Array.isArray(raw)));
      return {
        selectedPetId,
        resolvedPetId: selectedPetId ? (selected?.id ?? defaultId) : defaultId,
        options,
        ...(malformed
          ? { error: 'wow-appearance-config-unreadable' }
          : selectedPetId && !selected
            ? { error: 'wow-appearance-unavailable' }
            : !defaultId
              ? { error: 'wow-appearance-default-unavailable' }
              : {}),
      };
    } catch {
      return { selectedPetId, resolvedPetId: '', options: [], error: 'wow-appearance-config-unreadable' };
    }
  }

  /** Preference persistence is part of the transaction; only run notifications/restarts after this resolves. */
  select(
    next: string,
    previous = '',
    onCommit?: () => unknown | Promise<unknown>,
  ): Promise<CompanionAppearanceSelection> {
    const run = this.operation.then(() => this.perform(next, previous, onCommit));
    this.operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private options(merged: Record<string, Record<string, unknown>>): CompanionAppearanceOption[] {
    const options: CompanionAppearanceOption[] = [];
    const seen = new Set<string>();
    for (const [entry, conf] of Object.entries(merged)) {
      if (!Array.isArray(conf.pets)) continue;
      for (const value of conf.pets) {
        const pet = value as Record<string, unknown>;
        const id = String(pet.id ?? '');
        if (!isValidPetId(id) || seen.has(id)) continue;
        seen.add(id);
        options.push({
          id,
          name: String(pet.name ?? id),
          entry,
          builtin: entry === 'main',
          avatarRoot: entry === 'main' ? '' : entry,
          display: String(pet.display ?? 'none'),
        });
      }
    }
    return options;
  }

  private layer(entry: string): { path: string; raw?: Record<string, unknown> } {
    let path: string;
    if (entry === 'main') path = effectiveUserFile(this.paths) ?? this.paths.userFile;
    else {
      const file = readPetConfigEntry(this.paths, entry);
      if (!file) throw new Error('wow-appearance-unavailable');
      path = file.path;
    }
    if (!existsSync(path)) return { path };
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error('wow-appearance-config-unreadable');
    const raw = readJsonc(path);
    if (!raw || Array.isArray(raw)) throw new Error('wow-appearance-config-unreadable');
    return { path, raw };
  }

  private async perform(
    next: string,
    previous: string,
    onCommit?: () => unknown | Promise<unknown>,
  ): Promise<CompanionAppearanceSelection> {
    if (
      typeof next !== 'string' ||
      typeof previous !== 'string' ||
      (next && !isValidPetId(next)) ||
      (previous && !isValidPetId(previous))
    )
      throw new Error('wow-appearance-invalid-selection');
    const merged = readAllConfig(this.paths);
    const options = this.options(merged);
    const defaultId = options.find((option) => option.builtin)?.id;
    const nextId = next || defaultId;
    const previousId = options.some((option) => option.id === previous) ? previous : defaultId;
    if (!nextId) throw new Error('wow-appearance-default-unavailable');
    const target = findPetInstance(merged, nextId);
    if (!target) throw new Error('wow-appearance-unavailable');
    const old = previousId ? findPetInstance(merged, previousId) : undefined;
    const visible = ['web', 'desktop', 'both'];
    const targetDisplay = visible.includes(String(target.pet.display))
      ? String(target.pet.display)
      : old && visible.includes(String(old.pet.display))
        ? String(old.pet.display)
        : 'desktop';
    const changes = new Map<string, string>();
    if (String(target.pet.display) !== targetDisplay) changes.set(nextId, targetDisplay);
    if (old && previousId !== nextId && old.pet.display !== 'none') changes.set(previousId!, 'none');
    // Even an unchanged selection must not let a corrupted preference layer become silently overwritten later.
    this.layer(target.entry);
    if (old) this.layer(old.entry);
    const entries = new Set([...changes.keys()].map((id) => findPetInstance(merged, id)!.entry));
    const plans: FilePlan[] = [];
    try {
      for (const entry of entries) {
        const layer = this.layer(entry);
        const pets = (merged[entry]!.pets as Record<string, unknown>[]).map((pet) =>
          changes.has(String(pet.id)) ? { ...pet, display: changes.get(String(pet.id)) } : pet,
        );
        const clean = saveUserConfig({ pets }, layer.raw);
        if (!clean) throw new Error('wow-appearance-config-invalid');
        // Preserve every original per-instance field; only display is owned by this operation.
        // The complete merged rows above are validated using the same validator as normal config saves.
        if (layer.raw?.pets !== undefined && !Array.isArray(layer.raw.pets))
          throw new Error('wow-appearance-config-invalid');
        if (Array.isArray(layer.raw?.pets) && layer.raw.pets.length) {
          const seen = new Set<string>();
          clean.pets = layer.raw.pets.map((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('wow-appearance-config-invalid');
            const original = value as Record<string, unknown>;
            const id = typeof original.id === 'string' ? original.id.trim() : '';
            if (!isValidPetId(id) || seen.has(id)) throw new Error('wow-appearance-config-invalid');
            seen.add(id);
            return changes.has(id) ? { ...original, display: changes.get(id) } : original;
          });
          if (pets.some((pet) => !seen.has(String(pet.id)))) throw new Error('wow-appearance-config-invalid');
        }
        const before = existsSync(layer.path) ? readFileSync(layer.path) : undefined;
        const plan: FilePlan = {
          path: layer.path,
          before,
          after: Buffer.from(JSON.stringify(clean, null, 2)),
          temporary: `${layer.path}.appearance-${randomUUID()}.tmp`,
          mode: before ? lstatSync(layer.path).mode & 0o777 : 0o600,
          committed: false,
        };
        plans.push(plan);
        mkdirSync(dirname(plan.path), { recursive: true });
        this.writeTemporary(plan.temporary, plan.after, plan.mode);
      }
      for (const plan of plans) {
        this.assertUnchanged(plan.path, plan.before);
        renameSync(plan.temporary, plan.path);
        plan.committed = true;
      }
      await onCommit?.();
      return { ...this.read(next), changedPetIds: [...changes.keys()] };
    } catch (error) {
      let rollbackFailed = false;
      for (const plan of plans.filter((value) => value.committed).reverse()) {
        try {
          this.assertUnchanged(plan.path, plan.after);
          if (plan.before) {
            this.writeTemporary(plan.temporary, plan.before, plan.mode);
            renameSync(plan.temporary, plan.path);
          } else rmSync(plan.path);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) throw new Error('wow-appearance-rollback-failed', { cause: error });
      if (error instanceof Error && /^wow-[a-z-]+$/.test(error.message)) throw error;
      throw new Error('wow-appearance-save-failed', { cause: error });
    } finally {
      for (const plan of plans) rmSync(plan.temporary, { force: true });
    }
  }

  private assertUnchanged(path: string, expected?: Buffer): void {
    const current = existsSync(path) ? readFileSync(path) : undefined;
    if (expected ? !current?.equals(expected) : current !== undefined) throw new Error('wow-appearance-config-changed');
  }

  private writeTemporary(path: string, bytes: Buffer, mode: number): void {
    const descriptor = openSync(path, 'wx', mode);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
