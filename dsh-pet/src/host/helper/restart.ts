/**
 * 重启策略：退避间隔、熔断条件、「跑稳了没有」的判定，以及崩溃现场的可读化（退出码含义与处理建议）。
 *
 * 不启动也不停止进程，只给 ./child 提供纯计算的决策与文案。
 * 必须始终成立：退避单调不减，熔断后不再自动重试。
 * @module dsh-pet/src/host/helper/restart
 */

/** 停止 helper 的等待上限（ms）：超过就升级 SIGKILL。 */
export const HELPER_STOP_TIMEOUT_MS = 3000;

/** SIGKILL 之后还给进程多久退出（ms）；到点仍未退出就放弃等待，绝不无限挂住调用方。 */
export const HELPER_STOP_GRACE_MS = 1000;

/** 稳定运行判定阈值：Helper 连续无崩溃运行 ≥ 3 分钟后，重启失败计数清零。 */
export const HELPER_STABLE_MS = 3 * 60 * 1000;

/**
 * 指数退避：第 n 次（0 起）失败后等待 base × 2ⁿ，封顶 30s。
 * 默认 base 750ms，序列 750 → 1500 → 3000 → … → 30000。
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

/** Windows NTSTATUS 退出码 → 中文短语；只收「进程被系统当场终止」这一类，其余不收录。 */
const WINDOWS_EXIT_MEANINGS: Readonly<Record<number, string>> = {
  0xc0000005: '访问违例',
  0x80000003: '断点（沙箱初始化失败）',
  0xc0000135: '缺少 DLL',
  0xc0000142: 'DLL 初始化失败',
};

/**
 * 把子进程退出码翻成一句人话。
 *
 * 只认 Windows 的 NTSTATUS 形态（无符号值 ≥ 0x80000000）：POSIX 退出码只有 0–255，不会撞上这张表。
 * 入参同时认 Node 的两种报法——`3221225477` 与 `-1073741819` 指向同一个 `0xC0000005`。
 * @param code - 子进程退出码；null 表示被信号终止。
 * @returns 中文短语；未收录或 code 为 null 时返回 undefined。
 */
function explainExitCode(code: number | null): string | undefined {
  if (code === null) return undefined;
  return WINDOWS_EXIT_MEANINGS[code >>> 0];
}

/**
 * 拼一段「退出状态」日志片段：`code=3221225477 (0xC0000005 访问违例), signal=null`。
 *
 * 十六进制形态与含义只在这里出现一次，崩溃日志与熔断日志共用，避免两处各拼一份而漂移。
 * @param code - 退出码；null 表示被信号终止。
 * @param signal - 终止信号；正常退出为 null。
 * @returns 可直接拼进日志的一行文本。
 */
export function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return `code=${String(code)}${describeCodeDetail(code)}, signal=${String(signal)}`;
}

/** 退出码的括号说明：形态像 NTSTATUS 才补十六进制，含义未收录时只留十六进制。 */
function describeCodeDetail(code: number | null): string {
  if (code === null) return '';
  const unsigned = code >>> 0;
  if (unsigned < 0x80000000) return '';
  const hex = `0x${unsigned.toString(16).toUpperCase()}`;
  const meaning = explainExitCode(code);
  return ` (${meaning ? `${hex} ${meaning}` : hex})`;
}

/**
 * 熔断时给用户的处理建议。
 *
 * Windows 与 Linux 的病因完全不同：Windows 上「配置 DISPLAY」是无效建议（曾误导过装了虚拟显示器的用户），
 * 能起作用的只有换运行时或指向现成的可执行文件；Linux 才谈显示环境。
 * @param platform - 进程平台；由调用方传入，本函数不读全局。
 * @returns 一句面向用户的建议文本（含可复制的环境变量名）。
 */
export function crashLoopAdvice(platform: NodeJS.Platform): string {
  const raise = '或设 DSH_PET_RESTART_MAX_FAILURES 提高重试上限后重启。';
  if (platform === 'win32') {
    return (
      '换一个 Electron 版本（删掉日志里 electron= 指向的目录，用 DSH_PET_ELECTRON_VERSION 指定可用版本后重启），' +
      `或用 DSH_PET_ELECTRON_PATH 指向本机能开窗的 electron.exe；${raise}`
    );
  }
  if (platform === 'linux') {
    return `确认有可用显示环境（DISPLAY / WAYLAND_DISPLAY，无显示时用 Xvfb 并设 DSH_PET_DESKTOP_FORCE=1）；${raise}`;
  }
  return `用 DSH_PET_ELECTRON_PATH 指向本机能开窗的 Electron；${raise}`;
}

/**
 * 沙箱初始化失败时 Electron 浏览器进程的退出码：0x80000003（STATUS_BREAKPOINT）。
 * Node 在 win32 上按无符号报 2147483651，在别的写法下也可能是 -2147483645，故判定一律先 `>>> 0`。
 */
export const SANDBOX_INIT_FAILED_CODE = 0x80000003;

/** 只有在这个时间窗内秒退、且一行输出都没有时，才把退出当成「沙箱起不来」。 */
export const SANDBOX_FALLBACK_WINDOW_MS = 5000;

/**
 * 是否值得改用 `--no-sandbox` 重试一次。
 *
 * 背景：Chromium 沙箱在部分 Windows 环境里初始化失败（受限令牌、宿主 job 对象、安全软件注入等），
 * 浏览器进程在跑任何 JS 之前就以 STATUS_BREAKPOINT 退出：宿主侧只有一行「exited」、没有 stderr，
 * 用户看到的现象是「桌宠永远不出现」。同一台机器上加 `--no-sandbox` 就能正常开窗，所以值得自动退一次。
 *
 * 判定必须收紧，否则会把真正的崩溃吞成「换参数」：
 * ① 退出码是 0x80000003；② stdout/stderr 一行都没有（有输出说明 JS 已经跑过，病因不是沙箱）；
 * ③ 拉起后 5s 内就退（跑了一阵才崩是别的问题）；④ 只试一次，失败后回到正常退避/熔断；
 * ⑤ 调用方给了自定义 command 时不猜（那多半是测试或用户脚本，不是真正的 Electron）。
 * @param input - 本次退出的现场：退出码、有无输出、存活时长、是否已经退过一次、是否自定义命令。
 * @returns true 表示下一次 start() 应在参数最前面加 `--no-sandbox`。
 */
export function shouldFallbackToNoSandbox(input: {
  code: number | null;
  sawOutput: boolean;
  ranMs: number;
  alreadyApplied: boolean;
  customCommand: boolean;
}): boolean {
  if (input.alreadyApplied || input.customCommand) return false;
  if (input.code === null || (input.code >>> 0) !== SANDBOX_INIT_FAILED_CODE) return false;
  if (input.sawOutput) return false;
  return input.ranMs < SANDBOX_FALLBACK_WINDOW_MS;
}

/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_PET_RESTART_BASE_MS 可调。 */
export const RESTART_BASE_MS_DEFAULT = 750;

/** 熔断阈值（连续崩溃次数）：默认 12，DSH_PET_RESTART_MAX_FAILURES 可调。 */
export const RESTART_MAX_FAILURES_DEFAULT = 12;

/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
export function envPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 等子进程真正退出：已经退出（exitCode / signalCode 有值）→ 立即 resolve，不挂监听；只等 `exit`，
 * `close` 只代表 stdio 管道关闭，远早于进程真正退出；到 timeoutMs 调 onTimeout()（调用方升级
 * SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；宽限到点仍未退出就 resolve——调用方绝不能被无限挂住。
 */
export function waitForChildExit(
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
