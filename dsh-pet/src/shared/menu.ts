/**
 * 两端共用的右键菜单：菜单树推导、级联渲染与样式（浏览器半侧与桌面 Helper 同一份实现）。
 * 不负责业务动作本身：点击只回调 MenuLeaf，由各端壳执行，一级工具项也由壳注入。
 * 菜单数据的唯一来源是成品 animations 配置，用户覆盖层因此自动生效。
 * 每级面板平级挂在根容器下、绝不嵌套（嵌套会被父面板的滚动区裁切）；指针留在树内时子面板保持展开。
 * @module dsh-pet/src/shared/menu
 */
import type { Animations, Category, PetDisplay } from './types';

/** 叶子：可点击的菜单项。 */
export interface MenuLeaf {
  label: string;
  /** 播放的动画名（点播动作）；action 优先于 anim */
  anim?: string;
  /** 自定义动作：打开网站 / 查看余额 / 立即碎碎念 / 打开对话弹窗 / 回到初始位置 /
   *  重载配置（桌面端专属，重启桌面 Helper 并按最新配置重建窗口）/ 改显示位置（目标值见 display，
   *  两端都注入）/ 第三方菜单项（只把 owner 与 label 上报给注册方，具体做什么由它决定）。
   *  手动触发均不受 whisperEnabled 影响——那个字段只关自动轮询。 */
  action?: 'open-site' | 'show-balance' | 'whisper' | 'chat' | 'home' | 'reload' | 'set-display' | 'third-party';
  /** set-display 的目标显示位置（与设置页的下拉框同一套取值） */
  display?: PetDisplay;
  /** third-party：注册它的 owner（身份键，只用于回传，不显示）；同一个 owner 的项收在同一分组下，
   *  只有一项时跳过这层直接平铺。 */
  owner?: string;
  /** 项目右侧的灰色小字（如快捷键）：纯视觉提示，不参与文本匹配也不影响动作分发，缺省不占位。 */
  hint?: string;
}

/** 分支：带子菜单的项。 */
export interface MenuBranch {
  label: string;
  children: MenuNode[];
}

export type MenuNode = MenuLeaf | MenuBranch;

/** 「显示位置」子菜单：两端注入同一份，文案与设置页的显示位置下拉框一致。
 *  两端各写一份必然漂移，而这一项语义对称：桌面端用它把宠物送走，浏览器端用它送到桌面。
 *  「都不」是单向门（恢复入口是设置页），其余三个值都能从某一端改回来。 */
export const displayMenuBranch = (): MenuBranch => ({
  label: '显示位置',
  children: [
    { label: '仅网页', action: 'set-display', display: 'web' },
    { label: '仅桌面', action: 'set-display', display: 'desktop' },
    { label: '两者', action: 'set-display', display: 'both' },
    { label: '都不', action: 'set-display', display: 'none' },
  ],
});

/** 第三方菜单项（宿主经 /state 的 sections.menu 下发的快照，一条 = 一个可点项）。 */
export interface MenuMoreItem {
  /** 注册方身份；同时也是一级分组名（显示用） */
  owner: string;
  /** 项名（显示用，也是回传给注册方的标识） */
  label: string;
}

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
 *  同名不同 owner 的项允许共存，不做去重、编号或来源标注——文案由注册方负责。 */
export function buildMoreBranch(items: readonly MenuMoreItem[]): MenuBranch | null {
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
  return children.length > 0 ? { label: MORE_MENU_LABEL, children } : null;
}

/** 事件名 → 分类标签（无映射时用事件名本身）。 */
const EVENT_LABELS: Record<string, string> = {
  balance: '余额档位',
  whisper: '碎碎念',
  workStatus: '工作状态',
};

/** 把动画名包成叶子。 */
const leaf = (anim: string): MenuLeaf => ({ label: anim, anim });

/** 由成品 animations 配置推导菜单树：一级「动作」→ 二级分类 → 三级动画名；空池与空分类自动省略。 */
export function buildMenuTree(animations: Animations): MenuNode[] {
  const groups: MenuNode[] = [];
  const pools: Array<[string, string[]]> = [
    ['待机', animations.idle],
    ['转向', animations.turn],
    ['拖拽', animations.drag],
    ['点击回应', animations.clicks],
    ['移动', animations.moves.actions.map((m) => m.name)],
  ];
  for (const [label, pool] of pools) {
    if (pool.length) groups.push({ label, children: pool.map(leaf) });
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
    if (names.length) groups.push({ label: EVENT_LABELS[key] ?? key, children: names.map(leaf) });
  }
  if (!groups.length) return [];
  return [{ label: '动作', children: groups }];
}

/** 该动画是否属于 noMirror 分类（文字类）：朝右镜像时点播前强制朝左，避免文字镜像。 */
export function isNoMirrorAnimation(categories: Category[], anim: string): boolean {
  return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}

/** 菜单样式 —— 两端注入同一份。每级面板是独立的绝对定位盒子，位置由 JS 内联写入，互不嵌套。 */
export const MENU_CSS = [
  '.dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
  '.dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}',
  '.dsh-pet-menu-column{position:absolute;min-width:150px;max-width:300px;padding:4px;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;',
  // 自定义滚动条：Chromium 系走 ::-webkit-scrollbar，Firefox 走 scrollbar-width/scrollbar-color；
  // thumb 用 border + background-clip 内缩留白，与圆角白底协调。
  'scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}',
  '.dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}',
  '.dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;',
  'gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}',
  '.dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}',
  '.dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  // 右侧快捷键提示（菜单项 hint）：与 label 同一 flex 行，space-between 自动贴右
  '.dsh-pet-menu-hint{color:#9aa0a6;font-size:12px;flex:none;white-space:nowrap}',
  '.dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}',
].join('');

/** 右键菜单挂载句柄。 */
export interface ContextMenuMount {
  /** 已挂载的根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

function isBranchNode(n: MenuNode): n is MenuBranch {
  return 'children' in n && Array.isArray((n as MenuBranch).children);
}

/** 挂载一个系统风格右键菜单（级联子菜单）到 document.body，位置为视口坐标。
 *  结构：根容器零尺寸，每级面板平级挂载、按触发项屏幕位置贴边定位（右/下边缘自动翻转夹取）。
 *  级联：指针在菜单树内绝不自动收起，整体离开（root mouseleave，软 200ms）才关闭整棵菜单。
 *  clamp：允许占用的矩形（视口局部坐标）；桌面传「窗口 ∩ 工作区」——宠物贴边时窗口外扩的部分
 *  会被 OS 裁掉，约束进去即可完整显示，窗口与宠物零移动。 */
/** 面板/项的矩形（只需定位用到的那几个边）。 */
export interface PanelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** {@link pickPanelPosition} 的入参。 */
export interface PanelPositionInput {
  /** 待摆放面板的尺寸 */
  panel: { w: number; h: number };
  /** 触发它的菜单项 */
  item: { left: number; right: number; top: number };
  /** 它所属的那一层面板（子面板平级挂载，只有 DOM 父节点能给出正确的层） */
  parent: { left: number; right: number; top: number };
  /** 其它已展开面板的矩形：新面板不得与其中任何一个相交 */
  others: PanelBox[];
  /** 允许显示的范围（窗口 ∩ 工作区，视口坐标） */
  clamp: { x: number; y: number; w: number; h: number };
}

/** 面板与边界的间距，以及面板之间的间隙（px）。 */
const PANEL_GAP = 4;

/**
 * 决定一个子面板该摆在哪：**优先不与任何已展开面板重叠**。
 *
 * 候选按优先级排列（右侧展开优先、其次左侧；先对齐触发项、再对齐父面板顶），取第一个
 * 「完整落在 clamp 内 且 与 others 都不相交」的；都不满足时退而求其次取第一个不与 others 相交的；
 * 仍然没有（窗口太窄，任何位置都会压到）就贴父面板右侧并在 clamp 内夹取——宁可贴边，也不要叠在一起。
 *
 * 纯函数：不碰 DOM、不读全局，便于单测（多级菜单的重叠是几何问题，不是渲染问题）。
 * @param input 面板尺寸、触发项/父面板矩形、其它面板矩形与 clamp 范围
 * @returns 面板左上角在视口坐标里的落点
 */
export function pickPanelPosition(input: PanelPositionInput): { left: number; top: number } {
  const { panel, item, parent, others, clamp } = input;
  const minLeft = clamp.x + PANEL_GAP;
  const minTop = clamp.y + PANEL_GAP;
  const maxLeft = clamp.x + clamp.w - PANEL_GAP - panel.w;
  const maxTop = clamp.y + clamp.h - PANEL_GAP - panel.h;
  const clampTop = (top: number): number => Math.max(minTop, Math.min(top, maxTop));
  const hitsOther = (left: number, top: number): boolean =>
    others.some(
      (b) => left < b.right && left + panel.w > b.left && top < b.bottom && top + panel.h > b.top,
    );
  const fitsClamp = (left: number, top: number): boolean =>
    left >= minLeft - 0.5 && left <= maxLeft + 0.5 && top >= minTop - 0.5 && top <= maxTop + 0.5;
  const topAtItem = clampTop(item.top);
  const topAtParent = clampTop(parent.top);
  const cands = [
    { left: parent.right + PANEL_GAP, top: topAtItem },
    { left: parent.left - PANEL_GAP - panel.w, top: topAtItem },
    { left: parent.right + PANEL_GAP, top: topAtParent },
    { left: parent.left - PANEL_GAP - panel.w, top: topAtParent },
  ];
  // ① 理想落点：完整落在 clamp 内且不压任何面板
  const ideal = cands.find((cd) => fitsClamp(cd.left, cd.top) && !hitsOther(cd.left, cd.top));
  if (ideal) return ideal;
  // ② 次优：把候选夹进 clamp 后再看能不能避开其它面板（贴边但至少不重叠）
  const clampX = (v: number): number => Math.max(minLeft, Math.min(v, Math.max(minLeft, maxLeft)));
  const clampY = (v: number): number => Math.max(minTop, Math.min(v, Math.max(minTop, maxTop)));
  const fitted = cands
    .map((cd) => ({ left: clampX(cd.left), top: clampY(cd.top) }))
    .find((cd) => !hitsOther(cd.left, cd.top));
  if (fitted) return fitted;
  // ③ 兜底：窗口太窄，任何位置都会压到——贴父面板右侧并在 clamp 内夹取（宁可贴边，也不叠在一起）
  return { left: clampX(parent.right + PANEL_GAP), top: clampY(topAtItem) };
}

export function mountContextMenu(opts: {
  tree: MenuNode[];
  x: number;
  y: number;
  onAction: (leaf: MenuLeaf) => void;
  /** 菜单被关闭（点项/点外/Esc）后的通知：挂载方据此复位自身状态（如桌面可交互标记） */
  onClose?: () => void;
  /** 菜单允许占用的矩形（视口局部坐标）；缺省 = 整个视口 */
  clamp?: { x: number; y: number; w: number; h: number };
}): ContextMenuMount {
  const { tree, x, y, onAction, onClose, clamp } = opts;
  // 防御：clamp 含非有限值（如坐标来源缺失变成 NaN）时回落整个视口，否则面板会落到 (0,0)
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const root = document.createElement('div');
  root.className = 'dsh-pet-menu';
  root.style.left = '0px';
  root.style.top = '0px';
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  let closed = false;

  /** 每个面板当前展开的子面板（无 = 未展开）；hideChain 会沿链清除 */
  const openChild = new Map<HTMLElement, HTMLElement>();
  /** 指针整体离开菜单树的兜底关闭定时器（root mouseover 重新进入即取消） */
  let leaveTimer: number | null = null;

  /** 关闭某面板及其后代面板整条链（display:none + 清 openChild 链） */
  const hideChain = (panel: HTMLElement): void => {
    panel.style.display = 'none';
    const child = openChild.get(panel);
    if (child) {
      openChild.delete(panel);
      hideChain(child);
    }
  };

  /** 把面板显示在触发项旁边：右缘展开，贴右/下边缘自动翻转夹取（在 clamp 矩形内） */
  /**
   * 把子面板摆到触发项旁边：**不许压住任何一层已展开的面板**。
   *
   * 旧实现只判断"右侧放不下就翻到触发项左侧"——而触发项就长在父面板里，翻左等于直接压在父面板上；
   * 三级同理，翻左会压在二级或一级上（实测多级菜单叠成一坨）。几何决策抽到
   * {@link pickPanelPosition}，这里只负责读 DOM 与写样式。
   * @param panel 待摆放的子面板（已 display:block，尺寸可读）
   * @param item 触发它的菜单项
   */
  const showPanel = (panel: HTMLElement, item: HTMLElement): void => {
    const rect = item.getBoundingClientRect();
    panel.style.left = '';
    panel.style.top = '';
    panel.style.display = 'block';
    const parentEl = item.parentElement;
    const pr = parentEl ? parentEl.getBoundingClientRect() : rect;
    const pick = pickPanelPosition({
      panel: { w: panel.offsetWidth, h: panel.offsetHeight },
      item: { left: rect.left, right: rect.right, top: rect.top },
      parent: { left: pr.left, right: pr.right, top: pr.top },
      others: Array.from(root.querySelectorAll<HTMLElement>('.dsh-pet-menu-column'))
        .filter((p) => p !== panel && p.style.display !== 'none')
        .map((p) => {
          const b = p.getBoundingClientRect();
          return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        }),
      clamp: { x: c.x, y: c.y, w: c.w, h: c.h },
    });
    panel.style.left = pick.left + 'px';
    panel.style.top = pick.top + 'px';
  };

  /** 构建一层面板；分支项的子面板平级挂到 root 下、不嵌套。
   *  面板先入 DOM、子面板后入，层级越深绘制越靠上（子菜单盖在父菜单上层）。 */
  const buildPanel = (nodes: MenuNode[]): HTMLElement => {
    const panel = document.createElement('div');
    panel.className = 'dsh-pet-menu-column';
    panel.style.display = 'none';
    // 桌面 clamp：把列高封顶到可视矩形内（否则 62vh 相对的是窗口高度，可视区更小时仍会溢出被裁）
    if (clamp) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + 'px';
    root.appendChild(panel);
    for (const node of nodes) {
      const item = document.createElement('div');
      item.className = 'dsh-pet-menu-item';
      if (isBranchNode(node)) {
        item.classList.add('dsh-pet-menu-branch');
        const label = document.createElement('span');
        label.textContent = node.label;
        const arrow = document.createElement('span');
        arrow.className = 'dsh-pet-menu-arrow';
        arrow.textContent = '▸';
        item.appendChild(label);
        item.appendChild(arrow);
        const childPanel = buildPanel(node.children); // 递归：子面板已入树（晚于本面板）
        // 悬停分支：先收掉本面板其它分支已展开的子面板链，再展开当前的。
        // 指针在本菜单树内移动绝不自动收起——跨 4px 缝隙或面板间隙都不会触发关闭。
        item.addEventListener('mouseenter', () => {
          const prev = openChild.get(panel);
          if (prev && prev !== childPanel) hideChain(prev);
          openChild.set(panel, childPanel);
          showPanel(childPanel, item);
        });
      } else {
        const label = document.createElement('span');
        label.textContent = node.label;
        item.appendChild(label);
        // 右侧灰色提示（如快捷键）：与 label 同一 flex 行，space-between 自动贴右
        if (node.hint) {
          const hint = document.createElement('span');
          hint.className = 'dsh-pet-menu-hint';
          hint.textContent = node.hint;
          item.appendChild(hint);
        }
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          close();
          onAction(node);
        });
      }
      panel.appendChild(item);
    }
    return panel;
  };

  const rootPanel = buildPanel(tree);
  rootPanel.style.display = 'block';

  // 必须先 append 到文档：未入文档时量不到面板尺寸，一切「静默无显示」
  document.body.appendChild(root);

  // 根面板定位：按 (x,y) 下落，超出 clamp 矩形时夹回（与子面板同一套逻辑但无触发项）
  rootPanel.style.left = '';
  rootPanel.style.top = '';
  const rw = rootPanel.offsetWidth;
  const rh = rootPanel.offsetHeight;
  rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + 'px';
  rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + 'px';

  // 指针整体离开菜单树（离开全部面板的并集）→ 200ms 后关闭整棵菜单；
  // 期间任何指针移动（mouseover 冒泡到 root）都视为仍在菜单内，取消关闭
  root.addEventListener('mouseleave', () => {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      leaveTimer = null;
      close();
    }, 200);
  });
  root.addEventListener('mouseover', () => {
    if (leaveTimer !== null) {
      window.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  });

  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (onClose) onClose();
  };

  return { el: root, close };
}
