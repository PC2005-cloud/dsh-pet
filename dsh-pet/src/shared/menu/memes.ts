/**
 * 右键菜单的「配图」分支：按配置把表情包清单分成「纳入对话的配图」与「其他」两组。
 * 不读磁盘、不判断文件是否仍在——那是宿主的池判定；这里只按配置分组，客户端因此不必联网取清单。
 * @module dsh-pet/src/shared/menu/memes
 */
import { builtinLabel } from '../../locale/actions.ts';
import { chromeText } from '../../locale/chrome.ts';
import { encodeFrameRel, textFrameRel } from '../../locale/text-frames.ts';
import type { MenuBranch, MenuLeaf, MenuNode } from './types.ts';

/** 分组依据：条目级的三项配置，合并器已吹进每只宠物。 */
export interface MemeGroupSource {
  /** 表情包清单（名称 → 描述）；缺省按空池处理。 */
  readonly memes?: Record<string, string> | undefined;
  /** 对话配图开关：关闭时没有「纳入对话」组。 */
  readonly chatImageEnabled?: boolean | undefined;
  /** 对话配图张数上限；0 或非有限数 = 不限制。 */
  readonly chatImageLimit?: number | undefined;
}

/** 两组名称：对话可用的与其余的，两者之和即全部可用图。 */
export interface MemeGroups {
  readonly chat: readonly string[];
  readonly other: readonly string[];
}

/**
 * 可用图的名称清单：描述为空的不算。
 *
 * 与宿主的池判定同口径（`host/memes` 的 readMemePool 要求描述非空）：模型靠描述才认得出这张图，
 * 没描述的条目即使文件存在也进不了对话与碎碎念。顺序保留配置里的书写顺序。
 */
function usableNames(memes: MemeGroupSource['memes']): string[] {
  if (!memes || typeof memes !== 'object' || Array.isArray(memes)) return [];
  const out: string[] = [];
  for (const [name, desc] of Object.entries(memes)) {
    if (!name.trim()) continue;
    if (typeof desc !== 'string' || desc.trim() === '') continue;
    out.push(name);
  }
  return out;
}

/**
 * 按配置把可用图分成两组。
 *
 * @param source - 条目级表情包配置。
 * @returns 对话组（开关关闭时为空）与其余组。
 */
export function groupMemes(source: MemeGroupSource): MemeGroups {
  const names = usableNames(source.memes);
  const limit = Math.floor(Number(source.chatImageLimit));
  // 与宿主 limitPool 同口径：0 / 负数 / 非有限数 = 不限制，取全量。
  const unlimited = !Number.isFinite(limit) || limit <= 0;
  const take = source.chatImageEnabled !== true ? 0 : unlimited ? names.length : Math.min(limit, names.length);
  return { chat: names.slice(0, take), other: names.slice(take) };
}

/** 单张图 → 菜单叶子：点它就是「用这张图说一句」；给了缩略图地址就带上，菜单据此画小图。 */
function memeLeaf(name: string, localeId?: string | null, thumbOf?: (name: string) => string): MenuLeaf {
  const leaf: MenuLeaf = { label: builtinLabel(localeId, name), action: 'whisper', image: name };
  if (thumbOf) leaf.thumb = thumbOf(name);
  return leaf;
}

/**
 * 表情包图片地址：`<前缀>/pic/memes/<素材根>/<名称>.png`。
 *
 * 两端前缀不同（浏览器是路由前缀、桌面是绝对地址），素材根缺省按 `main`——与宿主 /pic 的
 * 归属语义一致：素材根 = 条目 key，决定走哪条目录链。名称含中文，必须整段编码。
 *
 * @param baseUrl - 路由前缀或绝对地址（不含结尾斜杠）。
 * @param assetRoot - 条目 key（= 素材根）；缺省或空串按 `main`。
 * @param name - 表情包名称（配置里的键，不含扩展名）。
 * @returns 可直接用作 img src 的完整地址。
 */
export function memeThumbUrl(
  baseUrl: string,
  assetRoot: string | undefined,
  name: string,
  localeId?: string | null,
): string {
  const root = assetRoot && assetRoot.trim() !== '' ? assetRoot : 'main';
  const rel = textFrameRel(localeId, name);
  return baseUrl + '/pic/memes/' + encodeURIComponent(root) + '/' + encodeFrameRel(rel) + '.png';
}

/**
 * 造「配图」菜单分支；没有可用图时返回 null（调用方据此不插入这一项）。
 *
 * 分组为空就不出现：开关关着时只剩「其他」一组，只有一组也照常带这层子菜单——
 * 平铺会让图名混进「查看余额 / 碎碎念」那一列，反而看不出它们是配图。
 *
 * @param source - 条目级表情包配置。
 * @param thumbOf - 可选：名称 → 缩略图地址。给了菜单每项就带小图，缺省只有文字。
 * @returns 「配图 →（纳入对话的配图 / 其他）」两级分支。
 */
export function buildMemeBranch(
  source: MemeGroupSource,
  thumbOf?: (name: string) => string,
  localeId?: string | null,
): MenuBranch | null {
  const { chat, other } = groupMemes(source);
  const leaf = (name: string): MenuLeaf => memeLeaf(name, localeId, thumbOf);
  const groups: MenuNode[] = [];
  if (chat.length > 0) groups.push({ label: chromeText(localeId, 'menu.memes.chat'), children: chat.map(leaf) });
  if (other.length > 0) groups.push({ label: chromeText(localeId, 'menu.memes.other'), children: other.map(leaf) });
  if (groups.length === 0) return null;
  return { label: chromeText(localeId, 'menu.memes'), children: groups };
}
