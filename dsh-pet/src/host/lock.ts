/**
 * 宠物占用锁（issue #122 第 4 项「独立动作/气泡占用」）—— 宿主侧的**内存独占锁**。
 *
 * 它解决的问题：第三方插件要演一段联动（拉侧栏 / 跳抓吉祥物 / 踢侧栏），这期间宠物的随机动画、
 * 自主走位、余额/碎碎念/工作状态气泡都会来抢镜头。锁把这段时间**独占**给持锁者——
 * 除持锁者之外谁都动不了这只宠物（issue #122 原话：「联动动作可能被随机动作、工作状态动画、
 * 原生走位等打断；余额、碎碎念或工作状态气泡也可能覆盖联动气泡，因此需要临时协调这些入口」）。
 *
 * 一把锁、**全有全无**：拿锁 → 返回 lockId；占用期间所有动作端点必须带这个编号；释放 → 一切复原。
 *
 * 四条边界（改之前先读完）：
 *
 *   1. **不传 lock = 现状零变化**。没有锁时 `gate()` 放行、`locked()` 恒 false，所有既有路径一个字
 *      都不变（issue #122：「没有有效联动占用时，接口不改变 pet 原有行为」）。但**传了编号却查不到
 *      锁**是另一回事：那说明调用方以为自己还持有，必须回 `lock-lost` —— 否则「你丢了锁」这件事
 *      会被悄悄抹掉，它会以为演出还在继续，实际早被释放 / 到期 / 抢占。
 *   2. **有界**：内存态 + TTL（缺省 2min、上限 30min），插件卸载 / 宿主重启即全部失效——
 *      调用方崩溃不会把宠物永久锁死（issue #122：「避免宠物被永久锁住」）。
 *   3. **续期就是心跳**：调用方必须定期续期，而**续期那一次调用同时就是「我的锁还在吗」的探测器**
 *      ——锁丢了会回 `lock-lost` + `cause`。所以没有单独的"查锁"端点（探测用不着：
 *      `acquire` 撞上 `locked` 时已经把 `expiresAt` 带回来了）。
 *   4. **没有定时器**：过期是**懒判**的（`now() >= expiresAt` 即视为没有）。叶子里的 `expiresAt`
 *      是唯一真相，渲染端据此**自己**解除静止——所以不需要宿主到点推送，也不需要"释放后重发"的补丁。
 *      宿主这一侧由 `current()` 顺手把过期的锁清掉并同步一次叶子（只写一次）。
 *
 * **第三方之间不互相抢占**：一把锁，先到先得，撞上就回 `locked` + `expiresAt`（让对方知道何时重试）。
 * 只有**用户**能抢占（拖拽 / 点击 / 隐藏 / 关闭）——那走 `release({ force: true })`。
 *
 * 为什么单独一层：本功能的契约就是这几条判定（ttl 合法性、真值表、cause 分类、墓碑），
 * 它们必须能脱离 HTTP 被单测——路由层（src/host/index.ts）在源码形态下读不到包内 assets。
 * `now` 可注入正是为了这个：过期语义不用真的等 30 秒。
 */

/**
 * 占用时长（毫秒）。
 *
 * 缺省 **2min**：一次联动演出通常几十秒到一两分钟，这个缺省保证**调用方就算没实现续期、
 * 或者漏了一拍，也不会中途丢锁**——丢了会当场解冻，是很难查的现象。
 * 上限 **30min**：够"一连串动作 + 中间等用户点侧栏"，又让另一把锁最多只等这么久；
 * 更长的演出该走续期，而不是靠一个巨大的 TTL 把宠物占着。
 */
export const LOCK_DEFAULT_TTL_MS = 2 * 60 * 1000;
export const LOCK_MIN_TTL_MS = 1 * 1000;
export const LOCK_MAX_TTL_MS = 30 * 60 * 1000;

/**
 * 锁是**怎么没的**——持锁者据此决定"重新拿锁"还是"收尾走人"：
 *   - `expired`   自己没续上（调用方该重拿或收工）
 *   - `released`  持锁者自己释放的（通常是它自己刚调过 release，属正常收尾）
 *   - `preempted` 被**用户**抢走的（拖拽/点击/隐藏/关闭——联动必须立刻收尾，别跟用户抢）
 *   - `unknown`   这个编号不是当前生效的那个（记不清 / 拿错 / 从来没有过）
 */
export type LockCause = 'expired' | 'released' | 'preempted' | 'unknown';

/** cause → 给人看的一句话（回执里的 message；reason 才是机器读的那个） */
const CAUSE_TEXT: Record<LockCause, string> = {
  expired: '占用已过期（没有及时续期）',
  released: '占用已被释放',
  preempted: '占用已被用户接管（拖拽/点击/隐藏/关闭）',
  unknown: 'lock 不是当前生效的占用编号',
};

/** 写进 `pets.<id>.lock` 的载荷（渲染端据此冻结/解冻） */
export type LockLeafData = { locked: true; expiresAt: number } | { locked: false };

/** 一条占用记录（内存态） */
interface LockRecord {
  /** 不透明编号（`lk-<时间36>-<自增36>`），持锁者后续所有操作都要带 */
  lockId: string;
  /** 这一轮的时长：续期不带 ttl 时沿用它 */
  ttl: number;
  /** 到点即视为没有（**懒判**，没有定时器） */
  expiresAt: number;
}

/** 墓碑：这把锁是怎么没的（保留到该宠物建立新锁为止，否则 cause 只能永远回 unknown） */
interface Tombstone {
  lockId: string;
  cause: LockCause;
}

/** 动作端点的门禁结论（5 个接口共用） */
export type LockGate =
  | { ok: true }
  | { ok: false; reason: 'lock-required'; message: string }
  | { ok: false; reason: 'lock-lost'; cause: LockCause; message: string };

/** 取锁 / 续期的结论 */
export type LockAcquireDecision =
  | { ok: true; petId: string; lockId: string; expiresAt: number; renewed: boolean }
  | { ok: false; reason: 'bad-request'; message: string }
  | { ok: false; reason: 'locked'; expiresAt: number; message: string }
  | { ok: false; reason: 'lock-lost'; cause: LockCause; message: string };

/** 释放的结论（`released` 只表示"这一次真的撤掉了一把锁"，幂等空操作时为 false） */
export type LockReleaseDecision =
  | { ok: true; petId: string; released: boolean }
  | { ok: false; reason: 'bad-request'; message: string }
  | { ok: false; reason: 'lock-lost'; cause: LockCause; message: string };

/** ttl 合法性说明（路由与决策层共用同一条规则，免得两处走样） */
const TTL_TEXT = `ttl 必须是 ${LOCK_MIN_TTL_MS}~${LOCK_MAX_TTL_MS} 之间的有限数字（毫秒）`;

/**
 * ttl 规范化：缺省 / null → `fallback`；合法则原样；**非法返回 null**。
 * 非数字 / 非有限（NaN、Infinity）/ 越界一律非法——**不给"越界就夹取"的宽松口径**：
 * 调用方写错时长应当立刻知道，而不是拿到一把比自己以为的更短/更长的锁。
 */
export function normalizeLockTtl(ttl: unknown, fallback: number): number | null {
  if (ttl === undefined || ttl === null) return fallback;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return null;
  if (ttl < LOCK_MIN_TTL_MS || ttl > LOCK_MAX_TTL_MS) return null;
  return ttl;
}

/**
 * lockId 规范化：缺省 / null → 空串（= "没给"，走新建那条路）；字符串 → trim 后原样；
 * **非字符串 → null（非法）**。空串按"没给"处理是有意的（与 `image`/`url` 的宽松口径一致）。
 */
function normalizeLockId(v: unknown): string | null {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  return v.trim();
}

/** 占用锁表（一个插件实例一个；进程内内存态，重启即空） */
export class LockStore {
  // 用 declare + 构造器赋值（不用类字段初始化器）：类字段会降级出 @oxc-project/runtime 外部
  // helper，而它是未声明的依赖，会被 prepack 门禁拦下（同 ./state.ts 的 PollStateStore 约定）。
  /** petId → 当前占用 */
  declare private readonly locks: Map<string, LockRecord>;
  /** petId → 上一把锁是怎么没的（新锁建立时作废） */
  declare private readonly tombstones: Map<string, Tombstone>;
  /** 编号自增段（与时间戳一起构成运行内唯一编号，与 ./playback 同一套） */
  declare private seq: number;
  /** 取当前时刻（可注入：过期语义的单测不用真的等 30 秒） */
  declare private readonly now: () => number;
  /** 锁状态变化时同步叶子（建锁/续期/释放/过期都走它；不传则纯逻辑、不碰 S） */
  declare private readonly onChange: (petId: string, data: LockLeafData) => void;

  constructor(opts?: { now?: () => number; onChange?: (petId: string, data: LockLeafData) => void }) {
    this.locks = new Map();
    this.tombstones = new Map();
    this.seq = 0;
    this.now = opts?.now ?? Date.now;
    this.onChange = opts?.onChange ?? ((): void => {});
  }

  /**
   * 当前占用（**懒判过期**）。到点即视为没有：清记录、记墓碑、同步一次叶子。
   *
   * 这里会写叶子（读方法带一次副作用）是有意的：叶子是渲染端唯一能看到的信号，
   * 而宿主这一侧没有任何定时器。任一动作端点或内部来源调一次本方法，过期的锁就会被清掉并
   * 如实写进 S；即便一次都没人调，渲染端也会按叶子里的 `expiresAt` **自己**解除静止。
   */
  current(petId: string): LockRecord | null {
    const rec = this.locks.get(petId);
    if (rec === undefined) return null;
    if (this.now() < rec.expiresAt) return rec;
    this.drop(petId, rec, 'expired');
    return null;
  }

  /** 这只宠物此刻是否被占用（宿主内部自动来源用它决定跳过；同样懒判过期） */
  locked(petId: string): boolean {
    return this.current(petId) !== null;
  }

  /**
   * 当前是否有**任意**宠物被占用（测试 / 观测用，同 ./state 的 `waiterCount()`）。
   *
   * **生产路径上没有人调它**：占用期间要挡的两个**全局段**（`sections.balance` /
   * `sections.workStatus`）是**所有宠物共用一份**，宿主"跳过写入"会连带静音别的宠物
   * （issue #122 要的是"只控制指定 main"），所以那两处改由**渲染端按宠物忽略**——
   * 叶子照常推进，被占用那只自己不看（见 src/client/pet.ts 的冻结判定与
   * runtime/electron-helper/events.js 里同一处判断）。宿主侧只挡 per-pet 的碎碎念周期。
   */
  anyLocked(): boolean {
    for (const petId of [...this.locks.keys()]) {
      if (this.current(petId) !== null) return true;
    }
    return false;
  }

  /**
   * 动作端点的门禁（`/anim`、`/broadcast`、`/position`、`/throw`、`/bubble/clear` 共用）。
   *
   * 无锁时按「有没有带编号」分两条：
   *   - **没带 `lock`** → 放行。没有占用的常态下，既有调用方一个字都不用改。
   *   - **带了 `lock` 但查不到锁** → `lock-lost`。带了编号就说明调用方以为自己还持有；这时放行
   *     等于把「你把锁丢了」悄悄抹掉，它会以为演出还在继续。`cause` 从墓碑里取，从没建过锁就是
   *     `unknown`（issue #122 第 4 点：旧租约不能继续执行迟到请求）。
   */
  gate(petId: string, provided: string): LockGate {
    const rec = this.current(petId);
    if (rec !== null) {
      if (provided && provided === rec.lockId) return { ok: true };
      if (!provided) {
        return { ok: false, reason: 'lock-required', message: '这只桌宠正被占用，必须带 lock=<lockId>' };
      }
      return { ok: false, reason: 'lock-lost', cause: 'unknown', message: CAUSE_TEXT.unknown };
    }
    // 无锁：没带编号照旧放行；带了编号 → 明确告诉他锁已经不在了
    if (!provided) return { ok: true };
    const cause = this.causeOf(petId, provided);
    return { ok: false, reason: 'lock-lost', cause, message: CAUSE_TEXT[cause] };
  }

  /**
   * 取锁 / 续期（**二合一**：`lockId` 给了就是续期，没给就是新建）。
   *
   * 真值表（每一格都有确定结论，不替调用方猜）：
   *   | body       | 当前锁       | 结论 |
   *   | 无 lockId  | 无锁         | 新建 |
   *   | 无 lockId  | 有锁         | `locked` + `expiresAt` |
   *   | 有 lockId  | 一致         | 续期 |
   *   | 有 lockId  | 有锁但不一致 | `lock-lost` / `unknown` |
   *   | 有 lockId  | 无锁         | `lock-lost` / 墓碑里的 cause |
   *
   * **「有 id + 当前无锁」一律报错，不复活**：过期/被释放/被抢占之后拿旧编号来续期，
   * 不能借这条路把锁重新建起来——否则「我丢了锁」这件事会被悄悄抹掉，持锁者会以为演出还在继续。
   */
  acquire(args: { petId: string; lockId?: unknown; ttl?: unknown }): LockAcquireDecision {
    const { petId } = args;
    const renewId = normalizeLockId(args.lockId);
    if (renewId === null) return { ok: false, reason: 'bad-request', message: 'lockId 必须是字符串' };
    const rec = this.current(petId);

    if (renewId) {
      if (rec === null || rec.lockId !== renewId) {
        // 没有锁 → 去墓碑里问"它当初是怎么没的"；有锁但不是它 → 就是认不出这个编号
        const cause: LockCause = rec === null ? this.causeOf(petId, renewId) : 'unknown';
        return { ok: false, reason: 'lock-lost', cause, message: CAUSE_TEXT[cause] };
      }
      const ttl = normalizeLockTtl(args.ttl, rec.ttl);
      if (ttl === null) return { ok: false, reason: 'bad-request', message: TTL_TEXT };
      rec.ttl = ttl;
      rec.expiresAt = this.now() + ttl;
      this.onChange(petId, { locked: true, expiresAt: rec.expiresAt });
      return { ok: true, petId, lockId: rec.lockId, expiresAt: rec.expiresAt, renewed: true };
    }

    if (rec !== null) {
      return { ok: false, reason: 'locked', expiresAt: rec.expiresAt, message: '这只桌宠已被占用' };
    }
    const ttl = normalizeLockTtl(args.ttl, LOCK_DEFAULT_TTL_MS);
    if (ttl === null) return { ok: false, reason: 'bad-request', message: TTL_TEXT };
    const record: LockRecord = { lockId: this.newId(), ttl, expiresAt: this.now() + ttl };
    this.locks.set(petId, record);
    this.tombstones.delete(petId); // 新锁建立 → 旧墓碑作废（旧编号此后一律 unknown）
    this.onChange(petId, { locked: true, expiresAt: record.expiresAt });
    return { ok: true, petId, lockId: record.lockId, expiresAt: record.expiresAt, renewed: false };
  }

  /**
   * 释放。两种形态**二选一**：
   *   - `lockId`：持锁者收工 → `cause: released`
   *   - `force: true`：**渲染端**在用户拖拽/点击/隐藏/关闭时调 → `cause: preempted`
   *
   * 幂等：当前没有锁时回 `ok:true`（`released: false`）——"让锁消失"这个意图在空状态下已经成立。
   * 但有锁而 `lockId` 不匹配时**必须报错**（不许误放别人的锁）：这是唯一一条"释放也会失败"的路。
   *
   * `force` 只认**严格 `true`**（宽松口径会把误传当真，代价是撤掉别人的锁——宁可严格）。
   */
  release(args: { petId: string; lockId?: unknown; force?: unknown }): LockReleaseDecision {
    const { petId } = args;
    const force = args.force === true;
    const releaseId = normalizeLockId(args.lockId);
    if (releaseId === null) return { ok: false, reason: 'bad-request', message: 'lockId 必须是字符串' };
    if (force && releaseId) {
      return { ok: false, reason: 'bad-request', message: 'lockId 与 force 只能给一个' };
    }
    if (!force && !releaseId) {
      return { ok: false, reason: 'bad-request', message: 'lockId 或 force 必须给一个' };
    }
    const rec = this.current(petId);
    if (rec === null) return { ok: true, petId, released: false }; // 幂等：没有锁可撤
    if (!force && rec.lockId !== releaseId) {
      return { ok: false, reason: 'lock-lost', cause: 'unknown', message: CAUSE_TEXT.unknown };
    }
    this.drop(petId, rec, force ? 'preempted' : 'released');
    return { ok: true, petId, released: true };
  }

  /** 撤掉全部占用（插件卸载路径）：不这样做的话，渲染端要等 TTL 到点才解除静止 */
  releaseAll(): void {
    for (const petId of [...this.locks.keys()]) {
      const rec = this.locks.get(petId);
      if (rec !== undefined) this.drop(petId, rec, 'released');
    }
  }

  /** 撤锁并记墓碑（唯一改状态的出口：释放/抢占/过期都走它，保证叶子与墓碑不漏写） */
  private drop(petId: string, rec: LockRecord, cause: LockCause): void {
    this.locks.delete(petId);
    this.tombstones.set(petId, { lockId: rec.lockId, cause });
    this.onChange(petId, { locked: false });
  }

  /** 墓碑查询：编号对得上就回它当初的 cause，否则 unknown（拿错编号 / 从来没有过） */
  private causeOf(petId: string, lockId: string): LockCause {
    const stone = this.tombstones.get(petId);
    return stone !== undefined && stone.lockId === lockId ? stone.cause : 'unknown';
  }

  /** 新编号：`lk-<时间36>-<自增36>`（与 ./playback 的 playbackId 同一套，只保证一次运行内唯一） */
  private newId(): string {
    return 'lk-' + this.now().toString(36) + '-' + (++this.seq).toString(36);
  }
}
