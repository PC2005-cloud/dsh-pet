/**
 * 气泡两个端点（`POST /dsh-pet-7340/broadcast` 与 `POST /dsh-pet-7340/bubble/clear`）的
 * **纯决策层**——两者写的是同一个叶子（`pets.<id>.say`），也共用同一条"pet 落到哪只"的规则，
 * 所以放在一起，免得两处各写一遍走样。
 *
 * 背景（issue #76）：宿主侧其他插件（女仆巡检验等）想说自己的话，需要一个把它们给的文本
 * 放进桌宠气泡的入口。这个端点**不生成**内容，只搬运——和 /whisper（用 LLM 生成）分工不同。
 * `POST /bubble/clear` 是它的反面：收起气泡（issue #122 第 5 条的"提前撤回"）。
 *
 * 为什么单独一层：本功能的契约就是这几条校验规则（文本非空、时长合法、宠物必须真实存在、
 * 配图给名称时须命中包内表情包池、给 url 时须是 http/https 完整地址、两种形态不得同时给），
 * 它们必须能脱离 HTTP 与真实文件系统被单测——路由层
 * （src/host/index.ts）在源码形态下读不到包内 assets，测不了这些分支。
 *
 * 设计口径：
 * - **不设长度限制，也不限频**：投喂是显式的调用方行为，内容与频率都由调用方自己负责；
 *   宿主只保证"非空就搬运"，不做静默丢弃、截断或排队。
 * - `duration` **不设上限**（调用方自己负责），但必须是 ≥0 的有限数；`0` = 字面意思「不显示」。
 * - `anim` 只有**严格 `false`** 才关闭动画联动（宽松口径：`"false"` 字符串之类一律按"要联动"
 *   走）。关闭时消费端不查 `events.whisper` 池、不换源。
 * - 配图两种形态二选一：`image` 只认**该桌宠条目表情包池内**的名称（池内命中即取其规范名，
 *   与对话选图共用同一份 matchMeme 校验）；`url` 是第三方自带的完整地址，**不查池**
 *   （issue #122 第 1 条：素材由第三方自己托管）。给了 url 就等于调用方显式选择了外部地址，
 *   不再是"注入"——但 scheme 仍由宿主卡在 http/https。
 * - 失败一律返回明确 reason，不抛异常（路由据此回 HTTP 200 + ok:false，与 /chat 口径一致）。
 * - memeDirs 是参数而非模块常量：池的目录链由调用方（host/index.ts 的 memeDirsFor）唯一决定，
 *   便于测试注入临时目录（同 memes.ts 的约定）。
 */

import { findPetInstance } from './config';
import { matchMeme, readMemePool } from './memes';
// url 参数的 scheme 规则与 /anim 是**同一条**（两个"第三方投喂"端点不各写一份，免得走样）
import { normalizeHttpUrl } from './anim';

/** 气泡默认显示时长（ms）——与两端消费侧的常量同值（host 不得 import src/shared，只能各写一份）。
 *  这个值只用于**把缺省解析成显式值**写进叶子，让 /state 里能看到实际生效的时长。 */
const DEFAULT_BUBBLE_DURATION_MS = 10 * 1000;

/** pet 参数解析失败的两种分类（三个"pet 必填"端点共用这一对词汇，与 ./anim、./motion-cue 同口径） */
export type PetFailure = 'pet-required' | 'unknown-pet';

/** 投喂失败的分类（路由原样透出给调用方） */
export type BroadcastFailure = 'bad-request' | PetFailure | 'unknown-image';

/** 决策结论：通过则给出最终要写进 S 的内容，否则给出显式原因。
 *  `image` 与 `url` **最多一个**（配图两种形态，由字段名区分，见 shared/state.ts 的 SayCue）。
 *  `duration` / `anim` 是**已解析**的生效值（缺省也已填成显式值），路由原样写进叶子。 */
export type BroadcastDecision =
  | { ok: true; petId: string; text: string; image?: string; url?: string; duration: number; anim: boolean }
  | { ok: false; reason: BroadcastFailure; message: string };

/** 清空气泡的决策结论（只有宠物解析这一步会失败） */
export type BubbleClearDecision = { ok: true; petId: string } | { ok: false; reason: PetFailure; message: string };

/**
 * 投喂文本规范化：非字符串 / 纯空白 → 空串。
 * 路由与决策层**共用这一条规则**（路由用它先短路掉"空文本"，避免为了一个必然失败的
 * 请求去读配置；两处若各写一遍就会走样）。
 */
export function normalizeBroadcastText(text: unknown): string {
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * 气泡时长规范化：缺省 / null → 默认 10s；合法则原样；**非法返回 null**。
 * 同样由路由与决策层共用——路由先短路，别为一个必然失败的请求去碰磁盘。
 * 非法 = 非数字 / 非有限（NaN、Infinity）/ 负数。`0` 是合法值（字面意思：不显示）。
 */
export function normalizeBroadcastDuration(duration: unknown): number | null {
  if (duration === undefined || duration === null) return DEFAULT_BUBBLE_DURATION_MS;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  return duration;
}

/**
 * 动画联动开关规范化：**只有严格 `false` 才关闭**，其余（含缺省、`true`、字符串、数字）
 * 一律按"要联动"处理。
 * 宽松是有意的：老调用方不会传这个字段，宽松口径保证它们的行为一个字都不变。
 */
export function normalizeBroadcastAnim(anim: unknown): boolean {
  return anim !== false;
}

/**
 * `?pet=` → 实际落点（与 ./anim、./motion-cue 同一口径）：**必填**且必须真实存在。
 *
 * 两种失败分开报（issue #122 第 1 条「绝不默认退到列表第一只」）：没给 → `pet-required`；
 * 给了但配置里没有 → `unknown-pet`。收紧前这里是 `requested || active || 'main'`——`active`
 * 是"当前桌宠" = **有效宠物列表第一只**，落点随用户 /pet 操作而变，第三方无从预期，故整条删除。
 */
function resolvePetId(
  cfg: Record<string, Record<string, unknown>>,
  requested: string,
):
  | { ok: true; petId: string; entry: string; conf: Record<string, unknown> }
  | { ok: false; reason: PetFailure; message: string } {
  const petId = String(requested ?? '').trim();
  if (!petId) return { ok: false, reason: 'pet-required', message: 'pet 必填：要指定操作哪只桌宠' };
  // **一次查找同时给出"存在性"与"所属条目"**（entry = 素材根，配图池按它取）：校验与取值用同一份
  // 结果，后面不必再查一次，也就不留"查不到时兜底 main"那种**不可达分支**（那是老代码的遗留——
  // 那时 pet 允许缺省，确实可能查不到）。
  const found = findPetInstance(cfg, petId);
  if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
  return { ok: true, petId, entry: found.entry, conf: found.conf };
}

/**
 * 把外部给的 `{ text, image, url, duration, anim }` 与当前配置核对成一个结论。
 *
 * 配图两种形态**二选一**（issue #122 第 1 条的"资源注册"）：`image` = 池内名称（照旧校验），
 * `url` = 第三方自带的完整地址（**不查池**）。两个都给 = 意图不明，回 bad-request。
 *
 * @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
 * @param requested `?pet=` 的原值（**必填**：空串 → `pet-required`）
 * @param text 外部给的文本（未规范化）
 * @param image 外部给的配图名（未规范化；空/缺省 = 不配图）
 * @param url 外部给的配图地址（未规范化；空/缺省 = 不配图）
 * @param duration **已规范化**的时长（见 normalizeBroadcastDuration；路由保证非 null）
 * @param anim **已规范化**的联动开关（见 normalizeBroadcastAnim）
 * @param memeDirs 条目（素材根）→ 表情包目录链（顺序即优先级）；决定池里哪些图真实存在
 */
export function decideBroadcast(args: {
  cfg: Record<string, Record<string, unknown>>;
  /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
  requested: string;
  text: unknown;
  image: unknown;
  url: unknown;
  duration: number;
  anim: boolean;
  memeDirs: (entry: string) => string[];
}): BroadcastDecision {
  const { cfg, requested, memeDirs } = args;

  const text = normalizeBroadcastText(args.text);
  if (!text) return { ok: false, reason: 'bad-request', message: 'text 为空' };

  const who = resolvePetId(cfg, requested);
  if (!who.ok) return { ok: false, reason: who.reason, message: who.message };
  const petId = who.petId;

  const rawImage = typeof args.image === 'string' ? args.image.trim() : '';
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (rawImage && rawUrl) return { ok: false, reason: 'bad-request', message: 'image 与 url 只能给一个' };
  if (!rawImage && !rawUrl) return { ok: true, petId, text, duration: args.duration, anim: args.anim };

  // url 形态：地址合法即放行——**不查表情包池**（图在第三方手里，池里当然没有）。取不到图由
  // 消费端自己表现（图裂），宿主不做代理、也不预取，所以这里没有可校验的"图是否真实存在"。
  if (rawUrl) {
    const url = normalizeHttpUrl(rawUrl);
    if (url === null) {
      return { ok: false, reason: 'bad-request', message: 'url 必须是 http/https 的完整地址' };
    }
    return { ok: true, petId, text, url, duration: args.duration, anim: args.anim };
  }

  // 配图：只认池内命中的名称（命中后用池里的规范名，而不是外部原样传入的字符串）
  // 池按**所属条目**取（与碎碎念/对话同一口径）：配图不跨宠物串池
  const hit = matchMeme(readMemePool(who.conf.memes, memeDirs(who.entry)), rawImage);
  if (!hit) {
    return { ok: false, reason: 'unknown-image', message: '配图不在表情包池内：' + rawImage };
  }
  return { ok: true, petId, text, image: hit.name, duration: args.duration, anim: args.anim };
}

/**
 * 清空气泡的决策：只需要确定"清哪只宠物的"。
 *
 * **占用门禁不在这里**：本函数只管"清哪一只"，"谁有资格清"由路由层在它之后过一遍
 * `lockBlocked`（占用期间只有持锁者能清——否则第三方一调就把别人的气泡抹了）。没带 `lock`
 * 时那一步放行，所以本函数的语义与改造前**逐字一致**；带了失效编号则由 `lockBlocked` 拦下。
 *
 * 与 /broadcast 的区别：**没有"气泡不存在"这种失败**。当前没气泡也返回 ok（幂等），
 * 因为"让气泡消失"这个意图在空状态下已经成立了。
 */
export function decideBubbleClear(args: {
  cfg: Record<string, Record<string, unknown>>;
  /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
  requested: string;
}): BubbleClearDecision {
  const who = resolvePetId(args.cfg, args.requested);
  if (!who.ok) return { ok: false, reason: who.reason, message: who.message };
  return { ok: true, petId: who.petId };
}
