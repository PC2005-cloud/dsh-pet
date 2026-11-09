/**
 * 菜单树构建：从动画清单与第三方注册项拼出层级，并做镜像动画过滤。
 *
 * 不碰 DOM；输入是配置与注册数据，输出是纯对象树。
 * 必须始终成立：同一份输入必得同一棵树，层级顺序稳定。
 * @module dsh-pet/src/shared/menu/tree
 */
import { DISPLAY_ORDER } from '../display-hotkey.ts';
import { uiT, type Key } from '../ui/i18n.ts';
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
const DISPLAY_LABEL_KEYS: Readonly<Record<PetDisplay, Key>> = {
  web: 'menu.display.web',
  desktop: 'menu.display.desktop',
  both: 'menu.display.both',
  none: 'menu.display.none',
};

/** 「显示位置」子菜单：两端注入同一份，文案与设置页的显示位置下拉框一致。
 *  两端各写一份必然漂移，而这一项语义对称：桌面端用它把宠物送走，浏览器端用它送到桌面。
 *  「都不」是单向门（恢复入口是设置页），其余三个值都能从某一端改回来。
 *  右侧键帽由 `1`-`4` 数字键的同一份顺序派生，改顺序只改 {@link DISPLAY_ORDER}。 */
export const displayMenuBranch = (): MenuBranch => ({
  label: uiT('menu.display'),
  children: DISPLAY_ORDER.map((display, index): MenuLeaf => ({
    label: uiT(DISPLAY_LABEL_KEYS[display]),
    action: 'set-display',
    display,
    hint: uiT('hotkey.display', { key: String(index + 1) }),
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

/** 「更多」：第三方菜单项的固定容器；没有第三方项时返回 null，菜单里不出现空的「更多」。
 *
 *  层级只按 label 是否重名决定：label 在全部第三方项里唯一 → 直接平铺（`更多 / 弹弓`）；
 *  label 重名 → 每个 owner 各占一个子菜单（`更多 / owner / label`），靠它区分同名项。
 *  重名只可能跨 owner（同一 owner 内 label 按 Map 去重，见 host/menu 的注册表），子项仍是原
 *  label——点击上报的 (owner, label) 与平铺时完全一致，两端点击处理不用分叉。 */
export function buildMoreBranch(items: readonly MenuMoreItem[]): MenuBranch | null {
  const labelCount = new Map<string, number>();
  for (const item of items) labelCount.set(item.label, (labelCount.get(item.label) ?? 0) + 1);
  const children: MenuNode[] = [];
  // owner → 该 owner 的重名子菜单；第一次遇到它的重名项时按当时顺序插进 children（保持注册顺序）
  const branches = new Map<string, MenuBranch>();
  for (const item of items) {
    if ((labelCount.get(item.label) ?? 0) === 1) {
      children.push({ label: item.label, action: 'third-party', owner: item.owner });
      continue;
    }
    let branch = branches.get(item.owner);
    if (branch === undefined) {
      branch = { label: item.owner, children: [] };
      branches.set(item.owner, branch);
      children.push(branch);
    }
    branch.children.push({ label: item.label, action: 'third-party', owner: item.owner });
  }
  return children.length > 0 ? { label: uiT('menu.more'), children } : null;
}

/** 事件名 → 分类文案键（无映射时用事件名本身）。 */
const EVENT_LABEL_KEYS: Record<string, Key> = {
  balance: 'menu.event.balance',
  whisper: 'menu.event.whisper',
  workStatus: 'menu.event.workStatus',
};

/** 把动画名包成叶子。 */
export const leaf = (anim: string): MenuLeaf => ({ label: anim, anim });

/** 由成品 animations 配置推导菜单树：一级「动作」→ 二级分类 → 三级动画名；空池与空分类自动省略。 */
export function buildMenuTree(animations: Animations): MenuNode[] {
  const groups: MenuNode[] = [];
  const pools: Array<[Key, string[]]> = [
    ['menu.group.idle', animations.idle],
    ['menu.group.turn', animations.turn],
    ['menu.group.drag', animations.drag],
    ['menu.group.clicks', animations.clicks],
    ['menu.group.moves', animations.moves.actions.map((m) => m.name)],
  ];
  for (const [label, pool] of pools) {
    if (pool.length) groups.push({ label: uiT(label), children: pool.map(leaf) });
  }
  // 随机动作分类：noMirror 分类照样可点播，播放端朝右时强制朝左（见 isNoMirrorAnimation）
  const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
  for (const c of cats) {
    groups.push({ label: c.id, children: c.actions.map(leaf) });
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
    if (names.length) {
      const eventKey = EVENT_LABEL_KEYS[key];
      groups.push({ label: eventKey === undefined ? key : uiT(eventKey), children: names.map(leaf) });
    }
  }
  if (!groups.length) return [];
  return [{ label: uiT('menu.group.actions'), children: groups }];
}

/** 该动画是否属于 noMirror 分类（文字类）：朝右镜像时点播前强制朝左，避免文字镜像。 */
export function isNoMirrorAnimation(categories: Category[], anim: string): boolean {
  return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}
