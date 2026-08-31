/**
 * 桌面 Helper 进程管理器 —— 拉起/守护 Electron 透明窗口进程。
 *
 * 架构：Helper 与宿主之间除了日志，还有一条 **stdin/stdout JSON 行协议**（bridge）：
 *   - 渲染端不再直接访问 DSH WebServer（DSH Desktop 2.0.3+ 的浏览器访问闸门会给插件自拉的
 *     独立进程裸 HTTP 请求回 403），改走自定义 scheme `dsh-pet-bridge://` → Electron 主进程
 *     （main.js 的 protocol.handle）→ 本模块的管道 → 宿主 handlePetRoute（与 HTTP 路由同一份逻辑）。
 *   - 协议行统一前缀 `dsh-pet-bridge:`，与普通日志行区分（main.js 的 console 输出也走 stdout）。
 *   - 素材（webm/字体/光标）不把二进制过管道：宿主返回文件绝对路径，main.js 自行读盘应答。
 * 本文件负责解析 Electron 可执行文件、以子进程方式拉起 electron-helper/main.js、
 * 守护协议通道、并在异常退出时自动重启。
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { symlinkSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(here, '..');
export const defaultHelperMain = resolve(packageRoot, 'runtime', 'electron-helper', 'main.js');

/** 协议行前缀：stdout/stdin 里以此开头的整行 JSON 属于 bridge 协议，其余为日志 */
export const BRIDGE_PREFIX = 'dsh-pet-bridge:';

/** 渲染端（经 main.js 转发）的一次请求：URL 是 /dsh-pet-7340/... 路径 + 查询串；
 *  cb = main.js 本地回调服务器地址（宿主把应答 POST 回去；Electron 主进程读不到 piped stdin，
 *  故应答不走 0 号管道 —— electron#4218） */
export interface BridgeRequest {
  id: number;
  method: string;
  url: string;
  body?: string;
  cb?: string;
}

/** 宿主对一次请求的应答：json/text 走 body；素材走 file（文件绝对路径，main.js 自行读盘） */
export interface BridgeResponse {
  id: number;
  status: number;
  contentType?: string;
  body?: string;
  file?: string;
}

/** bridge 请求处理器（宿主侧与 handlePetRoute 对接；main.js 不在收到请求时带出宿主动作） */
export type BridgeHandler = (req: BridgeRequest) => Promise<BridgeResponse>;

interface HelperOptions {
  electronPath?: string;
  helperPath?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  restartDelayMs?: number;
  /** bridge 协议处理器：renderer 的每条请求（配置/余额/碎碎念/素材等）都经它应答 */
  bridgeHandler?: BridgeHandler;
}

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

/**
 * 解析 Electron 可执行文件。
 * 优先级：
 *   1. 显式候选（用户配置）/ DSH_PET_ELECTRON_PATH 环境变量
 *   2. 本机已安装的 electron npm 包（require('electron') 返回二进制路径）
 *   3. 常见安装位置（$DSH_HOME/electron（默认 ~/.dsh/electron）、npm 全局目录、Program Files）
 *   4. 都不存在时由 ensureElectronDownload() 进程内异步下载（不 spawn 子进程，
 *      避免 process.execPath 在 Electron 宿主（如 DSH Desktop）里指向宿主 exe 导致崩溃）
 */
export function resolveElectronPath(candidates: Array<string | undefined> = []): string | undefined {
  const seen = new Set<string>();
  const list: string[] = [];
  const push = (value: string | undefined | null) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };
  for (const value of candidates) push(value);
  if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && resolved) push(resolved);
  } catch {
    /* electron 未安装时跳过 */
  }
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || join(userProfile, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(userProfile, 'AppData', 'Local');
  // DSH 主目录：与 ensure-electron.mjs 保持一致，认 DSH_HOME（默认 ~/.dsh）
  const dshHome = process.env.DSH_HOME || join(userProfile, '.dsh');
  // 本地候选路径按平台：win32（electron.exe / Program Files）/ darwin（Electron.app）/ linux
  const dshElectron = join(dshHome, 'electron', ELECTRON_REL);
  const localCandidates =
    PLAT === 'win32'
      ? [
          dshElectron,
          join(appData, 'npm', 'node_modules', 'electron', 'dist', 'electron.exe'),
          join(localAppData, 'Programs', 'Electron', 'electron.exe'),
          'C:/Program Files/Electron/electron.exe',
          'C:/Program Files (x86)/Electron/electron.exe',
        ]
      : PLAT === 'darwin'
        ? [
            dshElectron,
            '/Applications/Electron.app/Contents/MacOS/Electron',
            join(userProfile, 'Applications', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
            join('/usr/local/lib/node_modules/electron/dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
          ]
        : [dshElectron, '/usr/local/bin/electron', '/usr/bin/electron', '/opt/electron/electron'];
  for (const candidate of localCandidates) push(candidate);
  if (process.env.ELECTRON_PATH) push(process.env.ELECTRON_PATH);
  return list.find((value) => existsSync(value));
}

/** $DSH_HOME（默认 ~/.dsh），与 ensure-electron.mjs 的 HOME 计算一致。 */
export function dshHomeDir(): string {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  return process.env.DSH_HOME || join(userProfile, '.dsh');
}

// ---------- 平台适配（win32 / darwin / linux）----------
// Electron 官方发布包按平台/架构不同：win32 解压出 electron.exe + 散文件；
// darwin 解压出 Electron.app（可执行文件在 Contents/MacOS/Electron）；linux 是 electron 单文件。

/** 当前平台标识（win32 / darwin / linux） */
const PLAT = process.platform;

/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台） */
const ELECTRON_REL =
  PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

/** 下载 zip 文件名：electron-v<ver>-<platform>-<arch>.zip（官方命名） */
function electronZipName(version: string): string {
  const plat = PLAT === 'win32' ? 'win32' : PLAT === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `electron-v${version}-${plat}-${arch}.zip`;
}

/** Electron 落地路径：$DSH_HOME/electron/<按平台的可执行文件>。 */
export function defaultElectronExe(): string {
  return join(dshHomeDir(), 'electron', ELECTRON_REL);
}

export interface EnsureElectronOptions {
  /** Electron 版本号（默认 43.3.0，可被 DSH_PET_ELECTRON_VERSION 覆盖）。 */
  version?: string;
  /** 下载镜像（默认 npmmirror，可被 DSH_PET_ELECTRON_MIRROR 覆盖）。 */
  mirror?: string;
  /** 单次下载超时（默认 10 分钟）。 */
  timeoutMs?: number;
}

/** 解压后必须存在的关键文件（按平台校验下载完整性，缺则清理重试）。
 *  win32：electron.exe + 散文件；darwin：Electron.app 关键结构；linux：electron 单文件。 */
const REQUIRED_FILES =
  PLAT === 'win32'
    ? [
        'electron.exe',
        'icudtl.dat',
        'resources.pak',
        'snapshot_blob.bin',
        'chrome_100_percent.pak',
        'v8_context_snapshot.bin',
      ]
    : PLAT === 'darwin'
      ? [
          ELECTRON_REL, // Electron.app/Contents/MacOS/Electron
          join('Electron.app', 'Contents', 'Info.plist'),
          join('Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework'),
        ]
      : ['electron'];

/** 以子进程方式跑一条命令（tar/powershell），返回退出码（不依赖 process.execPath）。 */
function runProcess(command: string, args: string[]): Promise<number> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', () => resolveProcess(1));
    child.once('exit', (code) => resolveProcess(code ?? 1));
  });
}

/**
 * 一次解压尝试：命令 + 参数。按平台有序排列，逐个尝试直到成功。
 *
 * 【为什么必须按平台选命令】Electron 发布包是 **zip**（不是 tar），
 * 而 `tar -xf` 能否读 zip 完全取决于 tar 的实现：
 *   - win32：系统自带 tar 实为 bsdtar/libarchive，可透明识别 zip；
 *   - darwin：macOS 自带 tar 同为 bsdtar（/usr/bin/tar 是 libarchive 前端），同样支持 zip；
 *   - linux：绝大多数发行版是 **GNU tar**，只读 tar 格式，遇到 zip 直接报
 *     `This does not look like a tar archive` 并以 2 退出（实测 GNU tar 1.30/1.34/1.35 均如此）。
 * 因此非 Windows 平台不能把 tar 当主力：GNU tar 会稳定失败，白白跑完一遍再 fallback。
 *
 * 【为什么 darwin 优先 unzip 而不是 tar】macOS 的 bsdtar 虽然能解 zip，
 * 但对 zip 内 **符号链接** 的处理与原生 unzip 不一致（bsdtar 会把外链目标
 * 当普通文件写出或改写路径），而 Electron.app 内部结构强依赖 symlink：
 * 实测 v43.3.0 的 darwin 包 585 个条目里有 14 个 symlink，全在
 * `Electron.app/Contents/Frameworks/*.framework/` 下（如
 * `Electron Framework.framework/Versions/Current`）。symlink 被破坏后
 * REQUIRED_FILES 校验即使通过，Electron 启动时也会因框架结构损坏而失败。
 * 故 darwin/linux 一律优先 `unzip`（原生处理 symlink）。
 *
 * 【最后的纯 Node 兜底】unzip 并非所有环境预装（最小化容器 / Windows Server Core 等）。
 * 此时用 Node 的 zlib 自己解：zlib 是运行时内置的，零外部依赖、零新增 npm 包，
 * 且能精确还原 symlink（按 zip 条目的 external attributes 判断 S_IFLNK）。
 */
export interface ExtractAttempt {
  command: string;
  args: (zipPath: string, targetDir: string) => string[];
}

export function extractAttempts(platform: NodeJS.Platform = process.platform): ExtractAttempt[] {
  if (platform === 'win32') {
    return [
      { command: 'tar', args: (zipPath, targetDir) => ['-xf', zipPath, '-C', targetDir] },
      {
        command: 'powershell',
        args: (zipPath, targetDir) => [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${targetDir}' -Force`,
        ],
      },
    ];
  }
  // darwin / linux（以及其它类 unix 平台）：unzip 优先，tar 兜底（部分环境 tar 是 bsdtar 也能解 zip）
  return [
    { command: 'unzip', args: (zipPath, targetDir) => ['-q', '-o', zipPath, '-d', targetDir] },
    { command: 'tar', args: (zipPath, targetDir) => ['-xf', zipPath, '-C', targetDir] },
  ];
}

/**
 * 纯 Node 解压兜底：不依赖任何外部命令（unzip/tar/powershell）。
 *
 * 只在外部解压器全部失败时调用。相比 spawn 子进程，这里自己解析 zip 中央目录：
 *   - 零外部依赖（zlib 是 Node 运行时内置，不新增 npm 包）；
 *   - 能精确还原 **符号链接**（按 external attributes 的 S_IFLNK 位判断），
 *     这是 darwin 的 Electron.app/Contents/Frameworks/*.framework 结构所必需的；
 *   - 做路径穿越防护（拒绝 `..` 与绝对路径条目），避免恶意/损坏 zip 写到目标目录之外。
 *
 * @returns 错误信息；成功返回 undefined
 */
export async function extractZipWithNode(zipPath: string, targetDir: string): Promise<string | undefined> {
  const { inflateRaw } = await import('node:zlib');
  const inflate = (payload: Buffer): Promise<Buffer> =>
    new Promise((done, fail) => {
      inflateRaw(payload, (error: Error | null, result: Buffer) => (error ? fail(error) : done(result)));
    });
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(zipPath);

  // 从尾部定位 End Of Central Directory（EOCD）记录；注释最长 64KB。
  let eocd = -1;
  const scan = Math.min(buf.length, 22 + 0xffff);
  for (let i = buf.length - 22; i >= buf.length - scan; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 'not a zip archive (EOCD not found)';

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // zip64：计数/偏移为 0xffff/0xffffffff 哨兵时，改读 zip64 EOCD。
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const zip64Eocd = buf.readUInt32LE(eocd - 20) === 0x07064b50 ? eocd - 20 : -1;
    if (zip64Eocd < 0) return 'zip64 archive not supported by node fallback';
    count = Number(buf.readBigUInt64LE(zip64Eocd + 32));
    cdOffset = Number(buf.readBigUInt64LE(zip64Eocd + 48));
  }

  let pos = cdOffset;
  const entries: Array<{ name: string; offset: number; mode: number; method: number; size: number }> = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) return `corrupt central directory at entry ${i}`;
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const nameRaw = buf.subarray(pos + 46, pos + 46 + nameLen);
    // 条目名编码：通用位标记第 11 位为 1 表示 UTF-8，否则按 CP437（此处退化为 latin1）。
    const flags = buf.readUInt16LE(pos + 8);
    const name = nameRaw.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    entries.push({
      name,
      offset: localOffset,
      mode: externalAttrs >>> 16,
      method,
      size: compressedSize,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  for (const entry of entries) {
    // 路径穿越防护：拒绝 .. 段与绝对路径。
    const target = resolve(targetDir, entry.name);
    if (target !== targetDir && !target.startsWith(targetDir + sep)) {
      return `unsafe entry path rejected: ${entry.name}`;
    }
    const isSymlink = (entry.mode & 0o170000) === 0o120000;
    const isDir = entry.name.endsWith('/');

    if (entry.method === 0 && !isSymlink && !isDir) {
      // stored（未压缩）：数据紧跟本地文件头。
      const nameLen = buf.readUInt16LE(entry.offset + 26);
      const extraLen = buf.readUInt16LE(entry.offset + 28);
      const start = entry.offset + 30 + nameLen + extraLen;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf.subarray(start, start + entry.size));
      continue;
    }

    // 本地文件头（用于拿真实的名字/扩展字段长度；中央目录的副本可能与本地不一致）。
    if (buf.readUInt32LE(entry.offset) !== 0x04034b50) return `corrupt local header for ${entry.name}`;
    const lNameLen = buf.readUInt16LE(entry.offset + 26);
    const lExtraLen = buf.readUInt16LE(entry.offset + 28);
    const dataStart = entry.offset + 30 + lNameLen + lExtraLen;

    if (isDir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const payload = buf.subarray(dataStart, dataStart + entry.size);
    if (entry.method === 8) {
      const raw = await inflate(payload);
      if (isSymlink) {
        const linkTarget = raw.toString('utf8');
        rmSync(target, { force: true });
        symlinkSync(linkTarget, target);
        continue;
      }
      writeFileSync(target, raw);
      continue;
    }
    if (entry.method === 0) {
      if (isSymlink) {
        const linkTarget = payload.toString('utf8');
        rmSync(target, { force: true });
        symlinkSync(linkTarget, target);
        continue;
      }
      writeFileSync(target, payload);
      continue;
    }
    return `unsupported compression method ${entry.method} for ${entry.name}`;
  }
  return undefined;
}

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  mkdirSync(targetDir, { recursive: true });
  const attempts = extractAttempts();
  let lastError = 'no extractor attempted';
  for (const attempt of attempts) {
    const code = await runProcess(attempt.command, attempt.args(zipPath, targetDir));
    if (code === 0) {
      // 校验关键文件是否完整；不完整说明下载/解压失败，清理后重试。
      const missing = REQUIRED_FILES.filter((name) => !existsSync(join(targetDir, name)));
      if (missing.length === 0) return;
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true });
      lastError = `Electron zip incomplete, missing: ${missing.join(', ')}`;
      continue;
    }
    lastError = `${attempt.command} exited with ${code}`;
  }
  // 所有外部解压器都不可用（如最小化容器无 unzip 且 tar 是 GNU tar）：
  // 用 Node 内置 zlib 自己解，零外部依赖，且能正确还原 symlink。
  const fallbackError = await extractZipWithNode(zipPath, targetDir);
  if (fallbackError) {
    rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`failed to extract Electron zip (${lastError}; node fallback: ${fallbackError})`);
  }
  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(targetDir, name)));
  if (missing.length > 0) {
    rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`Electron zip incomplete, missing: ${missing.join(', ')}`);
  }
}

/**
 * 进程内下载并解压 Electron 到 $DSH_HOME/electron。
 * 不 spawn 子进程：在 CLI node 与 Electron 宿主（DSH Desktop）里都可用，
 * 修复原 ensure-electron.mjs 用 process.execPath 调脚本导致宿主重复拉起的问题。
 * 已存在则原样返回；失败返回 undefined（不影响 DSH 与浏览器 overlay）。
 */
export async function ensureElectronDownload(options: EnsureElectronOptions = {}): Promise<string | undefined> {
  const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || '43.3.0';
  const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const targetDir = join(dshHomeDir(), 'electron');
  const exe = join(targetDir, ELECTRON_REL);
  if (existsSync(exe)) return exe;

  // 下载日志用 console 直出（ctx.logger 在部分宿主不映射到终端，排障时看不到）。
  const log = (message: string): void => console.log(`[dsh-pet] ${message}`);
  const warn = (message: string): void => console.warn(`[dsh-pet] ${message}`);
  const startedAt = Date.now();

  log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`);
  mkdirSync(targetDir, { recursive: true });
  const zipName = electronZipName(version);
  const url = `${mirror.replace(/\/$/, '')}/${version}/${zipName}`;
  const zipPath = join(tmpdir(), zipName);

  try {
    log(`GET ${url}`);
    // 下载超时控制：AbortController + 定时器，超时中断 fetch 流。
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    try {
      const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
      if (!response.ok) {
        throw new Error(`download failed: ${response.status} ${response.statusText} (${url})`);
      }
      if (!response.body) {
        throw new Error(`download empty body (${url})`);
      }
      // Response.body 是 Web ReadableStream，转为 Node 流再交给 pipeline（类型安全）。
      const totalBytes = Number(response.headers.get('content-length') ?? 0);
      let received = 0;
      let nextLogAt = Date.now() + 3000;
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          const now = Date.now();
          if (received > 0 && now >= nextLogAt) {
            const percent =
              totalBytes > 0
                ? `${Math.round((received / totalBytes) * 100)}%`
                : `${(received / 1024 / 1024).toFixed(1)}MB`;
            log(
              `downloading ${(received / 1024 / 1024).toFixed(1)}MB / ${(totalBytes / 1024 / 1024).toFixed(1)}MB (${percent})`,
            );
            nextLogAt = now + 3000;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        progress,
        createWriteStream(zipPath),
      );
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`download complete (${(received / 1024 / 1024).toFixed(1)}MB in ${seconds}s)`);
    } finally {
      clearTimeout(timer);
    }
    log(`extracting to ${targetDir} ...`);
    await extractZip(zipPath, targetDir);
    if (!existsSync(exe)) {
      throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`ready in ${seconds}s: ${exe}`);
    return exe;
  } catch (error) {
    warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
    warn('desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.');
    return undefined;
  } finally {
    try {
      rmSync(zipPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function defaultLaunch(options: HelperOptions = {}): { command: string; args: string[] } {
  const electronPath = resolveElectronPath([options.electronPath]);
  if (!electronPath) {
    throw new Error('dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.');
  }
  const helperPath = options.helperPath || defaultHelperMain;
  return { command: electronPath, args: [helperPath] };
}

export class HelperProcess {
  declare readonly options: HelperOptions;
  declare readonly logger: Logger;
  declare private child?: import('node:child_process').ChildProcess;
  declare private stopping: boolean;
  declare private restartSuppressed: boolean;
  declare private restartTimer?: NodeJS.Timeout;
  /** stdout 按行缓冲（协议行按 \n 切分）。用 declare + 构造器赋值，避免类字段降级出外部 helper */
  declare private stdoutBuffer: string;

  constructor(options: HelperOptions = {}, logger: Logger = console) {
    this.options = options;
    this.logger = logger;
    this.child = undefined;
    this.stopping = false;
    this.restartSuppressed = false;
    this.restartTimer = undefined;
    this.stdoutBuffer = '';
  }

  start(): import('node:child_process').ChildProcess | undefined {
    if (this.child || this.stopping || this.restartSuppressed) return this.child;
    const helperPath = this.options.helperPath || defaultHelperMain;
    const launch = this.options.command
      ? { command: this.options.command, args: this.options.args || [helperPath] }
      : defaultLaunch(this.options);
    const command = launch.command;
    const args = this.options.args || launch.args;

    const child = spawn(command, args, {
      cwd: this.options.cwd || packageRoot,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'], // stdin 也要：bridge 协议响应回写（main.js 请求经 stdout 上来）
      windowsHide: true,
    });
    this.child = child;
    child.once('error', (error) => {
      this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.stopping && !this.restartSuppressed) {
        this.logger.warn?.(
          `dsh-pet desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`,
        );
        this.scheduleRestart();
      }
    });
    child.stdout.on('data', (chunk) => {
      this.onStdoutChunk(String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
    });
    child.stdin?.on('error', () => {
      /* EPIPE 等：进程退出/重启期间回写失败静默（下一轮 start 重建管道） */
    });
    return child;
  }

  /** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行 */
  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(BRIDGE_PREFIX)) {
        void this.handleBridgeLine(trimmed);
        continue;
      }
      this.logger.debug?.(`[dsh-pet desktop helper] ${trimmed}`);
    }
  }

  /** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
   *  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
  private async handleBridgeLine(line: string): Promise<void> {
    const child = this.child;
    if (!child?.stdin || !this.options.bridgeHandler) return;
    let req: BridgeRequest;
    try {
      req = JSON.parse(line.slice(BRIDGE_PREFIX.length)) as BridgeRequest;
    } catch {
      this.logger.warn?.('[dsh-pet desktop helper] bridge 协议行非法，已忽略');
      return;
    }
    if (typeof req.id !== 'number') return;
    try {
      // bridgeHandler 返回完整 BridgeResponse（含 id）；异常时兜底 500
      const resp = await this.options.bridgeHandler(req);
      this.sendBridgeResponse(req, resp);
    } catch (e) {
      this.sendBridgeResponse(req, {
        id: req.id,
        status: 500,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` }),
      });
    }
  }

  /** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容） */
  private sendBridgeResponse(req: BridgeRequest, resp: BridgeResponse): void {
    const cb = typeof req.cb === 'string' && /^https?:[/][/]/.test(req.cb) ? req.cb : '';
    if (cb) {
      void fetch(cb, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(resp),
      }).catch(() => {
        /* 回调失败（main.js 已退出等）：请求端会超时降级，这里静默 */
      });
      return;
    }
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + '\n');
    } catch {
      /* ignore */
    }
  }

  stop(reason = 'plugin-disposed'): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
    const child = this.child;
    if (!child) return;
    child.kill();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping || this.restartSuppressed) return;
    const delay = this.options.restartDelayMs ?? 750;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}
