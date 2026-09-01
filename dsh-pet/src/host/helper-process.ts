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
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { downloadArtifact } from '@electron/get';
import extract from '@electron-internal/extract-zip';

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
 *   3. $DSH_HOME/electron（默认 ~/.dsh/electron）—— ensureElectronDownload 的落地路径
 *   4. 都不存在时由 ensureElectronDownload() 进程内异步下载（不 spawn 子进程，
 *      避免 process.execPath 在 Electron 宿主（如 DSH Desktop）里指向宿主 exe 导致崩溃）
 */
export function resolveElectronPath(candidates: Array<string | undefined> = []): string | undefined {
  const seen = new Set<string>();
  const list: string[] = [];
  const push = (value: string | undefined | null): void => {
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
  // 只认自己的落地路径（ensureElectronDownload 下载解压到 $DSH_HOME/electron）；
  // 不再去 npm 全局目录 / Program Files / /usr/bin 等别处探测别人装的 Electron。
  push(join(dshHomeDir(), 'electron', ELECTRON_REL));
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

  try {
    // 官方 @electron/get 下载：负责 URL 拼装、镜像、SHA256 校验（sumchecker）、下载缓存
    // （同一版本只下载一次，之后命中缓存秒回）。超时用 AbortController 传给 fetch。
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    let nextLogAt = Date.now() + 3000;
    try {
      const zipPath = await downloadArtifact({
        version: `v${version}`,
        artifactName: 'electron',
        // platform/arch 不传：@electron/get 用宿主平台与架构自动推断
        // （getHostArch 还处理 arm → armv7l 特例，比显式传 process.arch 更准）
        mirrorOptions: { mirror: mirror.replace(/\/$/, '') + '/' },
        downloadOptions: {
          signal: controller.signal,
          quiet: true, // 关掉 @electron/get 自己的进度条（stdout 走宿主日志，不进 bridge 协议）
          getProgressCallback: async (progress: { transferred: number; total: number | null }) => {
            const now = Date.now();
            if (!progress.total || now < nextLogAt) return;
            nextLogAt = now + 3000;
            log(
              `downloading ${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB`,
            );
          },
        },
      });
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`download complete (${seconds}s), extracting to ${targetDir} ...`);
      // 官方 @electron-internal/extract-zip 解压（electron 43 官方安装同款）：
      // 纯 Node + native binding，跨平台一致，正确处理 symlink 与文件权限，
      // 不需要系统 unzip/tar/powershell，也没有我们手写的平台适配链。
      await extract(zipPath, { dir: targetDir });
      if (!existsSync(exe)) {
        throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
      }
      const readySeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`ready in ${readySeconds}s: ${exe}`);
      return exe;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
    warn('desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.');
    return undefined;
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
