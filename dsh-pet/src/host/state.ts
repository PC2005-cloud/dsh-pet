/**
 * 轮询统一状态（S）—— host 侧维护的**唯一**「给前端轮询读」的数据源。
 *
 * 背景：改造前有 4 个 1s 轮询端点（/broadcast、/work-status、/notify、/balance/trigger），
 * 浏览器是 N+3 请求/秒、桌面是 3N 请求/秒（一窗一宠，每个窗口各跑一遍），而且每个端点
 * 各写了一套"首拉记基线 / 比对 / 触发"。统一成一个 GET /state 之后：浏览器 1 请求/秒、
 * 桌面 N 请求/秒，前端只剩一份通用的「比对 counter → 渲染」逻辑。
 *
 * 形状：
 *   {
 *     counter: 1755000000007,   // 全局写入版本 = 最后一次写入的编号（顶层，不是叶子）
 *     sections: { balance: {counter,data}, workStatus: {…}, notify: {…}, config: {…} },  // 全局，所有端共享
 *     pets: { <宠物id>: { say: {…}, anim: {…}, position: {…}, throw: {…}, lock: {…} } } // 每只宠物各自一份
 *   }
 *
 * 长轮询（`GET /state?since=&timeout=`）：
 *   顶层 `counter` 就是"整份 S 的版本"。它**天然等于**最后一次写入的编号（`last`）——所有叶子的
 *   counter 都出自同一个 `next()`，全局单点递增，所以 `last` 必定是当前最大的那个版本号。
 *   调用方把它回传成 `since`：与当前不同 → 有东西变了，立刻返回；相同 → 挂起，等到变化或超时。
 *   于是前端不必再 1s 空转（叶子一变立刻收到），而**空闲时的请求率与改造前一致**。
 *   等待者只挂在"任意叶子被写过"这一个条件上，所以是**全局集合**：一次写入唤醒所有人
 *   （桌面是一窗一宠、各自一个轮询循环，因此这里是 N 倍放大——有意为之，换的是实现的简单）。
 *
 * counter 语义（整个设计的地基，改之前先读完这段）：
 *   - **每次写入都必须更新 counter**，前端靠"counter 变了"判断要不要渲染；
 *   - 取值 `Date.now()`，并保证**严格递增**（同一毫秒内连写两次也会 +1）——
 *     用自增计数（0,1,2…）会在宿主重启后归零，而前端手里还存着旧值，对比就永久失效
 *     （现在的 /notify 就是这个毛病：重启后 seq 归零，前端 `seq <= 旧值` 恒成立 → 通知再也不弹）；
 *     Date.now() 天然单调，重启也不会倒退，同一毫秒的碰撞再用 +1 兜住；
 *   - 写入**只能**走 writeSection / writePet，调用方不要自己拼 counter。
 *
 * 本模块是 host 自包含实现（不 import src/shared —— DSH 单文件加载约束）；
 * 浏览器/桌面侧的对应纯逻辑（拉取、拍平、比对）在 src/shared/state.ts。
 */

/** 一个叶子：计数器 + 载荷（data 为 null = 还没有数据） */
export interface StateLeaf {
  counter: number;
  data: unknown;
}

/** 全局段（所有端共享一份）。
 *  `config` 是**纯信号叶子**：`data` 恒为 `{}`，只看 `counter`——它变了就说明配置被写过，
 *  消费端据此重拉 `GET /config`（配置本体太大，不能塞进每秒一次的 /state）。
 *  当前只有 `POST /pet-display` 写它：那是唯一一个**不是发起页面自己**的配置改动
 *  （桌面端右键改显示位置），浏览器端只能靠这个信号知道。
 *  保存 / 同步配置（PUT / POST /config）**不写**——它们的调用方自己就拿到了成品聚合。 */
export type SectionName = 'balance' | 'workStatus' | 'notify' | 'config';

/** 每宠物段（say = 要说的话；anim = 要播的动画名；position = 要挪到的位置；throw = 要给的初速度；
 *  lock = 占用锁状态）。
 *  中间两个是**指令**（host → 前端），与 say/anim 同族：前端读到即执行，不往它们写任何东西。
 *  `lock` 不一样，它是**状态**不是指令：前端读它来决定"要不要冻结自己"（随机链不掷骰、暂停自播），
 *  并**按叶子里的 expiresAt 自己解除**——宿主侧没有定时器（见 ./lock 的第 4 条边界）。 */
export type PetLeafName = 'say' | 'anim' | 'position' | 'throw' | 'lock';

/** S 的完整形态（GET /state 的响应体）。
 *  `counter` = 整份 S 的版本号，就是"最后一次写入的编号"（见类里的 `last`）。
 *  它是**顶层的**、不是叶子：调用方拿它当 `?since=` 回传，用来表达"我手里这份是哪个版本"。 */
export interface PollState {
  counter: number;
  sections: Record<SectionName, StateLeaf>;
  pets: Record<string, Record<PetLeafName, StateLeaf>>;
}

/**
 * `?timeout=` 上限（ms）：挂起等待的封顶时长，防止调用方把连接挂死。
 * 与 ./playback 的 `MAX_PLAYBACK_WAIT_MS` **同值同因**：DSH WebServer 是否对长期持有的响应
 * 设了空闲超时**尚未核实**，先压在 10s。核实后两处一起调。
 */
export const MAX_STATE_WAIT_MS = 10 * 1000;

/** `?since=&timeout=` 的解析结论 */
export type StateWaitParse =
  /** 两者都没传 → 立刻返回（= 改造前的语义，完全兼容） */
  | { kind: 'none' }
  /** 挂起等待 */
  | { kind: 'ok'; since: number; timeoutMs: number }
  /** 参数非法 → 路由回 400（附明确原因，不静默兜底） */
  | { kind: 'error'; error: string };

/**
 * 解析 `?since=<版本号>` + `?timeout=<ms>`。
 *
 * - **成对必填**：只填 since 会无限挂住，只填 timeout 等于没说要等什么——都显式报错
 *   （与 `GET /playback/{id}` 的 `wait`/`timeout` 同一套约定）。
 * - `since` 是**非负整数**（`0` 合法 = "我手里什么都没有"，首次接入的调用方这么用）。
 * - `timeout` 只接受 `0..MAX_STATE_WAIT_MS` 的**非负整数**；`0` 合法（下一拍立刻返回）。
 *   负数 / 小数 / 非数字 / 超上限一律非法。
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

/** 空叶子：counter=0 表示"从未写过"——前端首拉把它当基线，之后 counter 变化才渲染 */
const emptyLeaf = (): StateLeaf => ({ counter: 0, data: null });

/** 一个挂起的等待者（`GET /state?since=&timeout=`）。只等一个条件：`last` 变得不等于 `since`。 */
interface Waiter {
  /** 调用方手里那份状态的版本号 */
  readonly since: number;
  /** 唤醒回调：等到了变化 / 超时 / 被取消都走它（三者对调用方是同一件事：去读最新状态） */
  readonly onWake: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** 轮询统一状态存储（一个插件实例一个；进程内内存态，重启即空） */
export class PollStateStore {
  // 用 declare + 构造器赋值（不用类字段初始化器）：类字段会降级出 @oxc-project/runtime 外部
  // helper，而它是未声明的依赖，会被 prepack 门禁拦下（同 src/host/helper-process.ts 的约定）。
  /** 严格递增的计数器种子（保证同一毫秒内连写两次也拿到不同的 counter） */
  declare private last: number;
  declare private readonly sections: Record<SectionName, StateLeaf>;
  declare private readonly pets: Map<string, Record<PetLeafName, StateLeaf>>;
  /** 挂起的等待者。**全局集合**：任意叶子被写过都唤醒他们（见文件头的放大效应说明） */
  declare private readonly waiters: Set<Waiter>;

  constructor() {
    this.last = 0;
    this.sections = { balance: emptyLeaf(), workStatus: emptyLeaf(), notify: emptyLeaf(), config: emptyLeaf() };
    this.pets = new Map();
    this.waiters = new Set();
  }

  /** 下一个 counter：`Date.now()` 与「上一个 +1」取大——单调、不回退、同毫秒不重复 */
  private next(): number {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }

  /**
   * 写一个全局叶子（余额 / 工作状态 / 通知 / 配置变更信号）。
   * 每次都整体替换叶子对象（不原地改字段），保证 `read()` 拿到的引用不会半新半旧。
   */
  writeSection(name: SectionName, data: unknown): void {
    this.sections[name] = { counter: this.next(), data };
    this.wakeWaiters();
  }

  /** 写一只宠物的叶子（宠物条目不存在则自动建立，**所有槽位一起建好**，形状恒定） */
  writePet(petId: string, leaf: PetLeafName, data: unknown): void {
    let entry = this.pets.get(petId);
    if (!entry) {
      entry = { say: emptyLeaf(), anim: emptyLeaf(), position: emptyLeaf(), throw: emptyLeaf(), lock: emptyLeaf() };
      this.pets.set(petId, entry);
    }
    entry[leaf] = { counter: this.next(), data };
    this.wakeWaiters();
  }

  /**
   * 当前 S（GET /state 的响应体）。
   * 返回的 sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
   * 所以消费端不会读到写了一半的叶子。
   */
  read(): PollState {
    return { counter: this.last, sections: { ...this.sections }, pets: Object.fromEntries(this.pets) };
  }

  /**
   * 挂起一个等待者：直到 `last` 变得不等于 `since`、或超时、或调用方取消。
   *
   * 三种收尾对调用方是同一件事（去 `read()` 拿最新状态），所以回调不带参数——
   * 需要区分"等到了"还是"超时了"的场景并不存在。
   *
   * **唤醒发生在写入落定之后**（见两个 write 方法里 `wakeWaiters()` 的位置）：如果放在
   * `next()` 里，回调会先于 `this.sections[name] = …` 执行，调用方读到的就是**旧状态**。
   *
   * @returns 取消函数（清掉超时定时器并摘掉等待者）
   */
  wait(args: { since: number; timeoutMs: number; onWake: () => void }): () => void {
    const waiter: Waiter = { since: args.since, onWake: args.onWake, timer: undefined };
    this.waiters.add(waiter);
    // timeoutMs = 0 → 下一拍立刻唤醒（等价"立刻返回"，路由不需要特判）
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
   * 结束**所有**挂起的等待（插件卸载 / 宿主退出路径）。
   * 唤醒时不给区分标志：调用方据此立刻收尾，而不是留一个悬挂的响应。
   */
  cancelAll(): void {
    for (const waiter of [...this.waiters]) {
      this.dropWaiter(waiter);
      waiter.onWake();
    }
  }

  /** 当前等待者数（测试 / 观测用：验证不泄漏） */
  waiterCount(): number {
    return this.waiters.size;
  }

  /**
   * 唤醒所有**已经过期**的等待者（唯一调用点是两个 write 方法，且必须在叶子写定之后）。
   * `since === this.last` 的跳过：那种等待者是"已经是最新"的，叫醒它等于空转。
   */
  private wakeWaiters(): void {
    if (this.waiters.size === 0) return;
    for (const waiter of [...this.waiters]) {
      if (waiter.since === this.last) continue;
      this.dropWaiter(waiter);
      waiter.onWake();
    }
  }

  /** 摘掉一个等待者（清定时器 + 从集合移除） */
  private dropWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    this.waiters.delete(waiter);
  }
}
