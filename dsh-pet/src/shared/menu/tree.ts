/**
 * 菜单树构建：从动画清单与第三方注册项拼出层级，并做镜像动画过滤。
 *
 * 不碰 DOM；输入是配置与注册数据，输出是纯对象树。
 * 必须始终成立：同一份输入必得同一棵树，层级顺序稳定。
 * @module dsh-pet/src/shared/menu/tree
 */
import { builtinLabel } from '../../locale/actions.ts';
import { chromeText, type ChromeKey } from '../../locale/chrome.ts';
import { DISPLAY_HOTKEY_HINTS, DISPLAY_ORDER } from '../display-hotkey.ts';
import { type Animations, type Category, type PetDisplay } from '../types.ts';
import type { MenuBranch, MenuLeaf, MenuMoreItem, MenuNode } from './types.ts';

/** 睡着时仍然放行的菜单动作：维护类、「叫醒它」本身，以及第三方菜单项。
 *  第三方要做什么由它自己决定——真去驱动宠物时会带占用锁调接口，宿主闸门在那一层再判
 *  （锁优先）。在渲染端先拦掉，等于让「更多」里的第三方入口在睡觉时整体失效。 */
const SLEEP_ALLOWED_ACTIONS: readonly string[] = ['sleep', 'wake', 'home', 'set-display', 'reload', 'third-party'];

/** 该菜单动作在睡着时是否放行（两端共用：对话弹窗、待办面板、动作点播都是渲染端行为，宿主闸门拦不到）。 */
export const isSleepAllowedAction = (action: string | undefined): boolean =>
  action !== undefined && SLEEP_ALLOWED_ACTIONS.includes(action);

/** 四个显示位置的文案键；键是 {@link DISPLAY_ORDER} 的元素，顺序以那边为准。 */
const DISPLAY_KEYS: Readonly<Record<PetDisplay, ChromeKey>> = {
  web: 'menu.display.web',
  desktop: 'menu.display.desktop',
  both: 'menu.display.both',
  none: 'menu.display.none',
};

/** 「显示位置」子菜单：两端注入同一份，文案与设置页的显示位置下拉框一致。
 *  两端各写一份必然漂移，而这一项语义对称：桌面端用它把宠物送走，浏览器端用它送到桌面。
 *  「都不」是单向门（恢复入口是设置页），其余三个值都能从某一端改回来。
 *  右侧键帽由 `1`-`4` 数字键的同一份顺序派生，改顺序只改 {@link DISPLAY_ORDER}。
 *  `localeId` 缺省时保持中文，已有调用点不用改签名也能出原来的菜单。 */
export const displayMenuBranch = (localeId?: string | null): MenuBranch => ({
  label: chromeText(localeId, 'menu.display'),
  children: DISPLAY_ORDER.map((display, index): MenuLeaf => ({
    label: chromeText(localeId, DISPLAY_KEYS[display]),
    action: 'set-display',
    display,
    hint: DISPLAY_HOTKEY_HINTS[index],
  })),
});

/** 第三方菜单项统一收在这个一级菜单下（宿主自己的菜单项不进这里）。 */
export const MORE_MENU_LABEL = '更多';

/** 从 /state 的 sections.menu.data 里读出本端要显示的第三方菜单项。
 *  target 等于本端身份或 both 才收；target 缺失或不认识时按 both 处理——老宿主没有这个字段，
 *  宁可在两端都显示，也不要让一个正在用的第三方菜单凭空消失。
 *  快照来自网络，字段一律按「可能不存在」处理：坏条目静默丢弃，不能让一条数据搞崩菜单。 */
export function readMenuItems(data: unknown, surface: 'web' | 'desktop'): MenuMoreItem[] {
  if (!data || typeof data !== 'object') return [];
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: MenuMoreItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    // 端过滤：只认三个字面量，其余（缺失 / 写坏）一律当 both
    const rawTarget = rec.target;
    const target = rawTarget === 'web' || rawTarget === 'desktop' || rawTarget === 'both' ? rawTarget : 'both';
    if (target !== 'both' && target !== surface) continue;
    const owner = rec.owner;
    const label = rec.label;
    if (typeof owner === 'string' && owner !== '' && typeof label === 'string' && label !== '') {
      out.push({ owner, label });
    }
  }
  return out;
}

/** 「更多」一级菜单：把第三方菜单项拼成菜单树的一枝；没有第三方项时返回 null，菜单里不会出现空的「更多」。
 *  层级只按项数决定：某 owner 只有 1 项就直接平铺（少一次点击），2 项及以上才加 owner 这一层。
 *  同名不同 owner 的项允许共存，不做去重、编号或来源标注——第三方写的 label 原样保留。
 *  只有「更多」这一层标题随宿主语言变。 */
export function buildMoreBranch(items: readonly MenuMoreItem[], localeId?: string | null): MenuBranch | null {
  // owner → 项名（Map 保序：注册顺序 = 分组顺序 = 组内顺序）
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const list = groups.get(item.owner);
    if (list) list.push(item.label);
    else groups.set(item.owner, [item.label]);
  }
  const children: MenuNode[] = [];
  for (const [owner, labels] of groups) {
    if (labels.length === 1) {
      children.push({ label: labels[0], action: 'third-party', owner });
    } else {
      children.push({
        label: owner,
        children: labels.map((label) => ({ label, action: 'third-party' as const, owner })),
      });
    }
  }
  return children.length > 0 ? { label: chromeText(localeId, 'menu.more'), children } : null;
}

/** 把动画名包成叶子。`anim` 始终是配置里的名字；可见标题在 ru 时才换成译文。 */
export const leaf = (anim: string, localeId?: string | null): MenuLeaf => ({
  label: builtinLabel(localeId, anim),
  anim,
});

/** 事件名 → 文案键。没有键的事件在 ru 时直接显示事件名。 */
const EVENT_KEYS: Readonly<Record<string, ChromeKey>> = {
  balance: 'menu.event.balance',
  whisper: 'menu.event.whisper',
  workStatus: 'menu.event.workStatus',
};

/** 由成品 animations 配置推导菜单树：一级「动作」→ 二级分类 → 三级动画名；空池与空分类自动省略。 */
export function buildMenuTree(animations: Animations, localeId?: string | null): MenuNode[] {
  const groups: MenuNode[] = [];
  const pools: Array<[ChromeKey, string[]]> = [
    ['menu.pool.idle', animations.idle],
    ['menu.pool.turn', animations.turn],
    ['menu.pool.drag', animations.drag],
    ['menu.pool.clicks', animations.clicks],
    ['menu.pool.moves', animations.moves.actions.map((m) => m.name)],
  ];
  for (const [key, pool] of pools) {
    if (pool.length)
      groups.push({ label: chromeText(localeId, key), children: pool.map((name) => leaf(name, localeId)) });
  }
  // 随机动作分类：noMirror 分类照样可点播，播放端朝右时强制朝左（见 isNoMirrorAnimation）
  const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
  for (const c of cats) {
    groups.push({ label: builtinLabel(localeId, c.id), children: c.actions.map((name) => leaf(name, localeId)) });
  }
  // 事件动画：每个事件一个分类，不来自随机链；数组槽位展平为逐个叶子，候选都可点播预览。
  const events = animations.events ?? {};
  for (const key of Object.keys(events)) {
    const pool = events[key] ?? [];
    const names: string[] = [];
    for (const slot of pool) {
      if (typeof slot === 'string') names.push(slot);
      else names.push(...slot);
    }
    if (!names.length) continue;
    const eventKey = EVENT_KEYS[key];
    const label = eventKey ? chromeText(localeId, eventKey) : key;
    groups.push({ label, children: names.map((name) => leaf(name, localeId)) });
  }
  if (!groups.length) return [];
  return [{ label: chromeText(localeId, 'menu.actions'), children: groups }];
}

/** 该动画是否属于 noMirror 分类（文字类）：朝右镜像时点播前强制朝左，避免文字镜像。 */
export function isNoMirrorAnimation(categories: Category[], anim: string): boolean {
  return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}
