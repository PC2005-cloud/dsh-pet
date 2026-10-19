/**
 * 播放回执（playback receipt）的**纯逻辑层**：播放记录表 + 状态机 + 等待者。
 *
 * 背景（issue #122 第 3 项）：`POST /anim` 的**受理成功不能当作"视频已经播完"**。
 * 第三方插件点播一段动画后，需要知道它到底播完了、失败了、还是被打断了——而
 * **只有真正在播的那一端（浏览器 / 桌面渲染进程）才知道真相**：host 只知道"我受理了"。
 *
 * 所以本模块记录的是**由渲染端上报驱动**的状态，而不是 host 的猜测。为什么不能猜：
 * 读视频时长再起个定时器是错的——加载失败时根本没开始播，定时器却会照常走到"播完"；
 * 被新动画顶掉时，旧的也不会正常结束。
 *
 * 为什么单独一层：状态机与等待语义必须能脱离 HTTP 与真实时钟被单测
 * （同 ./anim.ts 的分层口径——路由层只做解析与应答，判定全在这里）。
 *
 * 三个概念：
 *   - **记录**（PlaybackRecord）：一次点播的一生。受理时创建（accepted），终态后保留
 *     PLAYBACK_KEEP_MS 再清理（让调用方来得及查到最后状态）。
 *   - **状态机**：accepted → playing → ended / failed / cancelled。**终态不可再变**
 *     （迟到的 ended 不许覆盖 cancelled），同状态重复上报也忽略——上报是幂等的。
 *   - **等待者**（waiter）：`GET /playback/{id}?wait=…&timeout=…` 挂起的查询。状态进入
 *     它等的集合就立刻唤醒（matched=true）；到点还没进入就用当时的记录唤醒（matched=false）。
 *     `wait` 支持逗号列表，因为终态有三个：只等 ended 会在失败时白等一整个 timeout。
 *
 * 与 /state 无关：播放记录是**per-caller 资源**（只有发起那次点播的调用方关心、有生命周期、
 * 数量随第三方调用方增长），放进 1s 全局广播会让每个窗口为每个功能付流量。见 host/index.ts 的路由说明。
 *
 * 时间：等待超时用 setTimeout（单测用 node:test 的 mock timers 控制）；其余时间戳走 Date.now()。
 * 注意：这里用**裸 setTimeout**（不 import node:timers）——具名导入会在加载时固定住原函数引用，
 * 单测的 mock timers 就拦不到了（同 index.ts 里定时器的写法）。
 */

/** 播放状态。`accepted` 由 host 写（受理），其余由渲染端上报。 */
export type PlaybackStatus = 'accepted' | 'playing' | 'ended' | 'failed' | 'cancelled';

/** 终态：到达后不可再变 */
export const TERMINAL_STATUSES: readonly PlaybackStatus[] = ['ended', 'failed', 'cancelled'];

/** 渲染端允许上报的状态（accepted 是 host 的受理态，渲染端不许写） */
export const REPORTABLE_STATUSES: readonly PlaybackStatus[] = ['playing', 'ended', 'failed', 'cancelled'];

/** 终态记录保留时长（ms）：让调用方来得及查到最后状态，之后清理（与 host/index.ts 的 TERMINAL_KEEP_MS 同口径） */
export const PLAYBACK_KEEP_MS = 60 * 1000;

/**
 * `?timeout=` 上限（ms）：挂起等待的封顶时长，防止调用方把连接挂死。
 * 取值偏保守：DSH WebServer 是否对长期持有的响应设了空闲超时**尚未核实**，
 * 先压在 10s（请求量已比 200ms 轮询省 50 倍），核实后可以再调大。
 */
export const MAX_PLAYBACK_WAIT_MS = 10 * 1000;

/** 终态判定用集合 */
const TERMINAL = new Set<string>(TERMINAL_STATUSES);
/** 可上报判定用集合 */
const REPORTABLE = new Set<string>(REPORTABLE_STATUSES);

/** 该状态是不是终态 */
export const isTerminalStatus = (s: string): boolean => TERMINAL.has(s);

/** 该字符串是不是合法状态名（含 host 侧的 accepted）——`?wait=` 的合法性校验用它 */
export const isPlaybackStatus = (s: string): boolean => s === 'accepted' || REPORTABLE.has(s);

/** 该状态是否允许渲染端上报 */
export const isReportableStatus = (s: string): boolean => REPORTABLE.has(s);

/**
 * 路径解析：`playback/<id>`（查询）与 `playback/<id>/report`（上报）。
 *
 * 正则**两端锚定**：只认这两种形状，其余（`playback/`、`playback/a/b`、`playbackx/a`）一律返回
 * undefined，交给下游 thumb/font/pic 分支按各自口径报错——绝不在这里"尽力猜一个 id"。
 */
export function parsePlaybackPath(rest: string): { playbackId: string; isReport: boolean } | undefined {
  const m = /^playback\/([^/]+)(\/report)?$/.exec(rest);
  if (!m) return undefined;
  return { playbackId: m[1] ?? '', isReport: m[2] === '/report' };
}

/** `?wait=&timeout=` 的解析结论 */
export type WaitParse =
  /** 两者都没传 → 立刻返回（兜底 / 调试 / 只想知道当下状态） */
  | { kind: 'none' }
  /** 挂起等待 */
  | { kind: 'ok'; wait: PlaybackStatus[]; timeoutMs: number }
  /** 参数非法 → 路由回 400（附明确原因，不静默兜底） */
  | { kind: 'error'; error: string };

/**
 * 解析 `?wait=<状态[,状态]>` + `?timeout=<ms>`。
 *
 * - **成对必填**：只填 wait 会无限挂住，只填 timeout 等于没说要等什么——都显式报错。
 * - wait 支持**逗号列表**：终态有三个（ended/failed/cancelled），只等 ended 会在失败时
 *   白等一整个 timeout，所以让调用方自己说清在等哪些。
 * - timeout 只接受 `0..MAX_PLAYBACK_WAIT_MS` 的**非负整数**；`0` 合法（下一拍立刻返回）。
 *   负数 / 小数 / 非数字 / 超上限一律非法。
 */
export function parseWaitQuery(waitRaw: string | null, timeoutRaw: string | null): WaitParse {
  if (waitRaw === null && timeoutRaw === null) return { kind: 'none' };
  if (waitRaw === null || timeoutRaw === null) {
    return { kind: 'error', error: 'wait and timeout must be used together' };
  }
  const wait = waitRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const bad = wait.find((s) => !isPlaybackStatus(s));
  if (wait.length === 0 || bad !== undefined) {
    return { kind: 'error', error: `invalid wait status: ${bad ?? waitRaw}` };
  }
  if (!/^\d+$/.test(timeoutRaw)) {
    return { kind: 'error', error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})` };
  }
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_PLAYBACK_WAIT_MS) {
    return { kind: 'error', error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})` };
  }
  // 逐项过 isPlaybackStatus 之后才收窄：wait 是外部输入，不能靠调用方守规矩
  return { kind: 'ok', wait: wait as PlaybackStatus[], timeoutMs };
}

/** 一次点播的记录（`GET /playback/{id}` 的响应体即它的浅拷贝 + `matched`） */
export interface PlaybackRecord {
  playbackId: string;
  /** 目标宠物实例 id */
  petId: string;
  /** 这一次点播的标识：`name` 形态是动画名（名字即文件名，与 /anim 的白名单同源），
   *  `url` 形态就是那个地址。**纯记录**，不参与任何判定。 */
  name: string;
  status: PlaybackStatus;
  createdAt: number;
  updatedAt: number;
  /** 进入 ended 的时刻（只有 ended 带；failed / cancelled 看 updatedAt） */
  endedAt?: number;
  /** 失败 / 被打断的原因（只有 failed / cancelled 带） */
  reason?: string;
}

/** report 的结论（路由据此决定 HTTP 状态码） */
export type ReportOutcome =
  /** 状态已更新（可能唤醒了等待者） */
  | 'ok'
  /** 幂等：终态之后的上报、或与当前状态相同的上报 → 200 但不改 */
  | 'ignored'
  /** 编号不存在 / 已过期 → 404 */
  | 'unknown'
  /** 非法状态名（含渲染端不许写的 accepted）→ 400 */
  | 'invalid';

/**
 * 一个挂起的等待者。
 * `record` 持的是**活对象引用**：记录即使在等待期间被清理，它读到的仍是最终值——
 * 所以超时唤醒时永远有东西可回，不需要另存快照。
 */
interface Waiter {
  /** 等这些状态之一 */
  readonly wait: ReadonlySet<string>;
  readonly onWake: (record: PlaybackRecord, matched: boolean) => void;
  readonly record: PlaybackRecord;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** 等待注册参数 */
export interface WaitArgs {
  playbackId: string;
  /** 等这些状态之一（非空；由路由先校验合法性） */
  wait: readonly string[];
  /** 超时毫秒数；0 = 下一拍立刻唤醒（等价"立刻返回"） */
  timeoutMs: number;
  /** 唤醒回调：matched=true 表示等到了，false 表示超时/取消/记录被清理 */
  onWake: (record: PlaybackRecord, matched: boolean) => void;
}

/**
 * 播放记录表（一个插件实例一个；进程内内存态，宿主重启即空——编号只保证一次运行内唯一）。
 *
 * 线程模型：单线程事件循环，所有方法同步完成，不存在竞态；唤醒回调在**方法返回之后**
 * 才可能被调用（setTimeout 的回调），所以调用方可以放心在回调里再调本表的方法。
 */
export class PlaybackStore {
  // 用 declare + 构造器赋值（**不用类字段初始化器**）：类字段会降级出
  // @oxc-project/runtime 外部 helper，而它是未声明的依赖，会被 prepack 门禁拦下
  // （同 ./state.ts 的 PollStateStore 与 ./helper-process.ts 的约定——用初始化器时
  //  构建会报 UNRESOLVED_IMPORT 警告）。
  declare private readonly records: Map<string, PlaybackRecord>;
  declare private readonly waiters: Map<string, Set<Waiter>>;
  /**
   * 每只宠物**当前未终态**的那一场。
   * `pets.<id>.anim` 是单叶子（同一宠物同时只有一场点播），所以新点播受理时
   * 直接把上一场标成 cancelled/superseded——这是确定性事实，不必等渲染端上报。
   */
  declare private readonly activeByPet: Map<string, string>;
  /** 编号自增段（与时间戳一起构成运行内唯一编号） */
  declare private seq: number;

  constructor() {
    this.records = new Map();
    this.waiters = new Map();
    this.activeByPet = new Map();
    this.seq = 0;
  }

  /**
   * 受理一次点播：建记录（accepted），并把该宠物上一场（若仍在非终态）标为 cancelled/superseded。
   * @returns 新建的记录（调用方取 playbackId 下发给调用方）
   */
  create(petId: string, name: string): PlaybackRecord {
    this.sweep();
    const prev = this.activeByPet.get(petId);
    if (prev !== undefined) this.finish(prev, 'cancelled', 'superseded');
    const now = Date.now();
    const record: PlaybackRecord = {
      playbackId: 'pb-' + now.toString(36) + '-' + (++this.seq).toString(36),
      petId,
      name,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.playbackId, record);
    this.activeByPet.set(petId, record.playbackId);
    return record;
  }

  /** 查记录；不存在 / 已过期 → undefined（路由回 404） */
  get(playbackId: string): PlaybackRecord | undefined {
    this.sweep();
    return this.records.get(playbackId);
  }

  /**
   * 渲染端上报一次状态。
   *
   * 幂等与终态保护：**终态之后的上报一律 ignored**（迟到的 ended 不许覆盖 cancelled），
   * 与当前状态相同的上报同样 ignored。两种情况路由都回 200——对上报方来说"已经这样了"就是成功。
   */
  report(playbackId: string, status: unknown, reason?: unknown): ReportOutcome {
    this.sweep();
    const record = this.records.get(playbackId);
    if (!record) return 'unknown';
    const next = typeof status === 'string' ? status : '';
    if (!isReportableStatus(next)) return 'invalid';
    if (isTerminalStatus(record.status) || record.status === next) return 'ignored';
    const why = typeof reason === 'string' && reason !== '' ? reason : undefined;
    this.finish(playbackId, next as PlaybackStatus, why);
    return 'ok';
  }

  /**
   * 挂起一个等待者。
   * @returns 取消函数；编号不存在时返回 **undefined**（路由据此立刻回 404，不挂）
   */
  wait(args: WaitArgs): (() => void) | undefined {
    this.sweep();
    const record = this.records.get(args.playbackId);
    if (!record) return undefined;
    const waiter: Waiter = {
      wait: new Set(args.wait),
      onWake: args.onWake,
      record,
      timer: undefined,
    };
    let set = this.waiters.get(args.playbackId);
    if (!set) {
      set = new Set();
      this.waiters.set(args.playbackId, set);
    }
    set.add(waiter);
    // timeoutMs = 0 → 下一拍立刻唤醒（等价"立刻返回"，不需要路由特判）
    waiter.timer = setTimeout(
      () => {
        this.dropWaiter(args.playbackId, waiter);
        waiter.onWake(waiter.record, false);
      },
      Math.max(0, args.timeoutMs),
    );
    // 不让这个定时器把宿主进程钉住（宿主退出时不该等它）
    waiter.timer.unref?.();
    return () => this.dropWaiter(args.playbackId, waiter);
  }

  /**
   * 结束**所有**挂起的等待（插件卸载 / 宿主退出路径）。
   * 唤醒时 matched=false：调用方据此立刻收尾，而不是留一个悬挂的响应。
   */
  cancelAll(): void {
    for (const [playbackId, set] of [...this.waiters]) {
      for (const waiter of [...set]) {
        this.dropWaiter(playbackId, waiter);
        waiter.onWake(waiter.record, false);
      }
    }
  }

  /**
   * 清理过期终态记录（惰性调用：create / get / report 各调一次，记录数很少，成本可忽略）。
   *
   * **必须先把还在等它的人叫醒**：等待上限（10s）通常远小于保留时长（60s），但调用方完全可以在
   * 一条终态记录的保留窗口末尾注册一个等"别的状态"的等待者——那种情况下记录会被清理，
   * 不唤醒就成了永远等不到的悬挂等待者。
   *
   * @param now 注入时间（单测用；缺省取当前时刻）
   */
  sweep(now: number = Date.now()): void {
    for (const [playbackId, record] of this.records) {
      if (!isTerminalStatus(record.status)) continue;
      if (now - record.updatedAt < PLAYBACK_KEEP_MS) continue;
      const set = this.waiters.get(playbackId);
      if (set) {
        for (const waiter of [...set]) {
          this.dropWaiter(playbackId, waiter);
          waiter.onWake(waiter.record, false);
        }
      }
      this.records.delete(playbackId);
    }
  }

  /** 当前记录数（测试 / 观测用） */
  count(): number {
    return this.records.size;
  }

  /** 当前等待者数（测试 / 观测用：验证不泄漏） */
  waiterCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }

  /**
   * 落到一个终态：写状态、更新时间、摘掉"当前活跃"、唤醒在等这个状态的人。
   * 唯一的状态写入点——等待者唤醒只在这里发生（不需要 diff、不需要比对）。
   */
  private finish(playbackId: string, status: PlaybackStatus, reason?: string): void {
    const record = this.records.get(playbackId);
    if (!record) return;
    record.status = status;
    record.updatedAt = Date.now();
    if (status === 'ended') record.endedAt = record.updatedAt;
    if (reason !== undefined) record.reason = reason;
    if (this.activeByPet.get(record.petId) === playbackId) this.activeByPet.delete(record.petId);
    const set = this.waiters.get(playbackId);
    if (!set) return;
    for (const waiter of [...set]) {
      if (!waiter.wait.has(status)) continue; // 没在等这个状态：继续挂着
      this.dropWaiter(playbackId, waiter);
      waiter.onWake(waiter.record, true);
    }
  }

  /** 摘掉一个等待者（清定时器 + 从集合移除 + 空集合回收） */
  private dropWaiter(playbackId: string, waiter: Waiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    const set = this.waiters.get(playbackId);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) this.waiters.delete(playbackId);
  }
}
