import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_CONFIG_BYTES = 32_768;

/** Never pass a shell command, account name, or an unvalidated SID to icacls. */
function restrictFile(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
    return;
  }
  const identity = execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true },
  );
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('Cannot identify file owner');
  execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `*${sid}:F`],
    { stdio: 'pipe', windowsHide: true },
  );
}

function configPath(home: string): string {
  const directory = join(home, 'dsh-pet');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe settings directory');
  return join(directory, 'standalone-ai.json');
}

export function readAiSettings(home: string): unknown | undefined {
  const path = configPath(home);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('Unsafe settings file');
  // Refuse broad explicit Windows grants rather than reading a potentially public secret.
  // Files created here have no explicit grants except the current SID.
  if (process.platform === 'win32') {
    const acl = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (/\b(?:Everyone|BUILTIN\\Users|Authenticated Users)\s*:/i.test(acl))
      throw new Error('Unsafe settings permissions');
  }
  restrictFile(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (fstatSync(fd).size > MAX_CONFIG_BYTES) throw new Error('Settings file too large');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

/** Set permissions on an empty exclusive temporary file BEFORE writing any secret. */
export function writeAiSettings(home: string, settings: unknown): void {
  writePrivateJson(configPath(home), settings);
}

/** Internal server utility; caller supplies an existing, trusted parent directory. */
export function writePrivateJson(path: string, settings: unknown): void {
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe private file directory');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error('Unsafe settings file');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    restrictFile(temporary);
    writeFileSync(fd, JSON.stringify(settings), { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}
