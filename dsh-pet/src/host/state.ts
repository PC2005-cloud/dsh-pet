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
 *     sections: { balance: {counter,data}, workStatus: {…}, notify: {…} },  // 全局，所有端共享
 *     pets: { <宠物id>: { say: {counter,data} } }                           // 每只宠物各自一份
 *   }
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

/** 全局段（所有端共享一份） */
export type SectionName = 'balance' | 'workStatus' | 'notify';

/** 每宠物段（say = 要说的话；anim = 要播的动画名） */
export type PetLeafName = 'say' | 'anim';

/** S 的完整形态（GET /state 的响应体） */
export interface PollState {
  sections: Record<SectionName, StateLeaf>;
  pets: Record<string, Record<PetLeafName, StateLeaf>>;
}

/** 空叶子：counter=0 表示"从未写过"——前端首拉把它当基线，之后 counter 变化才渲染 */
const emptyLeaf = (): StateLeaf => ({ counter: 0, data: null });

/** 轮询统一状态存储（一个插件实例一个；进程内内存态，重启即空） */
export class PollStateStore {
  // 用 declare + 构造器赋值（不用类字段初始化器）：类字段会降级出 @oxc-project/runtime 外部
  // helper，而它是未声明的依赖，会被 prepack 门禁拦下（同 src/host/helper-process.ts 的约定）。
  /** 严格递增的计数器种子（保证同一毫秒内连写两次也拿到不同的 counter） */
  declare private last: number;
  declare private readonly sections: Record<SectionName, StateLeaf>;
  declare private readonly pets: Map<string, Record<PetLeafName, StateLeaf>>;

  constructor() {
    this.last = 0;
    this.sections = { balance: emptyLeaf(), workStatus: emptyLeaf(), notify: emptyLeaf() };
    this.pets = new Map();
  }

  /** 下一个 counter：`Date.now()` 与「上一个 +1」取大——单调、不回退、同毫秒不重复 */
  private next(): number {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }

  /**
   * 写一个全局叶子（余额 / 工作状态 / 通知）。
   * 每次都整体替换叶子对象（不原地改字段），保证 `read()` 拿到的引用不会半新半旧。
   */
  writeSection(name: SectionName, data: unknown): void {
    this.sections[name] = { counter: this.next(), data };
  }

  /** 写一只宠物的叶子（宠物条目不存在则自动建立，两个槽位一起建好，形状恒定） */
  writePet(petId: string, leaf: PetLeafName, data: unknown): void {
    let entry = this.pets.get(petId);
    if (!entry) {
      entry = { say: emptyLeaf(), anim: emptyLeaf() };
      this.pets.set(petId, entry);
    }
    entry[leaf] = { counter: this.next(), data };
  }

  /**
   * 当前 S（GET /state 的响应体）。
   * 返回的 sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
   * 所以消费端不会读到写了一半的叶子。
   */
  read(): PollState {
    return { sections: { ...this.sections }, pets: Object.fromEntries(this.pets) };
  }
}
