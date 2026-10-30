/**
 * 轮询状态（/state）的客户端侧纯逻辑：拉取、叶子拍平、与基线比对。
 * 不负责写状态——动作端点只回执，数据只有一个出口；路径只按已知前后缀解析成落点
 * （见 resolveLeafPath），绝不按点号切分，因为宠物 id 允许含点号。
 * 两端共用同一份；首拉只记基线不渲染，否则刷新页面会把旧气泡重放一遍。
 * @module dsh-pet/src/shared/state
 */
import { toBalanceState, type BalanceState } from './balance/index.ts';
import { toWorkStatus, type WorkStatusSnapshot } from './work-status.ts';
import { ROUTE_PATH } from './constants.ts';

/** 一个叶子：计数器 + 载荷；data 为 null 表示还没有数据，消费端跳过。 */
export interface StateLeaf {
  counter: number;
  data: unknown;
}

/** 轮询状态的客户端视图（叶子已规范化：counter 必为数字）。 */
export interface PollState {
  /** 整份 S 的版本号（= 最后一次写入的编号），回传成 ?since= 表达「我手里这份是哪个版本」。
   *  老宿主不带此字段 → undefined：消费端据此退回定时轮询——老宿主不认识 since/timeout，
   *  会立刻返回，不退避就变成狂打。 */
  counter?: number;
  sections: Record<string, StateLeaf>;
  pets: Record<string, Record<string, StateLeaf>>;
}

/** 一次变化的叶子（path 供日志与调试，leaf 供渲染）。 */
export interface StateChange {
  path: string;
  leaf: StateLeaf;
}

/** 叶子规范化：形状不对（非对象或 counter 非数字）→ null，不让脏数据进渲染层。 */
function normLeaf(value: unknown): StateLeaf | null {
  if (!value || typeof value !== 'object') return null;
  const leaf = value as { counter?: unknown; data?: unknown };
  if (typeof leaf.counter !== 'number' || !Number.isFinite(leaf.counter)) return null;
  return { counter: leaf.counter, data: leaf.data ?? null };
}

/** 拉一次 /state；失败、HTTP 非 2xx 或形状不对都返回 null（轮询侧静默重试）。
 *  wait 传了就带 ?since=&timeout= 走长轮询：宿主在版本没变时挂起，直到任意叶子被写过或超时；
 *  不传则立刻返回全量。 */
export async function fetchState(
  baseUrl = ROUTE_PATH + '/state',
  wait?: { since: number; timeoutMs: number },
): Promise<PollState | null> {
  try {
    const url = wait ? `${baseUrl}?since=${wait.since}&timeout=${wait.timeoutMs}` : baseUrl;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => null)) as {
      ok?: unknown;
      counter?: unknown;
      sections?: unknown;
      pets?: unknown;
    } | null;
    // 业务失败也是 200：`ok:false` 的体不是快照，按失败处理（否则会被当成「空状态」成功一次）
    if (!raw || typeof raw !== 'object' || raw.ok === false) return null;
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
    return {
      counter: typeof raw.counter === 'number' && Number.isFinite(raw.counter) ? raw.counter : undefined,
      sections,
      pets,
    };
  } catch {
    return null;
  }
}

/** 遍历 S 的所有叶子（sections 在前、pets 在后）。 */
function* walkLeaves(s: PollState): Generator<[string, StateLeaf]> {
  for (const [name, leaf] of Object.entries(s.sections ?? {})) yield ['sections.' + name, leaf];
  for (const [petId, leaves] of Object.entries(s.pets ?? {})) {
    for (const [name, leaf] of Object.entries(leaves ?? {})) yield ['pets.' + petId + '.' + name, leaf];
  }
}

/** S → { 叶子路径: counter }，首拉基线用；新增的 section 或宠物自动纳入。 */
export function flattenCounters(s: PollState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [path, leaf] of walkLeaves(s)) out[path] = leaf.counter;
  return out;
}

/** 与基线比对并就地推进基线，返回本次变化的叶子。
 *  首拉不要调它（用 flattenCounters 记基线），否则页面刷新会把旧数据重放一遍。 */
export function takeChanged(s: PollState, baseline: Record<string, number>): StateChange[] {
  const out: StateChange[] = [];
  for (const [path, leaf] of walkLeaves(s)) {
    if (baseline[path] === leaf.counter) continue;
    baseline[path] = leaf.counter;
    out.push({ path, leaf });
  }
  return out;
}

/** `sections.<名>` 里会被消费端分发的那几个叶子。 */
export type SectionLeafName = 'config' | 'balance' | 'workStatus' | 'notify' | 'menu';

/** `pets.<id>.<名>` 里会被消费端分发的那几个叶子。 */
export type PetLeafName = 'say' | 'anim' | 'position' | 'throw' | 'lock';

/** 一次叶子分发的落点：分段叶子，或某只宠物的叶子。 */
export type LeafTarget =
  { where: 'section'; name: SectionLeafName } | { where: 'pet'; name: PetLeafName; petId: string };

/** 分段叶子名的全集；新增 section 叶子时与 {@link SectionLeafName} 一起改。 */
const SECTION_LEAF_NAMES = ['config', 'balance', 'workStatus', 'notify', 'menu'] as const;

/** 宠物叶子名的全集；新增宠物叶子时与 {@link PetLeafName} 一起改。 */
const PET_LEAF_NAMES = ['say', 'anim', 'position', 'throw', 'lock'] as const;

/** 把字符串收窄成分段叶子名。 */
function isSectionLeafName(name: string): name is SectionLeafName {
  return (SECTION_LEAF_NAMES as readonly string[]).includes(name);
}

/** 把字符串收窄成宠物叶子名。 */
function isPetLeafName(name: string): name is PetLeafName {
  return (PET_LEAF_NAMES as readonly string[]).includes(name);
}

/**
 * 把叶子路径解析成落点；不认识的（含空宠物 id、空叶子名）→ null，消费端跳过这一拍。
 *
 * 宠物 id 允许含点号，所以只按**最后一个**点切叶子名，绝不 `split('.')`：`pets.a.b.say` 的宠物是
 * `a.b`。规则在这里而不是在分发处，是为了能脱离 React 断言——两端共用同一份口径。
 */
export function resolveLeafPath(path: string): LeafTarget | null {
  if (path.startsWith('sections.')) {
    const name = path.slice('sections.'.length);
    return isSectionLeafName(name) ? { where: 'section', name } : null;
  }
  if (!path.startsWith('pets.')) return null;
  const rest = path.slice('pets.'.length);
  const dot = rest.lastIndexOf('.');
  // dot ≤ 0：没有叶子名（`pets.a`）或宠物 id 为空（`pets..say`）——都不是合法落点。
  if (dot <= 0) return null;
  const name = rest.slice(dot + 1);
  return isPetLeafName(name) ? { where: 'pet', name, petId: rest.slice(0, dot) } : null;
}

/** 类型收窄：余额叶子 → `{ state, manual }`。
 *  manual = 这次写入是手动触发的（/balance 命令、桌面「查看余额」菜单），由宿主在写入时标记，
 *  消费端据此决定余额不可用时要不要必弹文字说明。形状非法 → null，消费端跳过这一拍。 */
export function readBalance(leaf: StateLeaf): { state: BalanceState; manual: boolean } | null {
  const state = toBalanceState(leaf.data);
  if (!state) return null;
  const manual = (leaf.data as { manual?: unknown }).manual === true;
  return { state, manual };
}

/** 说话指令（`pets.<id>.say` 的两种形态）。
 *  say：弹一个气泡，duration = 显示时长（毫秒；缺省 10s，0 = 字面意思「不显示」），
 *  anim 只在显式 false 时出现，表示这次不联动 events.whisper 动画、只弹气泡。
 *  clear：收起当前气泡（POST /bubble/clear 的落点），必须是单独形态——空文本会被判成非法、整拍跳过。
 *  配图两种形态并列、由字段名区分：image = 表情包池内的名称（消费端拼图片路径），url = 第三方给的完整地址。
 *  不做「一个中性字段装两种值」：消费端必须知道该不该拼路径，靠 startsWith('http') 嗅探在名字像 URL 时会出错。
 *  voiceTo：宿主指定这一句该由哪一端念（目前只有周期碎碎念与待办提醒写入）；缺省 = 谁都不念。
 */
export type SayCue =
  | {
      kind: 'say';
      text: string;
      image?: string;
      url?: string;
      duration?: number;
      anim?: boolean;
      voiceTo?: VoiceTarget;
    }
  | { kind: 'clear' };

/** 一次说话该由哪一端念；与 src/host/surface 的同名联合体是两份（宿主不 import src/shared），改动时两边一起改。 */
export type VoiceTarget = 'web' | 'desktop';

/** 类型收窄：宠物说话叶子 → SayCue（形状非法或空文本 → null，消费端跳过这一拍）。
 *  碎碎念、命令气泡、对话回复共用这一个叶子——前端本来就是同一条展示链路。
 *  duration 与 anim 缺省即默认行为（10s + 联动），不写这两个字段的叶子照常能读。 */
export function readSay(leaf: StateLeaf): SayCue | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as {
    text?: unknown;
    image?: unknown;
    url?: unknown;
    duration?: unknown;
    anim?: unknown;
    voiceTo?: unknown;
    clear?: unknown;
  };
  // 清空指令优先：它不带 text，所以必须排在文本校验前面
  if (d.clear === true) return { kind: 'clear' };
  if (typeof d.text !== 'string' || !d.text) return null;
  return {
    kind: 'say',
    text: d.text,
    image: typeof d.image === 'string' ? d.image : undefined,
    // 第三方给的配图地址（完整 URL，scheme 已由宿主卡在 http/https）。与 image 并列、互斥，
    // 消费端有 url 就用 url，否则拼表情包路径——判别位在字段名上，见 SayCue 的说明。
    url: typeof d.url === 'string' ? d.url : undefined,
    // 只认 ≥0 的有限数：非法值当没给（写端已校验，这里只是防御，不让脏数据毁掉整拍）
    duration: typeof d.duration === 'number' && Number.isFinite(d.duration) && d.duration >= 0 ? d.duration : undefined,
    anim: typeof d.anim === 'boolean' ? d.anim : undefined,
    // 只认两个合法字面量：写错的一端名等于「不指定」，消费端据此不念
    voiceTo: d.voiceTo === 'web' || d.voiceTo === 'desktop' ? d.voiceTo : undefined,
  };
}

/** 类型收窄：工作状态叶子 → 快照（形状非法 → null，消费端跳过这一拍）。
 *  与余额不同没有「手动」标记：工作状态永远由 DSH 事件驱动，没有用户主动要的那条路。 */
export function readWorkStatus(leaf: StateLeaf): WorkStatusSnapshot | null {
  return toWorkStatus(leaf.data);
}

/** 朝向：left = 素材原样，right = 镜像（渲染端贴 scaleX(-1)）。
 *  与宿主半侧的同名联合体是两份（宿主不 import 本目录），改动时两边要一起改。 */
export type PetFacing = 'left' | 'right';

/** 类型收窄：点播动画叶子 → 动画名或地址 + 播放回执（两者都空 → null，消费端跳过这一拍）。
 *  name：该宠物动画池内的名字，名字即文件名，消费端换源并走菜单动作处理（镜像修正、移动类走真实位移）；
 *  url：第三方给的完整地址，直接换源播一次、不走菜单语义——裸地址没有「是不是文字类/移动类」这些属性。
 *  「这个动画是否存在于该宠物」由宿主在写入前保证，播放端不兜底。
 *  playbackId 是宿主受理时生成的回执编号，渲染端在播放的四个时机上报真实状态；
 *  老宿主不写这个字段 → undefined，按「无回执」处理。
 *  facing 是调用方显式指定的朝向：undefined = 没指定，不动朝向，保持当前朝向——不是回落 left。 */
export function readAnim(
  leaf: StateLeaf,
): { name?: string; url?: string; playbackId?: string; facing?: PetFacing } | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as { name?: unknown; url?: unknown; playbackId?: unknown; facing?: unknown };
  const name = typeof d.name === 'string' && d.name ? d.name : undefined;
  const url = typeof d.url === 'string' && d.url ? d.url : undefined;
  // 两个都缺席 = 形状非法（宿主写端保证恰好一个，这里不替它猜）
  if (name === undefined && url === undefined) return null;
  return {
    name,
    url,
    playbackId: typeof d.playbackId === 'string' && d.playbackId ? d.playbackId : undefined,
    // 朝向：只认两个字面量，其余（含缺省、老宿主、脏值）一律 undefined = 不动朝向
    facing: d.facing === 'left' || d.facing === 'right' ? d.facing : undefined,
  };
}

/** 占用锁叶子的形态：`{ locked: true, expiresAt }` = 正被第三方占用，`{ locked: false }` = 没有占用。 */
export type LockState = { locked: true; expiresAt: number } | { locked: false };

/** 类型收窄：占用锁叶子 → LockState（形状非法 → null，消费端跳过这一拍）。
 *
 *  这是状态不是指令：宿主写、渲染端读来决定要不要冻结自己——随机链不掷骰、暂停自播动画、
 *  忽略自动来源的余额与工作状态表现。宿主停不掉一段正在播的视频，「完全静止」最终由渲染端执行。
 *
 *  宿主不会到点推一次「锁没了」：expiresAt 是唯一真相，渲染端据此自己定时解除（宿主侧过期是懒判的）。
 *  读到已经过去的 expiresAt 就等于没有锁——刷新页面后拿到陈旧叶子时必须按这个判，不能只看 locked。
 *  不含 lockId：那是持锁者的凭证，不能放进人人可读的 /state。
 */
export function readLock(leaf: StateLeaf): LockState | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as { locked?: unknown; expiresAt?: unknown };
  if (d.locked === false) return { locked: false };
  if (d.locked !== true) return null;
  // locked:true 却缺 expiresAt（或非法）= 形状非法：宁可不冻结，也不猜一个到期时刻
  if (typeof d.expiresAt !== 'number' || !Number.isFinite(d.expiresAt)) return null;
  return { locked: true, expiresAt: d.expiresAt };
}

/** 位置指令的运动模式（三选一）。与宿主半侧的同名联合体是两份，改动时两边要一起改。 */
export type PositionMode = 'instant' | 'spring' | 'line';

/** 类型收窄：位置指令叶子 → `{ x, y, mode, duration }`（形状非法 → null，消费端跳过这一拍）。
 *  这是指令不是状态上报：宿主写、前端读来挪宠物，前端不往回写。
 *  x/y 是宠物中心的归一化坐标（0~1，宿主写入前已夹取）；duration 只有 line 模式才有，其余恒为 0。 */
export function readPosition(leaf: StateLeaf): { x: number; y: number; mode: PositionMode; duration: number } | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as { x?: unknown; y?: unknown; mode?: unknown; duration?: unknown };
  if (typeof d.x !== 'number' || !Number.isFinite(d.x)) return null;
  if (typeof d.y !== 'number' || !Number.isFinite(d.y)) return null;
  if (d.mode !== 'instant' && d.mode !== 'spring' && d.mode !== 'line') return null;
  if (d.mode === 'line') {
    // line 缺 duration（或非法）就是形状非法：宿主一定会写，写错宁可跳过这一拍，也不替它猜一个时间
    if (typeof d.duration !== 'number' || !Number.isFinite(d.duration) || d.duration < 0) return null;
    return { x: d.x, y: d.y, mode: 'line', duration: d.duration };
  }
  return { x: d.x, y: d.y, mode: d.mode, duration: 0 };
}

/** 类型收窄：抛掷指令叶子 → `{ angle, power }`（形状非法 → null，消费端跳过这一拍）。
 *  angle 单位为度（0 = 正右，逆时针为正）；power 是力度倍率（1.0 = 1200 px/s 软钳速前）。
 *  同样是指令，前端不往回写。 */
export function readThrow(leaf: StateLeaf): { angle: number; power: number } | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as { angle?: unknown; power?: unknown };
  if (typeof d.angle !== 'number' || !Number.isFinite(d.angle)) return null;
  if (typeof d.power !== 'number' || !Number.isFinite(d.power) || d.power <= 0) return null;
  return { angle: d.angle, power: d.power };
}

/** 动作端点：POST 一次，返回是否成功。
 *  动作不返回数据——数据只有 /state 一个出口。调用方收到 ok 后不需要再做别的：动作写叶子会让
 *  顶层 counter 变化，挂着的长轮询那一拍立刻返回。 */
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
