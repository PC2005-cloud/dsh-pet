import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gameProfiles } from './shared/wow-companion.ts';
import { CompanionGoldLedger } from './services/wow-companion-gold.ts';
import { CompanionEquipmentHistory } from './services/wow-companion-equipment-history.ts';
import { CompanionLevelHistory } from './services/wow-companion-level-history.ts';
import { CompanionEquipmentComparisons } from './services/wow-companion-equipment-comparisons.ts';
import { CompanionLoadouts } from './services/wow-companion-loadouts.ts';

/** A whitelist, not a directory copy: model credentials, screenshots and pet preferences never cross hosts. */
const entries = Object.values(gameProfiles).flatMap((profile) => [
  { name: profile.goldFile, Store: CompanionGoldLedger },
  { name: profile.historyFile, Store: CompanionEquipmentHistory },
  { name: profile.levelsFile, Store: CompanionLevelHistory },
  { name: profile.comparisonsFile, Store: CompanionEquipmentComparisons },
  { name: profile.loadoutsFile, Store: CompanionLoadouts },
]);

/** Call only after profile pollers have stopped. Validate every candidate before replacing any destination. */
export async function importWowHistory(
  sourceDirectory: string,
  root: string,
): Promise<{ ok: true; imported: string[]; backupDirectory: string | null }> {
  if (!sourceDirectory.trim() || sourceDirectory.length > 32768) throw new Error('wow-import-directory-invalid');
  const source = await realpath(resolve(sourceDirectory));
  await mkdir(root, { recursive: true });
  const target = await realpath(root);
  if (source.toLowerCase() === target.toLowerCase()) throw new Error('wow-import-same-directory');
  const staged: { name: string; bytes: Buffer; temporary: string; existed: boolean; committed: boolean }[] = [];
  const stage = join(root, `.import-${randomUUID()}`);
  await mkdir(stage);
  try {
    for (const entry of entries) {
      const path = join(source, entry.name);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
        throw new Error('wow-import-file-invalid');
      const bytes = await readFile(path);
      if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('wow-import-file-invalid');
      const temporary = join(stage, entry.name);
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      const store = new entry.Store(temporary);
      await store.load();
      if (store.read().storageError) throw new Error('wow-import-history-invalid');
      const destination = join(root, entry.name);
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink()))
        throw new Error('wow-import-destination-invalid');
      staged.push({ name: entry.name, bytes, temporary, existed: Boolean(existing), committed: false });
    }
    if (!staged.length) throw new Error('wow-import-no-history');
    const backupDirectory = join(root, 'import-backups', `${Date.now()}-${randomUUID()}`);
    await mkdir(backupDirectory, { recursive: true });
    for (const file of staged) {
      if (file.existed) await copyFile(join(root, file.name), join(backupDirectory, file.name));
    }
    // Receipts distinguish overwritten files from new files, including when no old history existed.
    await writeFile(
      join(backupDirectory, 'manifest.json'),
      JSON.stringify({ source, files: staged.map(({ name, existed }) => ({ name, existed })) }, null, 2),
    );
    try {
      for (const file of staged) {
        await rename(file.temporary, join(root, file.name));
        file.committed = true;
      }
    } catch (error) {
      // Restore pre-import state on a partial filesystem failure; backups remain available for recovery.
      for (const file of staged.filter((file) => file.committed).reverse()) {
        const destination = join(root, file.name);
        if (file.existed) await copyFile(join(backupDirectory, file.name), destination);
        else await rm(destination, { force: true });
      }
      throw error;
    }
    return { ok: true, imported: staged.map((file) => file.name), backupDirectory };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
