/**
 * 轮询状态（host 半侧）：`GET /state` 的唯一数据源，全局段 + 每宠物叶子 + 长轮询等待者都在这里。
 *
 * 不负责渲染侧比对：拉取、拍平、按 counter 决定是否渲染在 src/shared/state.ts。
 * 不 import src/shared（DSH 单文件加载约束），状态形状因此与共享层各写一份。
 * 依赖无；进程内内存态，宿主重启即空。
 * 始终成立：每次写入都必须推进 counter，且只能经 writeSection / writePet 写。
 * 契约见 API.md 的「state 详解」与 openapi.yaml。
 *
 * @module dsh-pet/src/host/state
 */

/** 一个叶子：计数器 + 载荷（data 为 null 表示还没有数据）。 */
export interface StateLeaf {
  counter: number;
  data: unknown;
}

/** 全局段（所有端共享一份）。
 *  `config` 是纯信号叶子：data 恒为 {}，消费端只看 counter 变了就去重拉 GET /config——配置本体太大，
 *  不能塞进每秒一次的 /state。当前只有 POST /pet-display 写它：桌面端右键改显示位置时，浏览器
 *  页面不是发起方，只能靠这个信号知道配置被别处改过；保存 / 同步配置的调用方自己拿到了成品聚合，
 *  所以不写。 */
export type SectionName = 'balance' | 'workStatus' | 'notify' | 'config' | 'menu' | 'focusSession';

/** 每宠物段（say = 要说的话；anim = 要播的动画名；position = 要挪到的位置；throw = 要给的初速度；
 *  lock = 占用锁状态；sleep = 睡觉状态）。
 *  say / anim / position / throw 是 host → 前端的指令：前端读到即执行，不往它们写任何东西。
 *  `lock` / `sleep` 是状态不是指令：前端读它决定要不要冻结或播睡姿，并按叶子里的值自己收尾——
 *  宿主侧没有定时器（见 ./lock、./sleep）。 */
export type PetLeafName = 'say' | 'anim' | 'position' | 'throw' | 'lock' | 'sleep';

/** S 的完整形态（GET /state 的响应体）。
 *  `counter` 是整份 S 的版本号 = 最后一次写入的编号，顶层而非叶子：调用方拿它当 `?since=` 回传。 */
export interface PollState {
  counter: number;
  sections: Record<SectionName, StateLeaf>;
  pets: Record<string, Record<PetLeafName, StateLeaf>>;
}

/** `?timeout=` 上限（ms）：挂起等待的封顶时长，防止调用方把连接挂死。
 *  与 ./playback 的 MAX_PLAYBACK_WAIT_MS 同值同因：DSH WebServer 是否对长期持有的响应设了空闲超时
 *  尚未核实，先压在 10s；核实后两处一起调。 */
export const MAX_STATE_WAIT_MS = 10 * 1000;

/** `?since=&timeout=` 的解析结论。 */
export type StateWaitParse =
  /** 两者都没传 → 立刻返回当前状态。 */
  | { kind: 'none' }
  /** 挂起等待。 */
  | { kind: 'ok'; since: number; timeoutMs: number }
  /** 参数非法 → 路由回 400（附明确原因，不静默兜底）。 */
  | { kind: 'error'; error: string };

/**
 * 解析 `?since=<版本号>` 与 `?timeout=<ms>`（成对必填，规则见 openapi.yaml）。
 *
 * since 是非负整数，`0` 合法（首次接入的调用方用它表示「我手里什么都没有」）；
 * timeout 只接受 0..MAX_STATE_WAIT_MS 的非负整数，`0` 合法（下一拍立刻返回）。
 */
export function parseStateWaitQuery(sinceRaw: string | null, timeoutRaw: string | null): StateWaitParse {
  if (sinceRaw === null && timeoutRaw === null) return { kind: 'none' };
  if (sinceRaw === null || timeoutRaw === null) {
    return { kind: 'error', error: 'since and timeout must be used together' };
  }
  if (!/^\d+$/.test(sinceRaw)) return { kind: 'error', error: 'invalid since (expect a non-negative integer)' };
  if (!/^\d+$/.test(timeoutRaw)) {
    return { kind: 'error', error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})` };
  }
  const since = Number(sinceRaw);
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(since)) return { kind: 'error', error: 'invalid since (expect a non-negative integer)' };
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_STATE_WAIT_MS) {
    return { kind: 'error', error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})` };
  }
  return { kind: 'ok', since, timeoutMs };
}

/** 空叶子：counter=0 表示从未写过——前端首拉把它当基线，之后 counter 变化才渲染。 */
const emptyLeaf = (): StateLeaf => ({ counter: 0, data: null });

/** 一个挂起的等待者。只等一个条件：`last` 变得不等于 `since`。 */
interface Waiter {
  /** 调用方手里那份状态的版本号。 */
  readonly since: number;
  /** 唤醒回调：等到变化 / 超时 / 被取消都走它（三者对调用方是同一件事：去读最新状态）。 */
  readonly onWake: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** 轮询统一状态存储（一个插件实例一个；进程内内存态，重启即空）。 */
export class PollStateStore {
  // 用 declare + 构造器赋值：类字段初始化器会降级出 @oxc-project/runtime 外部 helper，
  // 而它是未声明的依赖，会被 prepack 门禁拦下（同 ./playback、./lock、./helper-process 的约定）。
  /** 严格递增的计数器种子（保证同一毫秒内连写两次也拿到不同的 counter）。 */
  declare private last: number;
  declare private readonly sections: Record<SectionName, StateLeaf>;
  declare private readonly pets: Map<string, Record<PetLeafName, StateLeaf>>;
  /** 挂起的等待者。全局集合：任意叶子被写过都唤醒他们——一次写入唤醒所有人是有意的，
   *  换的是实现的简单（桌面一窗一宠，会按窗口数放大）。 */
  declare private readonly waiters: Set<Waiter>;

  constructor() {
    this.last = 0;
    this.sections = {
      balance: emptyLeaf(),
      workStatus: emptyLeaf(),
      notify: emptyLeaf(),
      config: emptyLeaf(),
      // 第三方右键菜单项（src/host/menu 的注册表快照）：第三方注册 / 覆盖菜单时写它，两端据此在
      // 右键菜单里拼出「更多」。data 形状见 shared/menu 的 readMenuItems。
      menu: emptyLeaf(),
      // 桌面宠物点会话气泡后的跳转意图（`POST /focus-session`）：页面据此切会话。
      // 一次性信号：带 ts，消费端据它判重，页面晚于写入加载时仍可重放一次。
      focusSession: emptyLeaf(),
    };
    this.pets = new Map();
    this.waiters = new Set();
  }

  /** 下一个 counter。 */
  private next(): number {
    // 不用 0,1,2… 自增：宿主重启后会归零，而前端手里还存着旧值，比对就永久失效。
    // Date.now() 天然单调、重启也不倒退，同一毫秒的碰撞再用 +1 兜住。
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }

  /**
   * 写一个全局叶子（余额 / 工作状态 / 通知 / 配置变更信号）。
   * 整体替换叶子对象而不是原地改字段：`read()` 拿到的引用因此不会半新半旧。
   */
  writeSection(name: SectionName, data: unknown): void {
    this.sections[name] = { counter: this.next(), data };
    this.wakeWaiters();
  }

  /** 写一只宠物的叶子（宠物条目不存在则自动建立，所有槽位一起建好，形状恒定）。 */
  writePet(petId: string, leaf: PetLeafName, data: unknown): void {
    let entry = this.pets.get(petId);
    if (!entry) {
      entry = {
        say: emptyLeaf(),
        anim: emptyLeaf(),
        position: emptyLeaf(),
        throw: emptyLeaf(),
        lock: emptyLeaf(),
        sleep: emptyLeaf(),
      };
      this.pets.set(petId, entry);
    }
    entry[leaf] = { counter: this.next(), data };
    this.wakeWaiters();
  }

  /**
   * 当前 S（GET /state 的响应体）。
   * sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
   * 所以消费端不会读到写了一半的叶子。
   */
  read(): PollState {
    return { counter: this.last, sections: { ...this.sections }, pets: Object.fromEntries(this.pets) };
  }

  /**
   * 挂起一个等待者：直到 `last` 变得不等于 `since`、或超时、或调用方取消。
   *
   * 三种收尾对调用方是同一件事（去 `read()` 拿最新状态），所以回调不带参数。
   *
   * @returns 取消函数（清掉超时定时器并摘掉等待者）。
   */
  wait(args: { since: number; timeoutMs: number; onWake: () => void }): () => void {
    const waiter: Waiter = { since: args.since, onWake: args.onWake, timer: undefined };
    this.waiters.add(waiter);
    // timeoutMs = 0 → 下一拍立刻唤醒（等价「立刻返回」，路由不需要特判）
    waiter.timer = setTimeout(
      () => {
        this.dropWaiter(waiter);
        waiter.onWake();
      },
      Math.max(0, args.timeoutMs),
    );
    // 不让这个定时器把宿主进程钉住（宿主退出时不该等它；node:test 下保留保持事件循环存活）
    if (process.env.NODE_TEST_CONTEXT === undefined) waiter.timer.unref?.();
    return () => this.dropWaiter(waiter);
  }

  /**
   * 结束所有挂起的等待（插件卸载 / 宿主退出路径）。
   * 唤醒时不给区分标志：调用方据此立刻收尾，而不是留一个悬挂的响应。
   */
  cancelAll(): void {
    for (const waiter of [...this.waiters]) {
      this.dropWaiter(waiter);
      waiter.onWake();
    }
  }

  /** 当前等待者数（测试 / 观测用：验证不泄漏）。 */
  waiterCount(): number {
    return this.waiters.size;
  }

  /**
   * 唤醒所有已经过期的等待者（唯一调用点是两个 write 方法，且必须在叶子写定之后）。
   * `since === this.last` 的跳过：那种等待者已经是最新的，叫醒它等于空转。
   * 必须写在 `this.sections[name] = …` 之后：放在 next() 里会让回调先于赋值执行，调用方读到旧状态。
   */
  private wakeWaiters(): void {
    if (this.waiters.size === 0) return;
    for (const waiter of [...this.waiters]) {
      if (waiter.since === this.last) continue;
      this.dropWaiter(waiter);
      waiter.onWake();
    }
  }

  /** 摘掉一个等待者（清定时器 + 从集合移除）。 */
  private dropWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    this.waiters.delete(waiter);
  }
}
