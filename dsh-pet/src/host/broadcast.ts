/**
 * 第三方投喂（`POST /dsh-pet-7340/broadcast`）的**纯决策层**。
 *
 * 背景（issue #76）：宿主侧其他插件（女仆巡检验等）想说自己的话，需要一个把它们给的文本
 * 放进桌宠气泡的入口。这个端点**不生成**内容，只搬运——和 /whisper（用 LLM 生成）分工不同。
 *
 * 为什么单独一层：本功能的契约就是这几条校验规则（文本非空、宠物必须真实存在、
 * 配图必须命中包内表情包池），它们必须能脱离 HTTP 与真实文件系统被单测——路由层
 * （src/host/index.ts）在源码形态下读不到包内 assets，测不了这些分支。
 *
 * 设计口径：
 * - **不设长度限制，也不限频**：投喂是显式的调用方行为，内容与频率都由调用方自己负责；
 *   宿主只保证"非空就搬运"，不做静默丢弃、截断或排队。
 * - 配图只认**该桌宠条目表情包池内**的名称（池内命中即取其规范名）：杜绝第三方注入外部地址，
 *   前端也就不会去加载任意 URL。与对话选图共用同一份 matchMeme 校验。
 * - 失败一律返回明确 reason，不抛异常（路由据此回 HTTP 200 + ok:false，与 /chat 口径一致）。
 * - memeDirs 是参数而非模块常量：池的目录链由调用方（host/index.ts 的 memeDirsFor）唯一决定，
 *   便于测试注入临时目录（同 memes.ts 的约定）。
 */

import { findPetInstance, flattenPetList } from './config';
import { matchMeme, readMemePool } from './memes';

/** 投喂失败的分类（路由原样透出给调用方） */
export type BroadcastFailure = 'bad-request' | 'unknown-pet' | 'unknown-image';

/** 决策结论：通过则给出最终要写进 S 的内容，否则给出显式原因 */
export type BroadcastDecision =
  { ok: true; petId: string; text: string; image?: string } | { ok: false; reason: BroadcastFailure; message: string };

/**
 * 投喂文本规范化：非字符串 / 纯空白 → 空串。
 * 路由与决策层**共用这一条规则**（路由用它先短路掉"空文本"，避免为了一个必然失败的
 * 请求去读配置；两处若各写一遍就会走样）。
 */
export function normalizeBroadcastText(text: unknown): string {
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * 把外部给的 `{ text, image }` 与当前配置核对成一个结论。
 *
 * @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
 * @param requested `?pet=` 的原值（可为空串）
 * @param active `resolveActivePetId()` 的结果（可为空串；无宠物时为空）
 * @param text 外部给的文本（未规范化）
 * @param image 外部给的配图名（未规范化；空/缺省 = 不配图）
 * @param memeDirs 条目（素材根）→ 表情包目录链（顺序即优先级）；决定池里哪些图真实存在
 */
export function decideBroadcast(args: {
  cfg: Record<string, Record<string, unknown>>;
  requested: string;
  active: string;
  text: unknown;
  image: unknown;
  memeDirs: (entry: string) => string[];
}): BroadcastDecision {
  const { cfg, requested, active, memeDirs } = args;

  const text = normalizeBroadcastText(args.text);
  if (!text) return { ok: false, reason: 'bad-request', message: 'text 为空' };

  // pet 缺省 = 当前桌宠；active 也为空时兜底 main（让请求有个确定落点，而不是静默丢弃）
  const petId = String(requested || active || 'main');
  if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) {
    return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
  }

  const rawImage = typeof args.image === 'string' ? args.image.trim() : '';
  if (!rawImage) return { ok: true, petId, text };

  // 配图：只认池内命中的名称（命中后用池里的规范名，而不是外部原样传入的字符串）
  // 池按**所属条目**取（与碎碎念/对话同一口径）：配图不跨宠物串池
  const found = findPetInstance(cfg, petId);
  const conf = found ? found.conf : (cfg.main ?? {});
  const hit = matchMeme(readMemePool(conf.memes, memeDirs(found ? found.entry : 'main')), rawImage);
  if (!hit) {
    return { ok: false, reason: 'unknown-image', message: '配图不在表情包池内：' + rawImage };
  }
  return { ok: true, petId, text, image: hit.name };
}
