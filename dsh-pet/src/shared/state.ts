// 轮询统一状态（S）的**客户端侧纯逻辑**：拉取 / 拍平 / 比对。
// 浏览器 bundle 与桌面 shared-core 共用同一份（src/shared 单一来源，避免两端各写一套走样）。
//
// 消费方式（两端一致）：
//   首拉 → flattenCounters(s) 记基线（**不渲染**，避免刷新页面时重放旧气泡）
//   之后 → takeChanged(s, baseline) 拿本次变化的叶子 → 逐个渲染
//
// 路径（'sections.balance' / 'pets.<id>.say'）只当**不透明键**用，绝不解析——
// 宠物 id 允许含点号，解析出来必然出错。
import { toBalanceState, type BalanceState } from './balance';
import { toWorkStatus, type WorkStatusSnapshot } from './work-status';

/** 一个叶子：计数器 + 载荷（data 为 null = 还没有数据，消费端跳过） */
export interface StateLeaf {
  counter: number;
  data: unknown;
}

/** S 的客户端视图（叶子已规范化：counter 必为数字） */
export interface PollState {
  sections: Record<string, StateLeaf>;
  pets: Record<string, Record<string, StateLeaf>>;
}

/** 一次变化的叶子（path 用于日志/调试，leaf 用于渲染） */
export interface StateChange {
  path: string;
  leaf: StateLeaf;
}

/** 叶子规范化：形状不对（非对象 / counter 非数字）→ null（丢弃，不让脏数据进渲染层） */
function normLeaf(value: unknown): StateLeaf | null {
  if (!value || typeof value !== 'object') return null;
  const leaf = value as { counter?: unknown; data?: unknown };
  if (typeof leaf.counter !== 'number' || !Number.isFinite(leaf.counter)) return null;
  return { counter: leaf.counter, data: leaf.data ?? null };
}

/**
 * 拉一次 /state。
 * 失败 / HTTP 非 2xx / 形状不对 → null（轮询侧静默重试，与其余轮询同一容错口径）。
 */
export async function fetchState(baseUrl = '/dsh-pet-7340/state'): Promise<PollState | null> {
  try {
    const res = await fetch(baseUrl, { cache: 'no-store' });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => null)) as { sections?: unknown; pets?: unknown } | null;
    if (!raw || typeof raw !== 'object') return null;
    const sections: Record<string, StateLeaf> = {};
    const rawSections =
      raw.sections && typeof raw.sections === 'object' ? (raw.sections as Record<string, unknown>) : {};
    for (const [name, value] of Object.entries(rawSections)) {
      const leaf = normLeaf(value);
      if (leaf) sections[name] = leaf;
    }
    const pets: Record<string, Record<string, StateLeaf>> = {};
    const rawPets = raw.pets && typeof raw.pets === 'object' ? (raw.pets as Record<string, unknown>) : {};
    for (const [petId, entry] of Object.entries(rawPets)) {
      if (!entry || typeof entry !== 'object') continue;
      const leaves: Record<string, StateLeaf> = {};
      for (const [name, value] of Object.entries(entry as Record<string, unknown>)) {
        const leaf = normLeaf(value);
        if (leaf) leaves[name] = leaf;
      }
      pets[petId] = leaves;
    }
    return { sections, pets };
  } catch {
    return null;
  }
}

/** 遍历 S 的所有叶子（顺序：sections 在前、pets 在后） */
function* walkLeaves(s: PollState): Generator<[string, StateLeaf]> {
  for (const [name, leaf] of Object.entries(s.sections ?? {})) yield ['sections.' + name, leaf];
  for (const [petId, leaves] of Object.entries(s.pets ?? {})) {
    for (const [name, leaf] of Object.entries(leaves ?? {})) yield ['pets.' + petId + '.' + name, leaf];
  }
}

/** S → { 叶子路径: counter }：首拉基线用（新增的 section/宠物自动纳入，不用改这里） */
export function flattenCounters(s: PollState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [path, leaf] of walkLeaves(s)) out[path] = leaf.counter;
  return out;
}

/**
 * 与基线比对，**就地推进基线**，返回本次变化的叶子。
 * 首拉不要调它（用 flattenCounters 记基线即可）——否则页面刷新会把旧数据重放一遍。
 */
export function takeChanged(s: PollState, baseline: Record<string, number>): StateChange[] {
  const out: StateChange[] = [];
  for (const [path, leaf] of walkLeaves(s)) {
    if (baseline[path] === leaf.counter) continue;
    baseline[path] = leaf.counter;
    out.push({ path, leaf });
  }
  return out;
}

/**
 * 类型收窄：余额叶子 → `{ state, manual }`。
 * `manual` = 这次写入是**手动触发**的（`/balance` 命令、桌面「查看余额」菜单）——
 * 由 host 在写入时标记（`{...result, manual: true}`），因为只有 host 知道这次刷新是谁要的。
 * 消费端据此决定"余额不可用时要不要必弹文字说明"（decideBalanceNotice 的 explicit 参数）。
 * 形状非法 → null（消费端跳过这一拍，不抛）。
 */
export function readBalance(leaf: StateLeaf): { state: BalanceState; manual: boolean } | null {
  const state = toBalanceState(leaf.data);
  if (!state) return null;
  const manual = (leaf.data as { manual?: unknown }).manual === true;
  return { state, manual };
}

/**
 * 类型收窄：宠物说话叶子 → `{ text, image? }`（形状非法 / 空文本 → null，消费端跳过这一拍）。
 * 碎碎念、命令气泡、对话回复共用这一个叶子——前端本来就是同一条展示链路
 * （同一个 triggerWhisper、同一个气泡槽、同一批 events.whisper 动画）。
 */
export function readSay(leaf: StateLeaf): { text: string; image?: string } | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as { text?: unknown; image?: unknown };
  if (typeof d.text !== 'string' || !d.text) return null;
  return { text: d.text, image: typeof d.image === 'string' ? d.image : undefined };
}

/**
 * 类型收窄：工作状态叶子 → 快照（形状非法 → null，消费端跳过这一拍）。
 * 与余额不同，这里没有"手动"标记：工作状态永远由 DSH 事件驱动，没有用户主动要的那条路。
 */
export function readWorkStatus(leaf: StateLeaf): WorkStatusSnapshot | null {
  return toWorkStatus(leaf.data);
}

/**
 * 类型收窄：点播动画叶子 → 动画名（形状非法 / 空名 → null，消费端跳过这一拍）。
 * **名字即文件名**：消费端拿到后交给菜单动作处理函数换源播放，所以这里只做形状校验；
 * "这个动画是否存在于该宠物"由宿主在写入前保证（播放端对不存在的名字没有兜底）。
 */
export function readAnim(leaf: StateLeaf): { name: string } | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as { name?: unknown };
  if (typeof d.name !== 'string' || !d.name) return null;
  return { name: d.name };
}

/**
 * 动作端点：POST 一次，返回是否成功（`{ok:true}`）。
 * 动作**不返回数据**——数据只有一个出口（/state），调用方收到 ok 后立刻 `pollStateNow()`
 * 拉一拍即可 0 延迟看到结果（见 host 侧的路由说明）。
 */
export async function postAction(baseUrl: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return data?.ok === true;
  } catch {
    return false;
  }
}
