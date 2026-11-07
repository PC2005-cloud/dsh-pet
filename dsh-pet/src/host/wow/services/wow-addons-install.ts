import type { Entry, ZipFile } from 'yauzl';

import type { AddonGame, InstalledAddon } from '../shared/wow-addons';

import { Buffer } from 'node:buffer';
import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { crc32 } from 'node:zlib';

import { fromBufferPromise } from 'yauzl';

type InstallationDetails = Omit<InstalledAddon, 'folders' | 'installedAt' | 'backupPath' | 'clientDirectory'>;
type InstallError =
  | 'wow-addons-invalid-directory'
  | 'wow-addons-invalid-archive'
  | 'wow-addons-folder-conflict'
  | 'wow-addons-install-failed';

interface ArchiveFile {
  entry: Entry;
  segments: string[];
}

interface Destination {
  folder: string;
  existing: string | undefined;
}

function failure(code: InstallError, cause?: unknown) {
  return new Error(code, { cause });
}

function pathKey(path: string) {
  return resolve(path).normalize('NFC').toLowerCase();
}

function folderKey(folder: string) {
  return folder.normalize('NFC').toLowerCase();
}

function inside(parent: string, child: string) {
  const difference = relative(pathKey(parent), pathKey(child));
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`));
}

async function existingStats(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafeParents(path: string) {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = await existingStats(current);
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('wow-addons-invalid-directory');
    if (pathKey(await realpath(current)) !== pathKey(current)) throw failure('wow-addons-invalid-directory');
  }
}

function directoryGame(name: string): AddonGame | undefined {
  if (/^_forever(?:_[a-z0-9]+)*_$|^_camelot_$/i.test(name)) return 'forever';
  if (/^_classic(?:_[a-z0-9]+)*_$|^_anniversary_$/i.test(name)) return 'classic';
  if (/^_retail(?:_[a-z0-9]+)*_$/i.test(name)) return 'retail';
}

/**
 * Accepts an actual Windows client directory, with a regular WoW executable.
 * Known flavor directories must match the selected game. Missing Interface and AddOns directories are allowed.
 * Existing symbolic links and junctions in the destination path are rejected.
 */
export async function validateClientDirectory(directory: string, game: AddonGame): Promise<string> {
  try {
    if (!directory.trim() || !isAbsolute(directory)) throw failure('wow-addons-invalid-directory');
    const clientDirectory = resolve(directory);
    await assertSafeParents(clientDirectory);
    const stat = await lstat(clientDirectory);
    if (!stat.isDirectory()) throw failure('wow-addons-invalid-directory');
    const flavor = directoryGame(basename(clientDirectory));
    if (flavor && flavor !== game) throw failure('wow-addons-invalid-directory');
    const executables = (await readdir(clientDirectory)).filter((name) => /^wow[^\\/]*\.exe$/i.test(name));
    let hasExecutable = false;
    for (const name of executables) {
      const executable = await lstat(join(clientDirectory, name));
      if (executable.isFile() && !executable.isSymbolicLink()) hasExecutable = true;
    }
    if (!hasExecutable) throw failure('wow-addons-invalid-directory');
    await assertSafeParents(join(clientDirectory, 'Interface', 'AddOns'));
    return await realpath(clientDirectory);
  } catch (error) {
    throw failure('wow-addons-invalid-directory', error);
  }
}

function archiveSegments(name: string) {
  const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  if (name.length > 2048 || segments.length > 32) throw failure('wow-addons-invalid-archive');
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.length > 255 ||
      // eslint-disable-next-line no-control-regex -- Windows archive names must reject control characters.
      /[<>:"|?*\\\u0000-\u001F\u007F]/.test(segment) ||
      /[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment) ||
      /~\d/.test(segment)
    ) {
      throw failure('wow-addons-invalid-archive');
    }
  }
  return segments;
}

function assertDataFile(entry: Entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  const directory = entry.fileName.endsWith('/');
  // ZIP permissions can describe links, devices, or sockets. Only data files and directories enter the game.
  if (
    (mode && mode !== 0o100000 && mode !== 0o040000) ||
    (mode === 0o040000 && !directory) ||
    (mode === 0o100000 && directory) ||
    (!directory && (entry.externalFileAttributes & 0x10) !== 0) ||
    (entry.externalFileAttributes & 0x400) !== 0 ||
    entry.isEncrypted() ||
    ![0, 8].includes(entry.compressionMethod) ||
    (directory && entry.uncompressedSize !== 0) ||
    /\.(?:exe|dll|com|bat|cmd|msi|msp|scr|cpl|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|lnk|url|so|dylib)$/i.test(
      entry.fileName,
    )
  ) {
    throw failure('wow-addons-invalid-archive');
  }
}

async function readArchive(bytes: Buffer) {
  const zip = await fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
  const files: ArchiveFile[] = [];
  const paths = new Map<string, { spelling: string; directory: boolean; explicit: boolean }>();
  let totalSize = 0;
  try {
    if (zip.entryCount > 20_000) throw failure('wow-addons-invalid-archive');
    for await (const entry of zip.eachEntry()) {
      assertDataFile(entry);
      const segments = archiveSegments(entry.fileName);
      totalSize += entry.uncompressedSize;
      if (!Number.isSafeInteger(totalSize) || totalSize > 300 * 1024 * 1024)
        throw failure('wow-addons-invalid-archive');
      for (let index = 0; index < segments.length; index++) {
        const spelling = segments.slice(0, index + 1).join('/');
        const key = spelling.normalize('NFC').toLowerCase();
        const directory = index < segments.length - 1 || entry.fileName.endsWith('/');
        const explicit = index === segments.length - 1;
        const previous = paths.get(key);
        if (
          previous &&
          (previous.spelling !== spelling || previous.directory !== directory || (explicit && previous.explicit))
        )
          throw failure('wow-addons-invalid-archive');
        paths.set(key, { spelling, directory, explicit: explicit || previous?.explicit === true });
      }
      if (!entry.fileName.endsWith('/')) files.push({ entry, segments });
    }
    if (!files.length) throw failure('wow-addons-invalid-archive');
    return { zip, files };
  } catch (error) {
    zip.close();
    throw error;
  }
}

function addonLayout(files: ArchiveFile[]) {
  const prefixes: string[][] = [[]];
  const topLevels = new Set(files.map((file) => file.segments[0]));
  if (topLevels.size === 1) prefixes.push([files[0].segments[0]]);
  for (const wrapper of [...prefixes]) prefixes.push([...wrapper, 'Interface', 'AddOns']);

  for (const prefix of prefixes) {
    if (
      !files.every((file) =>
        prefix.every((segment, index) => file.segments[index]?.toLowerCase() === segment.toLowerCase()),
      )
    )
      continue;
    const normalized = files.map((file) => ({ ...file, segments: file.segments.slice(prefix.length) }));
    if (normalized.some((file) => file.segments.length < 2)) continue;
    const folders = [...new Set(normalized.map((file) => file.segments[0]))];
    const tocFolders = new Set(
      normalized
        .filter((file) => file.segments.length === 2 && /\.toc$/i.test(file.segments[1]))
        .map((file) => file.segments[0]),
    );
    if (folders.every((folder) => tocFolders.has(folder))) return { files: normalized, folders };
  }
  throw failure('wow-addons-invalid-archive');
}

// Wait for the file descriptor to close before a staged directory can be renamed on Windows.
async function writeArchiveEntry(source: Readable, validate: Transform, path: string) {
  const output = createWriteStream(path, { flags: 'wx', mode: 0o644 });
  await new Promise<void>((resolve, reject) => {
    let error: Error | undefined;
    const fail = (cause: Error) => {
      error ??= cause;
      source.destroy();
      validate.destroy();
      output.destroy();
    };
    const sourceClosed = () => {
      if (!source.readableEnded) fail(failure('wow-addons-invalid-archive'));
    };
    source.once('error', fail);
    source.once('close', sourceClosed);
    validate.once('error', fail);
    output.once('error', fail);
    output.once('close', () => {
      source.removeListener('error', fail);
      source.removeListener('close', sourceClosed);
      validate.removeListener('error', fail);
      output.removeListener('error', fail);
      if (error || !output.writableFinished) reject(error ?? failure('wow-addons-invalid-archive'));
      else resolve();
    });
    source.pipe(validate).pipe(output);
  });
}

async function extractArchive(zip: ZipFile, files: ArchiveFile[], destination: string) {
  let extractedSize = 0;
  for (const file of files) {
    const path = join(destination, ...file.segments);
    if (!inside(destination, path)) throw failure('wow-addons-invalid-archive');
    await mkdir(dirname(path), { recursive: true });
    const source = await zip.openReadStreamPromise(file.entry);
    let checksum = 0;
    let size = 0;
    let signature = Buffer.alloc(0);
    const validate = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        extractedSize += chunk.length;
        if (size > file.entry.uncompressedSize || extractedSize > 300 * 1024 * 1024) {
          callback(failure('wow-addons-invalid-archive'));
          return;
        }
        if (signature.length < 4) signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
        if (
          signature.subarray(0, 2).equals(Buffer.from('MZ')) ||
          signature.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
          (signature.length === 4 &&
            [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(signature.readUInt32BE()))
        ) {
          callback(failure('wow-addons-invalid-archive'));
          return;
        }
        checksum = crc32(chunk, checksum);
        callback(null, chunk);
      },
    });
    await writeArchiveEntry(source, validate, path);
    if (size !== file.entry.uncompressedSize || checksum !== file.entry.crc32)
      throw failure('wow-addons-invalid-archive');
  }
}

async function assertSafeTree(directory: string) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw failure('wow-addons-folder-conflict');
    if (stat.isDirectory()) {
      for (const name of await readdir(current)) pending.push(join(current, name));
    }
  }
}

async function destinationsFor(
  client: string,
  addonDirectory: string,
  folders: string[],
  details: InstallationDetails,
  previous: InstalledAddon[],
) {
  const records = previous.filter((record) => pathKey(record.clientDirectory) === pathKey(client));
  const owned = new Map<string, { modId: number; game: AddonGame }>();
  const affected = new Map(folders.map((folder) => [folderKey(folder), folder]));
  for (const record of records) {
    for (const folder of record.folders) {
      if (archiveSegments(folder).length !== 1 || folder.endsWith('/')) throw failure('wow-addons-folder-conflict');
      const key = folderKey(folder);
      const owner = owned.get(key);
      if (owner && (owner.modId !== record.modId || owner.game !== record.game))
        throw failure('wow-addons-folder-conflict');
      owned.set(key, { modId: record.modId, game: record.game });
      if (record.modId === details.modId && record.game === details.game && !affected.has(key))
        affected.set(key, folder);
    }
  }
  const existing = new Map<string, string>();
  for (const name of await readdir(addonDirectory)) {
    const key = folderKey(name);
    if (existing.has(key)) throw failure('wow-addons-folder-conflict');
    existing.set(key, name);
  }
  const destinations: Destination[] = [];
  for (const [key, folder] of affected) {
    const owner = owned.get(key);
    const current = existing.get(key);
    const ownedByProject = owner?.modId === details.modId && owner.game === details.game;
    if ((owner && !ownedByProject) || (current && !ownedByProject)) throw failure('wow-addons-folder-conflict');
    if (current) {
      const directory = join(addonDirectory, current);
      if (!(await lstat(directory)).isDirectory()) throw failure('wow-addons-folder-conflict');
      await assertSafeTree(directory);
    }
    destinations.push({ folder, existing: current });
  }
  return destinations;
}

/**
 * Installs verified catalog bytes into one configured client. The caller owns catalog authentication and record persistence.
 * Each archive contains TOC-bearing addon directories, optionally inside Interface/AddOns or one wrapper directory.
 * Replacements require matching persisted ownership. Backups remain outside the client, including after a failed commit.
 */
export class WowAddonInstaller {
  private installing = false;

  private readonly backupDirectory: string;

  constructor(backupDirectory: string) {
    this.backupDirectory = backupDirectory;
  }

  /**
   * Stages complete, CRC-checked files before replacing owned addon directories.
   * If a rename or onCommit fails, restores all previous directories before rejecting.
   * The onCommit callback must persist atomically, with no record change on rejection.
   */
  async installArchive(
    clientDirectory: string,
    bytes: Buffer,
    details: InstallationDetails,
    previous: InstalledAddon[],
    onCommit?: (record: InstalledAddon) => void | Promise<void>,
  ): Promise<InstalledAddon> {
    if (this.installing) throw failure('wow-addons-install-failed');
    this.installing = true;
    try {
      return await this.install(clientDirectory, bytes, details, previous, onCommit);
    } finally {
      this.installing = false;
    }
  }

  private async install(
    directory: string,
    bytes: Buffer,
    details: InstallationDetails,
    previous: InstalledAddon[],
    onCommit?: (record: InstalledAddon) => void | Promise<void>,
  ) {
    const client = await validateClientDirectory(directory, details.game);
    if (bytes.length > 100 * 1024 * 1024) throw failure('wow-addons-invalid-archive');
    const backupDirectory = resolve(this.backupDirectory);
    if (!isAbsolute(this.backupDirectory) || inside(client, backupDirectory))
      throw failure('wow-addons-invalid-directory');

    let archive: Awaited<ReturnType<typeof readArchive>> | undefined;
    let layout: ReturnType<typeof addonLayout>;
    try {
      archive = await readArchive(bytes);
      layout = addonLayout(archive.files);
    } catch (error) {
      archive?.zip.close();
      throw failure('wow-addons-invalid-archive', error);
    }

    const addonDirectory = join(client, 'Interface', 'AddOns');
    let staging: string | undefined;
    let preserveStaging = false;
    const replaced: Destination[] = [];
    const installed: string[] = [];
    try {
      await assertSafeParents(addonDirectory);
      await mkdir(addonDirectory, { recursive: true });
      staging = await mkdtemp(join(client, 'Interface', '.airi-addons-'));
      const next = join(staging, 'next');
      await mkdir(next);
      try {
        await extractArchive(archive.zip, layout.files, next);
      } catch (error) {
        throw failure('wow-addons-invalid-archive', error);
      }
      const destinations = await destinationsFor(client, addonDirectory, layout.folders, details, previous);
      let backupPath: string | undefined;
      if (destinations.some((destination) => destination.existing)) {
        await assertSafeParents(backupDirectory);
        await mkdir(backupDirectory, { recursive: true });
        await assertSafeParents(backupDirectory);
        backupPath = await mkdtemp(join(backupDirectory, `${details.modId}-`));
        for (const destination of destinations) {
          if (destination.existing) {
            await cp(join(addonDirectory, destination.existing), join(backupPath, destination.existing), {
              recursive: true,
              errorOnExist: true,
              force: false,
              dereference: false,
            });
          }
        }
      }

      // Originals remain on the game volume until the metadata commit succeeds, so rollback also works across volumes.
      const originals = join(staging, 'previous');
      await mkdir(originals);
      for (const destination of destinations) {
        await assertSafeParents(addonDirectory);
        if (destination.existing) {
          const source = join(addonDirectory, destination.existing);
          await assertSafeTree(source);
          await rename(source, join(originals, destination.existing));
          replaced.push(destination);
        } else if (await existingStats(join(addonDirectory, destination.folder))) {
          throw failure('wow-addons-folder-conflict');
        }
        if (layout.folders.includes(destination.folder)) {
          await rename(join(next, destination.folder), join(addonDirectory, destination.folder));
          installed.push(destination.folder);
        }
      }
      const record: InstalledAddon = {
        ...details,
        clientDirectory: client,
        folders: layout.folders,
        installedAt: new Date().toISOString(),
        ...(backupPath ? { backupPath } : {}),
      };
      await onCommit?.(record);
      return record;
    } catch (error) {
      try {
        await assertSafeParents(addonDirectory);
        for (const folder of installed.reverse()) {
          const destination = join(addonDirectory, folder);
          if (!inside(addonDirectory, destination)) throw failure('wow-addons-install-failed');
          await rm(destination, { recursive: true, force: true });
        }
        for (const destination of replaced.reverse())
          await rename(join(staging!, 'previous', destination.existing!), join(addonDirectory, destination.existing!));
      } catch (rollbackError) {
        // Keep the original directories for recovery if external filesystem changes prevent rollback.
        preserveStaging = true;
        throw failure(
          'wow-addons-install-failed',
          new AggregateError([error, rollbackError], `Recovery files: ${staging}`),
        );
      }
      if (error instanceof Error && error.message.startsWith('wow-addons-')) throw error;
      throw failure('wow-addons-install-failed', error);
    } finally {
      archive.zip.close();
      if (staging && !preserveStaging && inside(join(client, 'Interface'), staging))
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
