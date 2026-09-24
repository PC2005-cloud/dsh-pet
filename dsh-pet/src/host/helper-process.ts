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
  push(defaultElectronExe());
  return list.find((value) => existsSync(value));
}

/** $DSH_HOME（默认 ~/.dsh），与 ensure-electron.mjs 的 HOME 计算一致。 */
/**
 * 判断当前环境能否真的跑起 Electron 图形窗口。
 *
 * 【为什么需要】Linux 无显示环境（服务器 / 容器 / 纯 CLI）下，Electron 能被成功
 * 下载并 spawn 拉起，但初始化图形栈时立刻崩溃。配合 Helper 的守护循环
 * （异常退出自动重启），结果是每秒反复「拉起→崩溃→重启」，每个 core dump
 * 约 14MB —— 实测几小时可堆到数十 GB 打满磁盘。必须在拉起之前判断。
 *
 * 判定口径（只拦「明确跑不起来」的情况）：
 *   - win32 / darwin：桌面系统，放行（macOS 无 DISPLAY 也走 WindowServer）；
 *   - linux：需要 DISPLAY 或 WAYLAND_DISPLAY 其一，都没有则判为无显示环境。
 *
 * 【逃生口】DSH_PET_DESKTOP_FORCE=1 强制跳过，供 Xvfb / 远程桌面等
 * 「环境变量没设但其实能显示」的场景使用。
 */
export function hasGraphicalDisplay(): boolean {
  if (process.platform !== 'linux') return true;
  if (process.env.DSH_PET_DESKTOP_FORCE === '1') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

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

/**
 * Electron 运行时落地目录（$DSH_HOME/electron）—— 下载解压的目标，
 * 也是设置页「卸载与存储」里让用户清理的那个目录。
 *
 * 唯一定义处：解析（resolveElectronPath / defaultElectronExe）与下载
 * （ensureElectronDownload）全部走这里，避免同一个目录字面量在多个模块各写一遍，
 * 改了一处而另一处没改（设置页就会显示一个永远不存在的路径）。
 */
export function electronLandingDir(): string {
  return join(dshHomeDir(), 'electron');
}

/** Electron 落地路径：$DSH_HOME/electron/<按平台的可执行文件>。 */
export function defaultElectronExe(): string {
  return join(electronLandingDir(), ELECTRON_REL);
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
  const targetDir = electronLandingDir();
  const exe = defaultElectronExe();
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

/** 停止 helper 的等待上限（ms）：超过就升级 SIGKILL（issue #64） */
export const HELPER_STOP_TIMEOUT_MS = 3000;
/** SIGKILL 之后还给进程多久退出（ms）；到点仍未退出就放弃等待，绝不无限挂住调用方 */
export const HELPER_STOP_GRACE_MS = 1000;

/**
 * spawn helper 用的环境变量（纯函数，可独立测试）。
 *
 * **必须删掉 `ELECTRON_RUN_AS_NODE`**（issue #63）：宿主自己可能就是个 Electron 应用（DSH Desktop），
 * 它的 `process.env` 里可能带着这个变量；原样透传会让我们 spawn 的 Electron 以**纯 Node 模式**启动——
 * 内置 `electron` 模块根本不注册，main.js 顶部 `require('electron')` 直接 MODULE_NOT_FOUND →
 * helper 崩 → 守护循环重启 → 12 次熔断 → 桌面模式彻底不再出现，且没有任何用户可见提示。
 *
 * 为什么是"删除"而不是设成空串：Electron 只看这个变量**存不存在**。实测 Electron 43.3.0（Windows，
 * 与插件用的是同一份二进制）：删除 → `process.type=browser`、`require('electron')` 正常拿到 app；
 * 设 `''` → 直接 abort（exit 134，`node::CreateEnvironment` 断言失败）；设 `'0'`/`'false'`/`'1'` →
 * 都进纯 Node 模式。运行期再 `delete process.env` 已经晚了（模块加载器在进程启动瞬间就定了）。
 */
export function helperSpawnEnv(hostPid: number, extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_PET_HOST_PID: String(hostPid), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export class HelperProcess {
  declare readonly options: HelperOptions;
  declare readonly logger: Logger;
  declare private child?: import('node:child_process').ChildProcess;
  declare private stopping: boolean;
  declare private restartTimer?: NodeJS.Timeout;
  /** 连续崩溃计数（稳定运行 ≥3 分钟清零；达上限触发熔断） */
  declare private restartFailures: number;
  /** 最近一次 start() 的时间戳（稳定性判定基准） */
  declare private lastStartAt: number;
  /** stdout 按行缓冲（协议行按 \n 切分）。用 declare + 构造器赋值，避免类字段降级出外部 helper */
  declare private stdoutBuffer: string;

  constructor(options: HelperOptions = {}, logger: Logger = console) {
    this.options = options;
    this.logger = logger;
    this.child = undefined;
    this.stopping = false;
    this.restartTimer = undefined;
    this.restartFailures = 0;
    this.lastStartAt = 0;
    this.stdoutBuffer = '';
  }

  start(): import('node:child_process').ChildProcess | undefined {
    if (this.child || this.stopping) return this.child;
    this.lastStartAt = Date.now();
    const helperPath = this.options.helperPath || defaultHelperMain;
    const launch = this.options.command
      ? { command: this.options.command, args: this.options.args || [helperPath] }
      : defaultLaunch(this.options);
    const command = launch.command;
    const args = this.options.args || launch.args;

    const child = spawn(command, args, {
      cwd: this.options.cwd || packageRoot,
      // DSH_PET_HOST_PID：把**宿主自己的** pid 交给 helper，让它能判断"宿主还在不在"
      // （helper 侧 host-liveness.js 每 2s kill(pid, 0) 一次；ESRCH 就自行退出，见 issue #56）。
      // 放在唯一的 spawn 点，所有调用方（含自定义 command）自动获得。
      // 为什么 macOS/Linux 非有不可：Windows 上 Node/libuv 会把子进程放进带
      // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的 job 对象，宿主一退出内核就顺手杀掉它——实测
      // helper 的心跳正好停在宿主退出的那一刻、连 process.on('exit') 都不触发；POSIX 没有这层
      // 兜底，宿主非正常退出后 helper 会一直留着（issue #56 报告的就是这个）。
      // 环境变量统一经 helperSpawnEnv 构造：它会删掉会劫持 Electron 启动模式的 ELECTRON_RUN_AS_NODE
      // （issue #63，详见该函数注释）。
      env: helperSpawnEnv(process.pid, this.options.env),
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
      if (!this.stopping) {
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

  /** 停止 helper：发 SIGTERM 即返回，**不等它退出**。宿主退出/插件卸载路径用它——
   *  宿主马上就没了（Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底，见 issue #56）。
   *  **停止后要立刻重启的场景必须用 stopAndWait()**，否则新旧进程会短暂重叠（issue #64）。 */
  stop(reason = 'plugin-disposed'): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
    const child = this.child;
    if (!child) return;
    child.kill();
  }

  /**
   * 停止 helper 并**等它真正退出**（issue #64）：原实现只发一次 SIGTERM 就返回、紧接着 spawn 新进程，
   * 而 Electron 收到 SIGTERM 后关窗、销毁 GPU/动画合成器是异步的（几百 ms 起）——旧窗口（旧大小）
   * 还没消失、新窗口（新大小）已经画出来，桌面上就短暂出现"两只宠物"。
   *   ① 先置 `stopping`（由 stop() 完成）：守护逻辑不得把这次主动停止误判成崩溃去自动重启；
   *   ② 只等 `exit`，**不等 `close`**：stdio 管道关闭远早于进程真正退出（实测 SIGTERM 后 ~10ms 就触发）；
   *   ③ 超时（默认 3s）升级 SIGKILL；SIGKILL 后再给 1s 宽限，仍未退出就放弃等待——
   *      配置保存绝不能因为一个退不掉的子进程而被无限挂住。
   */
  async stopAndWait(reason = 'plugin-disposed', timeoutMs = HELPER_STOP_TIMEOUT_MS): Promise<void> {
    this.stop(reason);
    const child = this.child;
    if (!child) return;
    await waitForChildExit(child, timeoutMs, () => {
      this.logger.warn?.(`dsh-pet desktop helper 未在 ${timeoutMs}ms 内退出，升级 SIGKILL（${reason}）`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出了 */
      }
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    // ① 指数退避：750ms 起 2x 封顶 30s；② 熔断：连续崩溃 12 次（约 3 分钟）后停止重启。
    // 两个阈值都可配（DSH_PET_RESTART_BASE_MS / DSH_PET_RESTART_MAX_FAILURES），稳定运行 ≥3 分钟清零。
    // 纯逻辑（restartBackoffDelayMs / shouldCircuitBreak / helperRunIsStable）在 helper-process.test.ts 有独立用例。
    if (helperRunIsStable(Date.now() - this.lastStartAt)) {
      this.restartFailures = 0;
    } else {
      this.restartFailures += 1;
    }
    if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
      this.logger.error?.(
        `dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, ` +
          `no more restarts. Fix the environment (e.g. DISPLAY/headless) or set DSH_PET_RESTART_MAX_FAILURES to raise the limit.`,
      );
      return;
    }
    const base = this.resolveRestartBaseMs();
    // 首次崩溃等 base（= 750ms 默认），与旧版固定首延和 restartBackoffDelayMs 的 0 起序列一致：
    // 计数是"已经崩了几次"（1 起），延迟要按"第几次重试"（0 起）取，故减 1
    const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
    this.logger.warn?.(
      `dsh-pet desktop helper exited; restarting in ${Math.round(delay)}ms ` +
        `(attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** 退避基值：DSH_PET_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
  private resolveRestartBaseMs(): number {
    return envPositiveInt(process.env.DSH_PET_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
  }

  /** 熔断阈值：DSH_PET_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
  private resolveMaxFailures(): number {
    return envPositiveInt(process.env.DSH_PET_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
  }
}

/**
 * 等子进程真正退出（issue #64 的"停止要等干净"那一步）：
 *   - 已经退出（exitCode/signalCode 有值）→ 立即 resolve，不挂监听；
 *   - 只等 `exit`：`close` 只代表 stdio 管道关闭，远早于进程真正退出；
 *   - 到 timeoutMs 调 onTimeout()（调用方升级 SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；
 *   - 宽限到点仍未退出就 resolve——调用方（配置保存触发的重启）绝不能被无限挂住。
 */
function waitForChildExit(
  child: import('node:child_process').ChildProcess,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let giveUpTimer: NodeJS.Timeout | undefined;
    const done = (): void => {
      clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      child.removeListener('exit', done);
      resolve();
    };
    const killTimer = setTimeout(() => {
      onTimeout();
      giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
      giveUpTimer.unref?.();
    }, timeoutMs);
    killTimer.unref?.();
    child.once('exit', done);
  });
}

// ---------- 重启退避 / 熔断纯逻辑（可独立测试，不依赖 spawn） ----------

/** 稳定运行判定阈值：Helper 连续无崩溃运行 ≥ 3 分钟后，重启失败计数清零。 */
export const HELPER_STABLE_MS = 3 * 60 * 1000;

/**
 * 指数退避：第 n 次（0 起）失败后等待 base × 2ⁿ，封顶 30s。
 * 默认 base 750ms 保持与旧版首延一致，序列：750 → 1500 → 3000 → … → 30000。
 */
export function restartBackoffDelayMs(consecutiveFailures: number, baseMs = 750): number {
  const MAX = 30_000;
  const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
  return Math.min(raw, MAX);
}

/** 熔断判定：连续崩溃 ≥ limit（默认 12，按默认退避累计约 3 分钟）次后不再自动重启。 */
export function shouldCircuitBreak(consecutiveFailures: number, limit = 12): boolean {
  return consecutiveFailures >= limit;
}

/** 稳定运行判定：距上次拉起 ≥ HELPER_STABLE_MS 视为一次「成功运行」，可清零计数。 */
export function helperRunIsStable(elapsedMs: number): boolean {
  return elapsedMs >= HELPER_STABLE_MS;
}

/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_PET_RESTART_BASE_MS 可调。 */
const RESTART_BASE_MS_DEFAULT = 750;

/** 熔断阈值（连续崩溃次数）：默认 12，DSH_PET_RESTART_MAX_FAILURES 可调。 */
const RESTART_MAX_FAILURES_DEFAULT = 12;

/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
function envPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
