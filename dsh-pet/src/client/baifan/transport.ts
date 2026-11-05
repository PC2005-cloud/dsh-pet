/**
 * 「吃白饭」的传输层：调 dsh-pet 的接口、等点播回执、读页面内实况。
 *
 * 业务失败一律 HTTP 200 + `ok: false`，所以这里不抛；只有网络层失败（断连 / 被 abort）才抛。
 * 每次请求都带超时并挂在演出自己的 AbortSignal 上——收场时把挂在半路的请求一刀切断，
 * 否则一次卡死会让 running 永远为 true，再点菜单只会回「它已经在吃了」，而锁还挂在宿主里。
 * @module dsh-pet/src/client/baifan/transport
 */
import { CFG, ROUTE } from './constants.ts';

/** 点播回执的终态。 */
export interface PlaybackEnd {
  /** 终态：正常播完 / 播放失败 / 被顶掉。 */
  status: 'ended' | 'failed' | 'cancelled' | 'timeout' | 'gone';
  /** 失败原因（status 为 failed 时）。 */
  reason?: string;
}

/** 页面内实况读数（`petApi7340` 的子集）。 */
interface PoseApi {
  /** 读一只宠物的归一化中心点与朝向。 */
  pose?: (petId: string) => { x: number; y: number; facing: 'left' | 'right' } | null;
  /** 读当前点播的播放进度。 */
  progress?: (petId: string) => {
    playbackId: string | null;
    currentTime: number;
    duration: number;
    paused: boolean;
    /** 当前点播的素材地址（url 形态下就是那段地址）。 */
    anim?: string;
  } | null;
}

/**
 * 造传输层。
 *
 * @param ctx - 客户端上下文；只用来取 `petApi7340` 这个只读服务。
 * @returns 接口调用与读数方法；`attach` 用来把本场演出的取消信号挂上去。
 */
export function createTransport(ctx: { get: (name: string) => unknown }) {
  /** 本场演出的取消信号；收场时由 attach(null) 换成 null 并 abort 旧的。 */
  let scene: AbortController | null = null;

  /** 页面内只读服务；老版本 dsh-pet 没有它，调用点按「这一页没有宠物」处理。 */
  function api(): PoseApi | undefined {
    return ctx.get('petApi7340') as PoseApi | undefined;
  }

  /**
   * 调一次接口。
   *
   * @param method - HTTP 方法。
   * @param path - 含查询串的路径。
   * @param body - 有则按 JSON 发。
   * @param signal - 覆盖演出信号的取消信号（一般不用）。
   * @returns 解析后的响应体；解析失败时 `ok: false`。
   */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    const effective = signal ?? scene?.signal;
    if (effective !== undefined) {
      if (effective.aborted) controller.abort();
      else effective.addEventListener('abort', forward, { once: true });
    }
    const timer = window.setTimeout(() => controller.abort(), CFG.httpTimeoutMs);
    init.signal = controller.signal;
    try {
      const res = await fetch(ROUTE + path, init);
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: 'bad-response' };
      }
    } finally {
      window.clearTimeout(timer);
      if (effective !== undefined) effective.removeEventListener('abort', forward);
    }
  }

  /** 读实况（同页零请求）；拿不到服务或没这样宠物时返回 null。 */
  function pose(petId: string): { x: number; y: number; facing: 'left' | 'right' } | null {
    const read = api()?.pose;
    if (typeof read !== 'function') return null;
    try {
      return read.call(api(), petId);
    } catch {
      return null;
    }
  }

  /** 读当前播放进度；页面内服务缺失时返回 null。 */
  function progress(petId: string): {
    playbackId: string | null;
    currentTime: number;
    duration: number;
    paused: boolean;
    anim?: string;
  } | null {
    const read = api()?.progress;
    if (typeof read !== 'function') return null;
    try {
      return read.call(api(), petId);
    } catch {
      return null;
    }
  }

  /**
   * 等一次点播走到终态。
   *
   * `POST /anim` 的 ok 只代表受理：素材没拿到、解码失败、被新点播顶掉、被锁冻住，都可能让它
   * 根本没播完。真正的结束只有渲染端上报的回执知道，所以挂 GET /playback/{id} 等三个终态；
   * 单次 timeout 上限 10 秒，套一层循环把总预算拉长。
   *
   * @param id - 点播编号；null 表示这次点播根本没受理。
   * @returns 终态。
   */
  async function waitPlayback(id: string | null): Promise<PlaybackEnd> {
    if (id === null) return { status: 'gone' };
    const deadline = performance.now() + CFG.waitBudgetMs;
    for (;;) {
      const left = deadline - performance.now();
      if (left <= 0) return { status: 'timeout' };
      let r: Record<string, unknown>;
      try {
        r = await call(
          'GET',
          '/playback/' +
            encodeURIComponent(id) +
            '?wait=ended,failed,cancelled&timeout=' +
            Math.min(10000, Math.round(left)),
        );
      } catch {
        return { status: 'gone' };
      }
      // 记录过期（60 秒后清理）回 { error: 'unknown playback' }
      if (r.error !== undefined) return { status: 'gone' };
      if (r.status === 'ended' || r.status === 'failed' || r.status === 'cancelled') {
        return { status: r.status, reason: typeof r.reason === 'string' ? r.reason : undefined };
      }
    }
  }

  return {
    /** 换本场演出的取消信号；传 null 表示收场（并 abort 旧的那一个）。 */
    attach: (next: AbortController | null): void => {
      scene?.abort();
      scene = next;
    },
    call,
    pose,
    progress,
    waitPlayback,
  };
}

/** 传输层的公开面。 */
export type Transport = ReturnType<typeof createTransport>;
