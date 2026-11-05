/**
 * 独立模式的本机配置文件读写：只处理权限、原子替换与大小上限。
 *
 * 不负责设置语义与校验（见 ai-config），也不决定文件该放在哪个目录。
 * 必须始终成立：写入先在空临时文件上收紧权限再原子替换；
 * 读取拒绝符号链接、超限文件与过宽的 ACL。
 * @module dsh-pet/src/standalone/ai-storage
 */
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

/** 配置文件的字节上限。 */
const MAX_CONFIG_BYTES = 32_768;

/** 只把权限授给当前用户；绝不把 shell 命令、账户名或未校验的 SID 交给 icacls。 */
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

/** 解析并准备配置目录，拒绝符号链接。 */
function configPath(home: string): string {
  const directory = join(home, 'dsh-pet');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe settings directory');
  return join(directory, 'standalone-ai.json');
}

/**
 * 读取本机 AI 配置。
 * @param home - DSH_HOME。
 * @returns 解析后的未知值；文件不存在时返回 undefined。
 * @throws 路径、大小或权限不安全时抛出。
 */
export function readAiSettings(home: string): unknown | undefined {
  return readPrivateJson(configPath(home));
}

/** Read a private JSON configuration using the same permission and size contract as AI settings. */
export function readPrivateJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('Unsafe settings file');
  // 显式宽权限比读不到更危险：先拒绝，再由 restrictFile 收紧到当前 SID。
  // 这里创建的文件除当前 SID 外不应有任何显式授权。
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

/**
 * 原子写入 AI 配置。
 * @param home - DSH_HOME。
 * @param settings - 待持久化的成品配置。
 * @throws 目录或权限不安全时抛出。
 */
export function writeAiSettings(home: string, settings: unknown): void {
  writePrivateJson(configPath(home), settings);
}

/**
 * 把 JSON 原子写入受信任目录。
 * @param path - 目标文件。
 * @param settings - 待写入的 JSON 值。
 * @throws 目录是符号链接或写入失败时抛出。
 */
export function writePrivateJson(path: string, settings: unknown): void {
  // 先确认目录是普通目录，避免被符号链接带到别处。
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe private file directory');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error('Unsafe settings file');
  const temporary = `${path}.${randomUUID()}.tmp`;
  // 先建空临时文件并收紧权限，再写入任何密钥，避免密钥短暂落进宽权限文件。
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
