/**
 * 表情包池（host 半侧）：把配置的 memes 映射（名称 → 描述）解析成可用的候选池。
 *
 * 设计：
 * - memes 是「键 = <表情包目录>/<键>.png，值 = 该图内容描述」，碎碎念/对话共用同一张表；
 * - 目录是一条**链**（调用方给，顺序即优先级）：种类独占目录 → 用户目录 → 包内目录。
 *   名字在链上任一目录里存在即算命中——这与 /pic/memes 路由的逐目录查找**必须同一份顺序**
 *   （池说"这张能选"，路由就得"取得到"，否则气泡会图裂）；链怎么算由调用方
 *   （host/index.ts 的 memeDirsFor）唯一决定，本模块只按给定顺序查盘；
 * - 只认**磁盘上真实存在**的图片：配置里写了但文件缺失的条目静默剔除（不告警刷屏，
 *   用户删图后不必同步改配置）；文件在但配置没写的图不参与（无从得知它的描述）；
 * - 顺序 = **配置里写的顺序**（不排序）：它是对外可见的语义——chatImageLimit 的"前 N 张"
 *   与交给模型看的清单都按它走，用户靠调整书写顺序决定优先级；
 * - 纯函数 + 目录参数，便于测试（不碰全局状态）。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 池中一张图：name = 配置键（= 文件名去扩展名），desc = 给模型看的描述 */
export interface MemeEntry {
  name: string;
  desc: string;
}

/**
 * 从配置的 memes 映射解析出候选池。
 * @param memes 配置的 memes 值（未配置/类型非法 → 空池）
 * @param dirs 表情包目录链（顺序即优先级；空链 → 空池）
 * @returns 按**配置里写的顺序**排列的候选池（链上哪个目录都没有该图、或描述为空 → 剔除）
 */
export function readMemePool(memes: unknown, dirs: readonly string[]): MemeEntry[] {
  if (!memes || typeof memes !== 'object' || Array.isArray(memes)) return [];
  if (dirs.length === 0) return [];
  const out: MemeEntry[] = [];
  for (const [name, desc] of Object.entries(memes as Record<string, unknown>)) {
    const text = typeof desc === 'string' ? desc.trim() : '';
    if (!name || !text) continue;
    if (!dirs.some((dir) => existsSync(join(dir, name + '.png')))) continue;
    out.push({ name, desc: text });
  }
  // 刻意**不排序**：顺序 = 配置里写的顺序，它是给用户用的（chatImageLimit 的"前 N 张"、
  // 以及交给模型看的清单顺序都跟着它）。曾经按名称 localeCompare('zh') 排过——那让
  // "前 N 张"变成拼音序最靠前的 N 张，用户没法决定哪几张被发出去，已改掉。
  // 注：JSON.parse 保留字符串键的书写顺序（纯数字键例外，会被 JS 提到最前），
  // 所以这里读到的就是配置文件里的先后。
  return out;
}

/** 抽一张图（均匀随机）；空池返回 undefined */
export function pickMeme(pool: MemeEntry[], random: () => number = Math.random): MemeEntry | undefined {
  if (pool.length === 0) return undefined;
  const idx = Math.floor(random() * pool.length) % pool.length;
  return pool[idx];
}

/** 模型选图校验：只在池内命中时才认（防幻觉出池外名称）；命中返回该条目，否则 undefined */
export function matchMeme(pool: MemeEntry[], name: string): MemeEntry | undefined {
  const key = String(name ?? '').trim();
  return key ? pool.find((m) => m.name === key) : undefined;
}

/** 配图选择标记：`[图:名称]` 附在回复末尾（容忍全角冒号与前后空白） */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;

/**
 * 从模型回复里取配图（对话选图的解析半侧；纯函数，无 LLM 依赖）：
 * - 命中池内 → 采纳该图，并把标记从正文剥离（标记不得留在用户可见文本里）；
 * - 未命中（模型幻觉名称）/ 空池 / 只回标记不回正文 → 一律视为"没选"，
 *   **正文原样保留**（解析失败绝不吞掉回复）。
 */
export function extractChatImage(text: string, pool: MemeEntry[]): { text: string; image?: string } {
  const m = IMG_TAG.exec(text);
  if (!m) return { text };
  const hit = matchMeme(pool, m[1] ?? '');
  const body = text.slice(0, m.index).trim();
  if (!hit || !body) return { text };
  return { text: body, image: hit.name };
}

/** 表情包清单 → 给模型看的候选列表（一行一张：名称 + 描述） */
export function memeCatalog(pool: MemeEntry[]): string {
  return pool.map((m) => '- ' + m.name + '：' + m.desc).join('\n');
}

/**
 * 按「对话配图张数上限」（配置 chatImageLimit）截断候选池。
 *
 * 语义（与配置注释、设置页提示同一套口径）：
 *   - `limit <= 0` / 非有限数 → **原样返回**（0 = 不限制，与旧行为逐字一致）；
 *   - `limit > 0` → 取**池内前 limit 张**。池由 readMemePool 按**配置里写的顺序**给出，
 *     所以"前 N 张"就是你在配置里写在前面的那 N 条——想让哪几张优先被发出去，往前写就行。
 *   - 小数向下取整（与 slice 的口径一致，避免出现"取 2.5 张"这种含糊值）。
 *
 * 为什么要它：整张清单是**每条对话消息都要附**的（见 chat.ts 的 imageInstruction），
 * token 随张数线性增长；截断后模型只从这几张里挑，单条消息的配图开销上限立刻可控。
 * 只作用于对话选图——碎碎念只带抽中的那一张（whisper 侧不经过本函数）。
 */
export function limitPool(pool: MemeEntry[], limit: number): MemeEntry[] {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return pool;
  return pool.slice(0, n);
}
