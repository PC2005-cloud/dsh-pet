/**
 * 第三方右键菜单注册表（进程内存态，DSH 重启即清空，不落盘）。
 *
 * 注册方用自己的 owner 注册菜单项，再用同一个 owner 查「我这一项被点了没有、在哪只宠物上点的」；
 * 不负责菜单渲染与点击命中（两端按 target 过滤后自己拼「更多」与一级项）。必须始终成立：注册是 owner 级的
 * 整体覆盖，菜单项生命周期与插件一致；点击是闩锁不是队列（连点两次只看到一次）；查询即清空（读取
 * 即消费，没确认也没重投）；一个 owner 只该有一个消费者，两个进程同时查会互抢。
 * 限额见下方常量；契约见 API.md 与 openapi.yaml。
 * @module dsh-pet/src/host/menu
 */

/** owner 长度上限。 */
const OWNER_MAX = 64;
/** 单个菜单项 label 长度上限（面板宽 150–240px，再长会被省略号截断）。 */
const LABEL_MAX = 32;
/** 每 owner 菜单项上限。 */
const ITEMS_MAX = 20;
/** 全局 owner 上限。 */
const OWNERS_MAX = 32;
/** 长轮询等待上限（与 /state 同一量级：调用方一次最多挂这么久）。 */
export const MENU_WAIT_MAX_MS = 10_000;

/** 控制字符（换行、制表等会把菜单布局搞炸，一律拒绝）。 */
// eslint-disable-next-line no-control-regex -- 菜单文案必须拒绝 \x00-\x1f 与 \x7f 控制字符（会破坏布局），去掉匹配等于放行
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** 一条菜单项快照（写进 /state 的 sections.menu，两端据此拼「更多」与一级菜单项）。 */
export interface MenuItemSnapshot {
  owner: string;
  label: string;
  /** 这一项该出现在哪个端：两端各自按自己的端过滤（shared/menu 的 readMenuItems） */
  target: MenuTarget;
  /** 这一项放在哪：'more' 收进「更多」，'top' 平铺到一级菜单（shared/menu 的 buildTopLevelItems） */
  placement: MenuPlacement;
}

/** 菜单项显示在哪个端。 */
export type MenuTarget = 'web' | 'desktop' | 'both';

/** 合法的 target 取值。 */
const MENU_TARGETS: ReadonlySet<string> = new Set<string>(['web', 'desktop', 'both']);

/** 缺省 target = 两端都显示（= 加这个字段之前的行为）。 */
const DEFAULT_TARGET: MenuTarget = 'both';

/** 第三方菜单项在右键菜单里的层级。 */
export type MenuPlacement = 'more' | 'top';

/** 合法的 placement 取值。 */
const MENU_PLACEMENTS: ReadonlySet<string> = new Set<string>(['more', 'top']);

/** 缺省 placement = 收进「更多」（= 加这个字段之前的行为，老调用方零改动）。 */
const DEFAULT_PLACEMENT: MenuPlacement = 'more';

/** 注册/清除失败的原因：原样进响应体的 `reason`，取值由路由层的失败实体约束。 */
export type MenuFailure =
  | 'bad-request'
  | 'invalid-owner'
  | 'invalid-labels'
  | 'invalid-label'
  | 'invalid-target'
  | 'invalid-placement'
  | 'too-many-items'
  | 'too-many-owners';

/** 注册结果：业务失败按插件口径回 `{ ok:false, reason, message }`（HTTP 200），不是 400。 */
export type MenuRegisterResult = { ok: true } | { ok: false; reason: MenuFailure; message: string };

/** 校验一个显示用字符串：必须是 string、trim 后非空、不超长、无控制字符。 */
function displayText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > max || CONTROL_CHARS.test(text)) return null;
  return text;
}

/** 第三方菜单项的进程内注册表：注册、清空、点击上报、长轮询查询。 */
export class MenuRegistry {
  // 用 declare + 构造器赋值（不用类字段初始化器）：类字段会降级出 @oxc-project/runtime 外部
  // helper，而它是未声明的依赖，会被 prepack 门禁拦下（同 src/host/state.ts 的约定）。
  /** owner → { target, placement, items }；items = label → 触发它的 petId（null = 未触发） */
  declare private readonly owners: Map<
    string,
    { target: MenuTarget; placement: MenuPlacement; items: Map<string, string | null> }
  >;
  /** owner → 挂在该 owner 上的长轮询唤醒回调 */
  declare private readonly waiters: Map<string, Set<() => void>>;

  constructor() {
    this.owners = new Map();
    this.waiters = new Map();
  }

  /**
   * 注册（整体覆盖）：`{ owner, labels, target?, placement? }`。
   *
   * 覆盖粒度是整个 owner：注册方每次用一份完整列表描述「我现在有什么」，不必关心上次注册了什么，
   * 也不会留下已下线的僵尸项。`target` 选填、缺省 `both`；`placement` 选填、缺省 `more`
   * （不传就是老行为：全部收进「更多」），两者都与 labels 一起被覆盖。
   */
  register(raw: unknown): MenuRegisterResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'bad-request', message: 'body 必须是 { owner, labels, target?, placement? }' };
    }
    const body = raw as Record<string, unknown>;
    const owner = displayText(body.owner, OWNER_MAX);
    if (owner === null) {
      return { ok: false, reason: 'invalid-owner', message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）` };
    }

    const rawLabels = body.labels;
    if (!Array.isArray(rawLabels) || rawLabels.length === 0) {
      return { ok: false, reason: 'invalid-labels', message: 'labels 必须是非空数组' };
    }
    if (rawLabels.length > ITEMS_MAX) {
      return { ok: false, reason: 'too-many-items', message: `每个 owner 最多 ${ITEMS_MAX} 项` };
    }

    const labels: string[] = [];
    for (const rawLabel of rawLabels) {
      const label = displayText(rawLabel, LABEL_MAX);
      if (label === null) {
        return {
          ok: false,
          reason: 'invalid-label',
          message: `每个 label 必须是 1–${LABEL_MAX} 字符的字符串（禁控制字符）`,
        };
      }
      if (!labels.includes(label)) labels.push(label); // 同 owner 内去重（保留首次出现的位置）
    }

    if (!this.owners.has(owner) && this.owners.size >= OWNERS_MAX) {
      return { ok: false, reason: 'too-many-owners', message: `最多 ${OWNERS_MAX} 个 owner` };
    }
    // target 选填：不写 / null = both（老调用方只传 owner + labels 时一个字都不用改）；写了就必须
    // 是三个字面量之一——非法值只报错、不猜，免得第三方以为注册成功却看不到菜单。
    const rawTarget = body.target;
    let target: MenuTarget = DEFAULT_TARGET;
    if (rawTarget !== undefined && rawTarget !== null) {
      if (typeof rawTarget !== 'string' || !MENU_TARGETS.has(rawTarget)) {
        return {
          ok: false,
          reason: 'invalid-target',
          message: 'target 只能是 web / desktop / both（不写 = both）',
        };
      }
      target = rawTarget as MenuTarget;
    }
    // placement 选填：不写 / null / 'more' = 收进「更多」（老调用方零改动）；写了别的值一口回绝，
    // 不猜、不回退默认值，免得第三方以为注册成功却看到菜单跑错了位置。
    const rawPlacement = body.placement;
    let placement: MenuPlacement = DEFAULT_PLACEMENT;
    if (rawPlacement !== undefined && rawPlacement !== null) {
      if (typeof rawPlacement !== 'string' || !MENU_PLACEMENTS.has(rawPlacement)) {
        return {
          ok: false,
          reason: 'invalid-placement',
          message: 'placement 只能是 more / top（不写 = more）',
        };
      }
      placement = rawPlacement as MenuPlacement;
    }
    this.owners.set(owner, {
      target,
      placement,
      items: new Map(labels.map((label) => [label, null] as const)),
    });
    return { ok: true };
  }

  /**
   * 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
   *
   * 幂等：owner 本来就不存在 → `removed: 0`，仍算成功，调用方重试注销时不该看到错误。
   * 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → 路由回 `unknown-owner`。
   */
  clear(rawOwner: unknown): { ok: true; removed: number } | { ok: false; reason: MenuFailure; message: string } {
    const owner = displayText(rawOwner, OWNER_MAX);
    if (owner === null) {
      return { ok: false, reason: 'invalid-owner', message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）` };
    }
    const entry = this.owners.get(owner);
    if (!entry) return { ok: true, removed: 0 };
    const removed = entry.items.size;
    this.owners.delete(owner);
    const waiters = this.waiters.get(owner);
    this.waiters.delete(owner);
    if (waiters) for (const wake of [...waiters]) wake();
    return { ok: true, removed };
  }

  /** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致）。 */
  snapshot(): MenuItemSnapshot[] {
    const out: MenuItemSnapshot[] = [];
    for (const [owner, entry] of this.owners) {
      for (const label of entry.items.keys()) {
        out.push({ owner, label, target: entry.target, placement: entry.placement });
      }
    }
    return out;
  }

  /**
   * 渲染端上报一次点击：把该项标成「被 petId 点了」，并叫醒该 owner 上挂着的长轮询。
   *
   * `delivered = false`（项不存在：菜单刚好被覆盖、还没注册）不算错误——渲染端拿的是上一拍
   * /state 快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
   */
  click(raw: unknown): { ok: true; delivered: boolean } {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const owner = typeof body.owner === 'string' ? body.owner : '';
    const label = typeof body.label === 'string' ? body.label : '';
    const pet = typeof body.pet === 'string' ? body.pet.trim() : '';
    const entry = this.owners.get(owner);
    if (!entry || !entry.items.has(label) || pet === '') return { ok: true, delivered: false };
    entry.items.set(label, pet);
    const waiters = this.waiters.get(owner);
    if (waiters) for (const wake of [...waiters]) wake();
    return { ok: true, delivered: true };
  }

  /**
   * 查询触发：返回 `{ label: petId | null }` 全量映射，返回即清空这些标记。
   *
   * `waitMs > 0` 且当下没有任何触发 → 挂起等待（被点、超时、被覆盖都会唤醒），超时后照常返回
   * 全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
   */
  async poll(owner: string, waitMs: number): Promise<Record<string, string | null> | null> {
    const entry = this.owners.get(owner);
    if (!entry) return null;

    if (waitMs > 0 && !hasFired(entry.items)) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(owner) ?? new Set<() => void>();
        this.waiters.set(owner, set);
        const hold: { timer?: ReturnType<typeof setTimeout> } = {};
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (hold.timer !== undefined) clearTimeout(hold.timer);
          set.delete(finish);
          if (set.size === 0 && this.waiters.get(owner) === set) this.waiters.delete(owner);
          resolve();
        };
        hold.timer = setTimeout(finish, Math.min(waitMs, MENU_WAIT_MAX_MS));
        set.add(finish);
      });
    }

    // 等待期间可能被整体覆盖（注册新的 labels）——重新取一次，别拿旧 Map 的结果
    const current = this.owners.get(owner);
    if (!current) return null;
    const out: Record<string, string | null> = {};
    for (const [label, pet] of current.items) {
      out[label] = pet;
      current.items.set(label, null); // 读取即消费
    }
    return out;
  }
}

/** 该 owner 当前有没有任意一项被点过。 */
function hasFired(items: Map<string, string | null>): boolean {
  for (const pet of items.values()) if (pet !== null) return true;
  return false;
}
