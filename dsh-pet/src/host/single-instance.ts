/**
 * 单实例唤回 —— 宿主侧纯逻辑（ticket 05，零 I/O、可独立单测）。
 *
 * 打包后的宿主角色（desktop/main.mjs）在 app ready 之前取单实例锁；第二个启动请求由
 * Electron 以 `second-instance` 事件送到第一个实例。唤回动作不重开窗口，而是复用桌面壳
 * 既有的 bridge 回调通道：
 *
 *   helper stdout 协议行（每条都带 cb = http://127.0.0.1:<随机端口>/respond）
 *     → 宿主 HelperProcess 记下 cb 的 origin
 *     → second-instance 时向 `${origin}/control` POST {"action":"focus"}
 *     → 壳遍历 windows Map，把全部宠物窗口唤回前台（见 runtime/electron-helper/control-request.js）
 *
 * 本文件只放能脱离 Electron 测试的部分：端点推导、cb 未就绪时的有限等待、启动时序闸门。
 */

/** 单次等待 cb 的默认上限（ms）：helper 从 spawn 到发出首条请求通常在 2s 内 */
export const FOCUS_WAIT_MS = 2000;
/** 轮询 cb 的默认间隔（ms）：本地 IPC，低频轮询足够 */
export const FOCUS_POLL_MS = 50;

/**
 * 从 helper 请求行的 `cb` 推导控制端点。
 *
 * cb 形如 `http://127.0.0.1:54321/respond`；只用 origin（端口是随机分配的，不能写死），
 * 路径换成 `/control`。非 http(s) 或形状不对的值返回 undefined（例如老版本 helper 未带 cb）。
 */
export function callbackControlUrl(cb: string | undefined): string | undefined {
  if (typeof cb !== 'string' || !/^https?:[/][/]/.test(cb)) return undefined;
  try {
    const { origin } = new URL(cb);
    return origin && origin !== 'null' ? `${origin}/control` : undefined;
  } catch {
    return undefined;
  }
}

export interface FocusWaitOptions {
  /** 等待上限（ms），默认 FOCUS_WAIT_MS */
  waitMs?: number;
  /** 轮询间隔（ms），默认 FOCUS_POLL_MS */
  intervalMs?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
  /** 注入等待（测试用） */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 等待 helper 的 cb 可用（首条 bridge 请求到达后才有值）。
 *
 * 到点仍未出现返回 undefined —— 调用方记一条告警即可，绝不能挂住宿主/退出流程。
 */
export async function waitForControlUrl(
  read: () => string | undefined,
  options: FocusWaitOptions = {},
): Promise<string | undefined> {
  const waitMs = options.waitMs ?? FOCUS_WAIT_MS;
  const intervalMs = options.intervalMs ?? FOCUS_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + waitMs;
  for (;;) {
    const url = read();
    if (url) return url;
    if (now() >= deadline) return undefined;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}

export interface FocusGateOptions {
  /** 真正执行唤回（返回 Promise，失败由 onError 收） */
  focus: () => Promise<unknown>;
  /** 唤回失败的报告出口（默认静默）：主进程据此打一条用户可见的告警 */
  onError?: (error: unknown) => void;
}

export interface FocusGate {
  /** 收到一次二次启动请求：启动未完成则记为 pending，否则立即唤回 */
  request(): void;
  /** 宿主启动完成（服务已监听、helper 已拉起）：执行 pending 并放行后续请求 */
  markReady(): void;
}

/**
 * 启动时序闸门：自启实例可能带数秒延迟（ticket 09），期间用户手动双击也不能把它提前唤出。
 *
 * - `request()` 只在 `markReady()` 之后才真正执行；之前的多次请求合并成一次，
 *   启动完成后补一次唤回（用户双击的意图最终仍然得到响应）；
 * - 失败交给 `onError`，不产生未处理的 Promise 拒绝。
 */
export function createFocusGate(options: FocusGateOptions): FocusGate {
  const onError = options.onError ?? (() => {});
  let ready = false;
  let pending = false;
  const run = (): void => {
    void Promise.resolve()
      .then(() => options.focus())
      .catch(onError);
  };
  return {
    request(): void {
      if (!ready) {
        pending = true;
        return;
      }
      run();
    },
    markReady(): void {
      if (ready) return;
      ready = true;
      if (!pending) return;
      pending = false;
      run();
    },
  };
}
