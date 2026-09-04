// 统一右键菜单组件 —— 桌面（renderer.js 经 shared-core）与浏览器（pet.ts 经 bundle）
// 共用**同一份**菜单树与**同一份**渲染实现（"全部同一个组件"，两端行为/外观严格一致）。
//
// 本文件是 src/shared 唯一的 DOM 渲染例外（共享约定：只含无 DOM 依赖的纯逻辑）：
//   - buildMenuTree / isNoMirrorAnimation：纯函数，可单测，无 DOM；
//   - MENU_CSS / mountContextMenu：DOM 层，两端共用（菜单必须长成同一个样）。
// 菜单数据单一事实来源 = 合并后的 animations 配置（用户覆盖层自动生效）。
//
// 菜单层级（与产品定义一致）：
//   一级 = 工具项 + 动作：打开网站 / 查看余额（桌面端专属）与 回到初始位置（两端共用），由各壳注入；
//   二级（动作的子级）= 分类：待机 / 转向 / 拖拽 / 点击回应 / 移动 / config 随机动作分类 / 事件档位
//   三级 = 具体动画名
//
// DOM 结构（真正的菜单布局逻辑）：**每一级是独立的面板 div，全部平级挂到根容器下**，
// 各面板按触发项的屏幕位置贴边定位（右侧展开、贴右/下边缘自动翻转）、各自独立滚动；
// 绝不把子面板嵌套进父面板/父项内部（同一容器包裹会让子菜单被父容器的滚动区裁切）。
//
// 级联保持模型（标准菜单行为，杜绝对齐缝隙/面板间移动导致的消失）：
//   - 只要指针还在这棵菜单树内（任意可见面板/项上），就**绝不自动收起**子面板；
//     悬停另一个分类时才切换其子面板（hideChain 旧链 + 展开新链）；
//   - 指针整体离开菜单树（root mouseleave，软 200ms）才关闭整个菜单；
//   - 点击项 / 点击菜单外 / Esc 关闭。
//   不再使用"逐项 mouseleave 延迟关闭定时器"——旧实现里鼠标从分类项移向三级面板时，
//   会同时给父项（动作）排下无人取消的关闭定时器，导致二级+三级一起消失。
import type { Animations, Category } from './types';

/** 叶子：可点击的菜单项 */
export interface MenuLeaf {
  label: string;
  /** 播放的动画名（点播动作）；action 优先于 anim */
  anim?: string;
  /** 自定义动作：open-site=打开网站 / show-balance=查看余额；whisper=立即碎碎念一句；
   * chat=打开对话弹窗；home=回到初始位置。手动触发均不受 whisperEnabled 影响（该字段只关自动周期轮询） */
  action?: 'open-site' | 'show-balance' | 'whisper' | 'chat' | 'home';
}

/** 分支：带子菜单的项 */
export interface MenuBranch {
  label: string;
  children: MenuNode[];
}

export type MenuNode = MenuLeaf | MenuBranch;

/** 事件名 → 分类标签（无映射时用事件名本身） */
const EVENT_LABELS: Record<string, string> = {
  balance: '余额档位',
  whisper: '碎碎念',
  workStatus: '工作状态',
};

const leaf = (anim: string): MenuLeaf => ({ label: anim, anim });

/**
 * 由合并后的 animations 配置推导菜单树 —— 输出 [{ 动作 → [ 分类 → [ 具体动画 ] ] }]：
 * 一级只有一个「动作」分支；二级 = 分类（待机/转向/拖拽/点击回应/移动 + config 随机动作
 * 分类 + 事件档位）；三级 = 具体动画名。空池/空分类自动省略。
 */
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
  // config 随机动作分类（noMirror 分类照样可点播，播放端朝右时强制朝左见 isNoMirrorAnimation）
  const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
  for (const c of cats) {
    groups.push({ label: c.id, children: c.actions.map(leaf) });
  }
  // 事件动画：每个事件为一个分类（不来自随机链，点播与代码触发同一池）
  const events = animations.events ?? {};
  for (const key of Object.keys(events)) {
    const pool = events[key] ?? [];
    if (pool.length) groups.push({ label: EVENT_LABELS[key] ?? key, children: pool.map(leaf) });
  }
  if (!groups.length) return [];
  return [{ label: '动作', children: groups }];
}

/** 该动画是否属于 noMirror 分类（文字类）：朝右（镜像）时点播前强制朝左，避免文字镜像 */
export function isNoMirrorAnimation(categories: Category[], anim: string): boolean {
  return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}

/** 菜单样式 —— 两端注入同一份（浏览器并入 plugin css；桌面入窗口 head）。
 *  每一级面板是独立的绝对定位盒子（.dsh-pet-menu-column），位置由 JS 内联写入；
 *  面板与面板之间互不嵌套，各自独立滚动。 */
export const MENU_CSS = [
  '.dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
  '.dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}',
  '.dsh-pet-menu-column{position:absolute;min-width:150px;max-width:240px;padding:4px;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto}',
  '.dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;',
  'gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}',
  '.dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}',
  '.dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}',
].join('');

/** mountContextMenu 返回值 */
export interface ContextMenuMount {
  /** 已挂载的根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

function isBranchNode(n: MenuNode): n is MenuBranch {
  return 'children' in n && Array.isArray((n as MenuBranch).children);
}

/**
 * 挂载一个系统风格右键菜单（级联子菜单）到 document.body。
 * 位置为视口坐标（桌面=窗口视口，浏览器=页面视口）——两端一致。
 *
 * 结构：根容器（fixed，零尺寸）下平级挂**每一级独立面板**，绝无嵌套；
 * 面板按触发项屏幕位置贴边定位（右/下边缘自动翻转夹取）。
 * 级联：悬停分支切换/展开子面板；指针整体离开菜单树（root mouseleave）才关闭整棵菜单；
 * 点击项回调后自动关闭、点击菜单外或按 Esc 关闭；超高列表面板内独立滚动。
 */
export function mountContextMenu(opts: {
  tree: MenuNode[];
  x: number;
  y: number;
  onAction: (leaf: MenuLeaf) => void;
  /** 菜单被关闭（点项/点外/Esc）后的通知：挂载方据此复位自身状态（如桌面可交互标记） */
  onClose?: () => void;
}): ContextMenuMount {
  const { tree, x, y, onAction, onClose } = opts;
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

  /** 把面板显示在触发项旁边：右缘展开，贴右/下边缘自动翻转夹取（视口坐标） */
  const showPanel = (panel: HTMLElement, item: HTMLElement): void => {
    const rect = item.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    panel.style.left = '';
    panel.style.top = '';
    panel.style.display = 'block';
    let left = rect.right + 4;
    if (left + panel.offsetWidth > vw - 4) left = rect.left - panel.offsetWidth - 4;
    left = Math.max(4, left);
    let top = rect.top;
    if (top + panel.offsetHeight > vh - 4) top = Math.max(4, vh - 4 - panel.offsetHeight);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  };

  /** 构建一层面板（nodes 列表）；分支项的子面板**平级**挂到 root 下，不嵌套。
   *  面板自身先入 DOM、子面板随后入 → 层级越深绘制越靠上（子菜单盖在父菜单上层）。 */
  const buildPanel = (nodes: MenuNode[]): HTMLElement => {
    const panel = document.createElement('div');
    panel.className = 'dsh-pet-menu-column';
    panel.style.display = 'none';
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
        // 悬停分支：收掉本面板其它分支已展开的子面板链，再展开当前分支的儿子面板。
        // （指针在本菜单树内移动绝不自动收起——跨 4px 缝隙/面板间隙都不会触发关闭）
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

  // 关键：把菜单根容器真正挂进文档（v1→v2 重写时漏掉的挂载——不 append 则一切"静默无显示"）
  document.body.appendChild(root);

  // 根面板定位：按 (x,y) 下落，超出视口时夹回（与子面板同一套逻辑但无触发项）
  rootPanel.style.left = '';
  rootPanel.style.top = '';
  const rw = rootPanel.offsetWidth;
  const rh = rootPanel.offsetHeight;
  rootPanel.style.left = Math.max(4, Math.min(x, window.innerWidth - rw - 4)) + 'px';
  rootPanel.style.top = Math.max(4, Math.min(y, window.innerHeight - rh - 4)) + 'px';

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
