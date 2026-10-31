/**
 * Helper 子进程本体：拉起、管道通信、停止与等待退出。
 *
 * 不决定何时重启（归 ./restart），不解析 Electron 路径（归 ./electron）。
 * 必须始终成立：新旧进程绝不重叠，stop 之后不得再写管道。
 * @module dsh-pet/src/host/helper/child
 */
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { BRIDGE_PREFIX } from './bridge.ts';
import type { BridgeHandler, BridgeRequest, BridgeResponse } from './bridge.ts';
import { defaultHelperMain, defaultLaunch, dshHomeDir, readElectronVersion } from './electron.ts';
import {
  HELPER_STABLE_MS,
  HELPER_STOP_TIMEOUT_MS,
  waitForChildExit,
  RESTART_BASE_MS_DEFAULT,
  RESTART_MAX_FAILURES_DEFAULT,
  crashLoopAdvice,
  describeExit,
  envPositiveInt,
  helperRunIsStable,
  restartBackoffDelayMs,
  shouldCircuitBreak,
  shouldFallbackToNoSandbox,
} from './restart.ts';

/** 日志里的运行时身份：` · electron=<路径> (<版本>)`；版本读不到时只留路径。 */
function electronIdentity(electronExe: string): string {
  const version = readElectronVersion(electronExe);
  return ` · electron=${electronExe}${version ? ` (${version})` : ''}`;
}

/** 构造 HelperProcess 的选项；全部可选，缺省走 defaultLaunch 与 $DSH_HOME。 */
export interface HelperOptions {
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

/** 最小日志接口（宿主传 console 或统一日志器）；与 log-file 的 LoggerLike 同形。 */
type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

/**
 * spawn helper 用的环境变量（纯函数，可独立测试）。
 *
 * 必须删掉 `ELECTRON_RUN_AS_NODE`：宿主自己可能就是个 Electron 应用（DSH Desktop），它的 env 里可能
 * 带着这个变量，原样透传会让子进程以纯 Node 模式启动——`require('electron')` 直接 MODULE_NOT_FOUND，
 * helper 崩、守护循环重启、最终熔断，桌面模式彻底不再出现，且没有任何用户可见提示。
 * 为什么是删除而不是置空：Electron 只看这个变量存不存在，实测置 `''` 直接 abort（exit 134），置
 * `'0'` / `'false'` / `'1'` 都进纯 Node 模式；运行期再 delete 已经晚了，模块加载器在进程启动时就定了。
 */
export function helperSpawnEnv(hostPid: number, extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_PET_HOST_PID: String(hostPid), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 一个 Helper 子进程的生命周期：启动、协议读写、停止、崩溃重启。 */
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
  /** 最近一次拉起的运行时身份（可执行文件路径与版本）：崩溃与熔断日志都要带它 */
  declare private launchIdentity: string;
  /** 是否已经因为「沙箱初始化失败」改用过 `--no-sandbox`（只退一次） */
  declare private sandboxFallbackApplied: boolean;
  /** 当前子进程有没有写过 stdout/stderr：有输出说明 JS 已经跑过，秒退就不能赖沙箱 */
  declare private sawChildOutput: boolean;

  constructor(options: HelperOptions = {}, logger: Logger = console) {
    this.options = options;
    this.logger = logger;
    this.child = undefined;
    this.stopping = false;
    this.restartTimer = undefined;
    this.restartFailures = 0;
    this.lastStartAt = 0;
    this.stdoutBuffer = '';
    this.launchIdentity = '';
    this.sandboxFallbackApplied = false;
    this.sawChildOutput = false;
  }

  /** 拉起子进程；已有子进程在跑或正在停止时直接返回现有句柄。 */
  start(): import('node:child_process').ChildProcess | undefined {
    if (this.child || this.stopping) return this.child;
    this.lastStartAt = Date.now();
    const helperPath = this.options.helperPath || defaultHelperMain;
    const launch = this.options.command
      ? { command: this.options.command, args: this.options.args || [helperPath] }
      : defaultLaunch(this.options);
    const command = launch.command;
    const baseArgs = this.options.args || launch.args;
    // 沙箱起不来时（见 applySandboxFallback）后续每次拉起都把开关放在最前：Electron 只认命令行，
    // 没有环境变量/配置文件能表达「禁用沙箱」。自定义 command 不走这条（那不是真正的 Electron）。
    const args = this.sandboxFallbackApplied && !this.options.command ? ['--no-sandbox', ...baseArgs] : baseArgs;
    this.sawChildOutput = false;
    // 版本只在这里读一次：崩溃时退出码能说明「怎么死的」，说明不了「死的哪个版本」，而那才是排障入口
    this.launchIdentity = electronIdentity(command);

    // cwd 必须落在包目录之外：Windows 不允许重命名或删除活进程的当前目录，否则 pnpm 无法 rename
    // 覆盖 node_modules/dsh-pet。Helper 侧资源解析与 CWD 无关，故用 $DSH_HOME。
    const cwd = this.options.cwd || dshHomeDir();
    mkdirSync(cwd, { recursive: true }); // spawn 的 cwd 不存在会直接 ENOENT
    const child = spawn(command, args, {
      cwd,
      // DSH_PET_HOST_PID：把宿主自己的 pid 交给 helper，让它能判断「宿主还在不在」（helper 侧每 2s
      // kill(pid, 0) 一次，ESRCH 就自行退出）。放在唯一的 spawn 点，所有调用方都能拿到。
      // macOS/Linux 非有不可：Windows 上 libuv 会把子进程放进带 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      // 的 job 对象，宿主一退出内核就顺手杀掉；POSIX 没有这层兜底，helper 会一直留着。
      // 环境变量统一经 helperSpawnEnv 构造：它会删掉会劫持 Electron 启动模式的 ELECTRON_RUN_AS_NODE。
      env: helperSpawnEnv(process.pid, this.options.env),
      stdio: ['pipe', 'pipe', 'pipe'], // stdin 也要：bridge 协议响应回写（main.js 请求经 stdout 上来）
      windowsHide: true,
    });
    this.child = child;
    // 「启动成功」在 spawn 返回后立刻可写，但那时进程可能正在崩：#244 的日志里就有
    // 「started」紧跟着「exited」。等满稳定阈值仍活着再补一行，两者才区分得开。
    const stableTimer = setTimeout(() => {
      if (this.child === child && !this.stopping) {
        this.logger.info?.(`dsh-pet desktop helper stable for ${HELPER_STABLE_MS / 60_000}m${this.launchIdentity}`);
      }
    }, HELPER_STABLE_MS);
    stableTimer.unref?.();
    child.once('error', (error) => {
      this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}${this.launchIdentity}`);
      // spawn 失败（ENOENT / EACCES）只发 error 不发 exit：不能留一个没跑起来的子进程挡住之后每次
      // start；而活着的进程报错（例如 kill 失败）必须继续等它的 exit。
      if (child.pid === undefined && this.child === child) {
        this.child = undefined;
        clearTimeout(stableTimer);
        this.scheduleRestart();
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      clearTimeout(stableTimer);
      if (!this.stopping) {
        // 沙箱初始化失败的特殊形态：秒退、无输出、退出码 0x80000003 → 换 --no-sandbox 立刻重试一次。
        // 必须排在「日志 + 退避」之前：这一轮不算崩溃，不该消耗退避与熔断额度。
        if (this.applySandboxFallback(code)) return;
        this.logger.warn?.(
          `dsh-pet desktop helper exited (${describeExit(code, signal)})${this.launchIdentity}; restarting`,
        );
        this.scheduleRestart();
      }
    });
    child.stdout.on('data', (chunk) => {
      this.sawChildOutput = true;
      this.onStdoutChunk(String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) {
        this.sawChildOutput = true;
        this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
      }
    });
    child.stdin?.on('error', () => {
      /* EPIPE 等：进程退出/重启期间回写失败静默（下一轮 start 重建管道） */
    });
    return child;
  }

  /** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行。 */
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

  /** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容）。 */
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

  /** 停止 helper：发 SIGTERM 即返回，不等它退出。宿主退出 / 插件卸载路径用它——宿主马上就没了
   *  （Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底）。
   *  停止后要立刻重启的场景必须用 stopAndWait()，否则新旧进程会短暂重叠。 */
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
   * 停止 helper 并等它真正退出：只发一次 SIGTERM 就 spawn 新进程是不行的——Electron 收到 SIGTERM 后
   * 关窗、销毁 GPU/动画合成器是异步的（几百 ms 起），旧窗口（旧大小）还没消失、新窗口已经画出来，
   * 桌面上会短暂出现「两只宠物」。所以：① 先置 `stopping`（由 stop() 完成），守护逻辑不得把这次主动
   * 停止误判成崩溃去自动重启；② 只等 `exit` 不等 `close`——stdio 管道关闭远早于进程真正退出；③ 超时
   * （默认 3s）升级 SIGKILL，再给 1s 宽限，仍未退出就放弃等待，配置保存绝不能被无限挂住。
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

  /**
   * 沙箱初始化失败的特殊崩溃 → 改用 `--no-sandbox` 立刻重试一次（判定见 shouldFallbackToNoSandbox）。
   *
   * 为什么值得自动退：这台机器上「不加 --no-sandbox 就 0x80000003 秒退」是确定性行为，重试 12 次
   * 只会把同一条日志刷 12 遍然后熔断，用户看不到宠物也读不到原因。退一次能让绝大多数这类机器
   * 立刻可用；剩下真崩的（有输出 / 跑了一阵 / 换参数后还是崩）照旧走退避与熔断，不会被掩盖。
   * @param code - 本次退出的退出码（null = 被信号终止）。
   * @returns true 表示已经发起带 `--no-sandbox` 的重试，调用方不要再走退避路径。
   */
  private applySandboxFallback(code: number | null): boolean {
    const applied = shouldFallbackToNoSandbox({
      code,
      sawOutput: this.sawChildOutput,
      ranMs: Date.now() - this.lastStartAt,
      alreadyApplied: this.sandboxFallbackApplied,
      customCommand: Boolean(this.options.command),
    });
    if (!applied) return false;
    this.sandboxFallbackApplied = true;
    this.logger.warn?.(
      `dsh-pet desktop helper 因 Chromium 沙箱初始化失败而秒退（${describeExit(code, null)}），` +
        `改用 --no-sandbox 重试一次${this.launchIdentity}`,
    );
    this.start();
    return true;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    // 指数退避（750ms 起 2x，封顶 30s）+ 熔断（连续崩溃 12 次约 3 分钟后停止重启）；两个阈值都可配
    // （DSH_PET_RESTART_BASE_MS / DSH_PET_RESTART_MAX_FAILURES），稳定运行 ≥3 分钟清零。
    if (helperRunIsStable(Date.now() - this.lastStartAt)) {
      this.restartFailures = 0;
    } else {
      this.restartFailures += 1;
    }
    if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
      // 熔断是用户最后一次能看见的机会：只说「熔断」和 Linux 的 DISPLAY 建议，等于让 Windows 用户
      // 既不知道死的是哪个版本，也拿不到能照着做的下一步（#244 的现场）。
      this.logger.error?.(
        `dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, ` +
          `no more restarts${this.launchIdentity} · 建议：${crashLoopAdvice(process.platform)}`,
      );
      return;
    }
    const base = this.resolveRestartBaseMs();
    // 计数是「已经崩了几次」（1 起），延迟要按「第几次重试」（0 起）取，故减 1：首次崩溃等 base。
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
