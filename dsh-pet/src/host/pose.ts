/**
 * 「实况」（位置 + 朝向）的**桌面端快照**（issue #122 第 1 条）—— 纯逻辑层。
 *
 * 为什么桌面端走宿主快照、网页端不走（同一条理由的正反两面）：
 *
 *   - 桌面宠物**一窗一只**，位置全局唯一一份 → 宿主存一份快照语义干净，第三方用 HTTP 读就行；
 *   - 网页端的宠物位置**天生每个页面一份**（两个标签页位置本来就不同），塞进宿主快照必然是错的
 *     （后写者覆盖先写者）→ 网页端走页面内的 Cordis 只读服务 `petApi7340`（见 src/client/pose.ts），
 *     两边**字段名与坐标口径完全一致**，只是"取"的方式不同。
 *
 * 上报是**变化时推 + 节流**（拖拽 / 走位 / 抛掷 / position 指令 / turn 转身），不是轮询；宿主只存
 * 内存快照、**不写 `/state`**——那是"给渲染端读"的单向通道，写进去只会惊动所有挂着的长轮询。
 *
 * 快照**没有 TTL**：桌面端进程没了就再也不会更新，`updatedAt` 是调用方判断"这份实况有多新"的
 * 唯一依据。而"配置上就不在桌面显示"那种情况由路由层用 `display` 提前拒掉（`pet-not-displayed`），
 * 所以不会读到陈旧值。
 */

/** 朝向（与 `POST /anim` 的 `facing`、`shared/state.ts` 的 `PetFacing` 同词） */
export type PoseFacing = 'left' | 'right';

/** 一份实况快照（`GET /pose` 的响应体即它的浅拷贝 + `ok` / `petId`） */
export interface PoseSnapshot {
  /** 宠物**中心**的归一化横坐标（与 `POST /position` 同一口径；通常 0~1，贴边时可能略出界） */
  x: number;
  /** 同上，纵坐标 */
  y: number;
  /** 朝向 */
  facing: PoseFacing;
  /** 渲染端上报时刻（epoch 毫秒）——调用方据此判断"这份实况有多新" */
  updatedAt: number;
}

/** 可写入快照的三元组（收窄之后） */
export type PoseInput = { x: number; y: number; facing: PoseFacing };

/**
 * 收窄渲染端上报的 `{ x, y, facing }`。
 *
 * 与 `/position` 的"越界夹取"不同，这里**不做范围夹取**：实况是"报什么就是什么"——宠物被拖到
 * 屏幕边缘时中心点本来就可能略微出界，夹取会让读回来的值对不上眼睛。但**非有限数字一律拒**
 * （`NaN` / `Infinity` / 字符串）：那种值喂回去只会把渲染端的位置算坏。
 */
export function normalizePoseInput(
  raw: unknown,
): { ok: true; pose: PoseInput } | { ok: false; reason: 'bad-request'; message: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return { ok: false, reason: 'bad-request', message: '请求体必须是对象：{ x, y, facing }' };
  if (typeof o.x !== 'number' || !Number.isFinite(o.x)) {
    return { ok: false, reason: 'bad-request', message: 'x 必须是有限数字（归一化横坐标）' };
  }
  if (typeof o.y !== 'number' || !Number.isFinite(o.y)) {
    return { ok: false, reason: 'bad-request', message: 'y 必须是有限数字（归一化纵坐标）' };
  }
  if (o.facing !== 'left' && o.facing !== 'right') {
    return { ok: false, reason: 'bad-request', message: 'facing 必须是 left / right' };
  }
  return { ok: true, pose: { x: o.x, y: o.y, facing: o.facing } };
}

/** 实况快照表（一个插件实例一个；进程内内存态，宿主重启即空） */
export class PoseStore {
  // 用 declare + 构造器赋值（不用类字段初始化器）：类字段会降级出 @oxc-project/runtime 外部
  // helper，而它是未声明的依赖，会被 prepack 门禁拦下（同 ./state、./playback、./lock 的约定）。
  /** petId → 最近一次实况 */
  declare private readonly byPet: Map<string, PoseSnapshot>;
  /** 取当前时刻（可注入：单测不用真等时间） */
  declare private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.byPet = new Map();
    this.now = opts?.now ?? Date.now;
  }

  /** 覆盖一只宠物的实况（返回落定的快照，方便调用方断言） */
  set(petId: string, pose: PoseInput): PoseSnapshot {
    const snap: PoseSnapshot = { x: pose.x, y: pose.y, facing: pose.facing, updatedAt: this.now() };
    this.byPet.set(petId, snap);
    return snap;
  }

  /** 读最近一次实况；从没上报过 → undefined（路由回 `pose-unavailable`） */
  get(petId: string): PoseSnapshot | undefined {
    return this.byPet.get(petId);
  }

  /** 当前快照数（测试 / 观测用） */
  count(): number {
    return this.byPet.size;
  }
}
