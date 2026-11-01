/**
 * cookie 探测的取数层：缓存、节流、单飞与让出事件循环。
 *
 * 借句柄要枚举全机句柄表（约 240ms，且是同步阻塞），而右键菜单会被连点，所以 60 秒内复用
 * 上次结果；用户主动要求重探时，两次真实探测也至少隔 5 秒。探测前先 `setTimeout(0)` 让出
 * 一次事件循环，避免这一下阻塞把正在流式输出的会话卡住。
 * 不落盘：第一版没有历史消费方，写文件只会多一份需要维护的状态。
 * @module dsh-pet/src/host/cookie/store
 */
import { probeJar, type CookieProbeResult } from './probe.ts';

/** 结果复用窗口；借句柄太贵，没必要每次点菜单都真读一遍。 */
export const CACHE_MS = 60_000;
/** 两次真实探测的最小间隔：用户连点「立即检测」时也按这个挡。 */
export const MIN_PROBE_GAP_MS = 5_000;

/** 取数口：一条菜单动作只调 {@link CookieGuardStore.inspect}。 */
export interface CookieGuardStore {
  /**
   * 取一次探测结果。
   * @param force - 用户主动要求重探：可穿透 60 秒缓存，但仍受 5 秒最小间隔约束。
   * @returns 探测结论；命中缓存时也是同形结果。
   */
  inspect(force: boolean): Promise<CookieProbeResult>;
}

/** 取数口的可注入依赖：测试用假时钟与假探测，生产用默认值。 */
export interface CookieGuardOptions {
  /** 真正的探测实现；缺省走 {@link probeJar}。 */
  readonly probe?: () => CookieProbeResult;
  /** 时钟；缺省 `Date.now`。 */
  readonly now?: () => number;
  /** 探测前让出事件循环；缺省 `setTimeout(0)`。 */
  readonly yieldToLoop?: () => Promise<void>;
}

/** 默认让出：把这次同步扫描排到当前事件之后。 */
const defaultYield = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * 造取数口。
 *
 * @param options - 依赖注入；不传即生产实现。
 * @returns 带缓存与单飞的取数口。
 */
export function createCookieGuard(options: CookieGuardOptions = {}): CookieGuardStore {
  const probe = options.probe ?? probeJar;
  const now = options.now ?? Date.now;
  const yieldToLoop = options.yieldToLoop ?? defaultYield;

  let cached: { readonly at: number; readonly result: CookieProbeResult } | undefined;
  let pending: Promise<CookieProbeResult> | undefined;

  /** 缓存够不够新：force 只放宽到 5 秒，普通调用放宽到 60 秒。 */
  const reusable = (force: boolean): CookieProbeResult | undefined => {
    if (cached === undefined) return undefined;
    const age = now() - cached.at;
    return age < (force ? MIN_PROBE_GAP_MS : CACHE_MS) ? cached.result : undefined;
  };

  const inspect = async (force: boolean): Promise<CookieProbeResult> => {
    const hit = reusable(force);
    if (hit !== undefined) return hit;
    // 单飞：两次点击撞在一起时只扫一遍句柄表，后来者拿同一个结论。
    if (pending !== undefined) return pending;

    const run = (async (): Promise<CookieProbeResult> => {
      await yieldToLoop();
      const result = probe();
      cached = { at: now(), result };
      return result;
    })();
    pending = run;
    try {
      return await run;
    } finally {
      pending = undefined;
    }
  };

  return { inspect };
}
