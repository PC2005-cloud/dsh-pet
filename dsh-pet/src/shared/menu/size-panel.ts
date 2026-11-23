/**
 * 宠物大小滑块浮层：「调整大小」菜单项弹出的轻量面板，拖动改画框宽度，松手写配置。
 *
 * 两端共用同一份 DOM 与判据：浏览器浮层用相对路由访问宿主，桌面渲染进程是 file:// 页面，
 * 必须传绝对 BASE；桌面端改了大小要由宿主重建窗口，所以那边关掉拖动即时预览。
 * 面板只负责取值范围、预览与发请求，写盘仍由宿主 `POST /pet-size` 完成（设置页不动）。
 * @module dsh-pet/src/shared/menu/size-panel
 */
import { resolveSizeBounds } from '../pet-size.ts';

/** 成品的配置聚合：与 `GET /config` 的响应同形，直接交给宿主侧的重载。 */
export type MergedPetConfig = Record<string, Record<string, unknown>>;

/** 存取结果的判别联合：失败不抛给调用方，面板只管选一句文案。 */
export type SizeSaveOutcome =
  | { readonly kind: 'ok'; readonly merged: MergedPetConfig }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'error' };

/** 可用区域：桌面端传窗口 ∩ 工作区，浏览器端不传即整块视口。 */
export interface SizePanelRect {
  /** 左边界（视口坐标）。 */
  x: number;
  /** 上边界（视口坐标）。 */
  y: number;
  /** 宽度。 */
  w: number;
  /** 高度。 */
  h: number;
}

/** 挂载参数。 */
export interface SizePanelOptions {
  /** 宿主路由基址：浏览器传 `ROUTE_PATH`，桌面传绝对 `BASE`。 */
  baseUrl: string;
  /** 当前实际渲染的画框宽度（px）：滑块从这个值出发。 */
  sizePx: number;
  /** 人物占屏宽的百分比：只用来算滑块上限，不写回。 */
  sizePercent: number | undefined;
  /** 调用时刻的视口宽（CSS 像素）。 */
  viewportWidthPx: number;
  /** 右键落点（clientX/clientY）：面板贴着它弹出。 */
  x: number;
  /** 右键落点（clientY）。 */
  y: number;
  /** 是否在拖动时即时改渲染。桌面端传 false：窗口尺寸由宿主重建，松手才有意义。 */
  livePreview?: boolean;
  /** 可用区域；省略时按整块视口算。 */
  clamp?: SizePanelRect | null;
  /** 拖动过程中：只改渲染，不写盘。`livePreview` 为 false 时不调。 */
  onPreview?: (sizePx: number) => void;
  /** 松手（或键盘放开）时：值变了才调，负责写盘。 */
  onCommit: (sizePx: number) => void;
  /** 面板已关闭（点外、Esc、×）：持有句柄的一方据此置空。 */
  onClose?: () => void;
}

/** 面板挂载句柄。 */
export interface SizePanelMount {
  /** 已挂载的根元素。 */
  el: HTMLElement;
  /** 关闭并清理（幂等）。 */
  close: () => void;
}

/** 面板定位点：视口坐标，已夹进可用区域。 */
export interface SizePanelPoint {
  left: number;
  top: number;
}

/** 面板离可用区域边缘的安全距离（px）。 */
const VIEWPORT_MARGIN = 8;

/**
 * 把面板摆到落点附近，放不下时翻到另一侧并夹回可用区域。
 *
 * @param x - 右键落点横坐标。
 * @param y - 右键落点纵坐标。
 * @param w - 面板宽度。
 * @param h - 面板高度。
 * @param vw - 视口宽（没有 `rect` 时用它当区域）。
 * @param vh - 视口高（没有 `rect` 时用它当区域）。
 * @param rect - 可用区域；桌面端传窗口与工作区的交集。
 * @returns `{ left, top }`，单位 px。
 */
export function placeSizePanel(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  rect?: SizePanelRect | null,
): SizePanelPoint {
  const area = rect ?? { x: 0, y: 0, w: vw, h: vh };
  const minLeft = area.x + VIEWPORT_MARGIN;
  const minTop = area.y + VIEWPORT_MARGIN;
  // 区域比面板还窄/矮时下限会超过上限：先夹出下限，避免面板被推出边界。
  const left = Math.max(minLeft, Math.min(x, Math.max(minLeft, area.x + area.w - w - VIEWPORT_MARGIN)));
  // 先按落点摆；下方塞不下就翻到上面，仍塞不下再夹回可用区域。
  const preferredTop = y + h + VIEWPORT_MARGIN > area.y + area.h ? y - h : y;
  const top = Math.max(minTop, Math.min(preferredTop, Math.max(minTop, area.y + area.h - h - VIEWPORT_MARGIN)));
  return { left, top };
}

/**
 * 把一只宠物的大小写回配置。
 *
 * @param baseUrl - 宿主路由基址（相对 `ROUTE_PATH` 或绝对 `BASE`，末尾斜杠可有可无）。
 * @param petId - 宠物 id（层归属由宿主反查，调用方不用知道它在哪个种类文件里）。
 * @param sizePx - 新的画框宽度（px），必须大于 0。
 * @returns 写后的成品聚合，或失败分类；`invalid` 带出宿主给的就地文案。
 */
export async function savePetSize(baseUrl: string, petId: string, sizePx: number): Promise<SizeSaveOutcome> {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  try {
    const response = await fetch(root + '/pet-size', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: petId, size: sizePx }),
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
      reason?: unknown;
      message?: unknown;
    } | null;
    if (payload && payload.ok === false) {
      // 业务失败是 200 + {ok:false}：只有参数类失败值得把宿主文案原样带出来。
      if (payload.reason === 'bad-request' || payload.reason === 'pet-required') {
        return { kind: 'invalid', message: typeof payload.message === 'string' ? payload.message : '' };
      }
      return { kind: 'error' };
    }
    if (!response.ok) return { kind: 'error' };
    return { kind: 'ok', merged: payload as MergedPetConfig };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * 挂一只大小滑块到 body 上。
 *
 * @param options - 当前尺寸、落点与回调。
 * @returns 句柄：`el` 是根节点，`close` 关闭（幂等）。
 */
export function mountSizePanel(options: SizePanelOptions): SizePanelMount {
  const bounds = resolveSizeBounds(options.sizePx, options.sizePercent, options.viewportWidthPx);
  const livePreview = options.livePreview !== false;
  let closed = false;

  const panel = document.createElement('div');
  panel.className = 'dsh-pet-size-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '调整宠物大小');
  // 先藏起来，量完尺寸摆好位再显示——否则会在视口左上角闪一帧。
  panel.style.visibility = 'hidden';

  const head = document.createElement('div');
  head.className = 'dsh-pet-size-head';
  const title = document.createElement('span');
  title.className = 'dsh-pet-size-title';
  title.textContent = '调整大小';
  const value = document.createElement('span');
  value.className = 'dsh-pet-size-value';
  value.textContent = formatSize(bounds.value);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'dsh-pet-size-close';
  closeButton.setAttribute('aria-label', '关闭');
  closeButton.textContent = '×';
  head.append(title, value, closeButton);

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'dsh-pet-size-range';
  range.setAttribute('aria-label', '宠物大小');
  range.min = String(bounds.min);
  range.max = String(bounds.max);
  range.step = '1';
  range.value = String(bounds.value);

  const foot = document.createElement('div');
  foot.className = 'dsh-pet-size-foot';
  const hint = document.createElement('span');
  hint.className = 'dsh-pet-size-hint';
  // 桌面端没有拖动预览：窗口尺寸归 Electron 宿主管，只能落盘后重建。
  hint.textContent = livePreview ? '拖动即时预览' : '松手后按新尺寸重建窗口';
  const limit = document.createElement('span');
  limit.className = 'dsh-pet-size-limit';
  limit.textContent = '最大 ' + formatSize(bounds.max);
  foot.append(hint, limit);

  panel.append(head, range, foot);

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKeyDown, true);
    panel.remove();
    options.onClose?.();
  };

  function onOutside(event: MouseEvent): void {
    // 不用 instanceof Node：运行时门禁（eslint.runtime.config.js）只声明契约里真实存在的浏览器全局，Node 不在其中。
    if (event.target !== null && panel.contains(event.target as Node)) return;
    close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  // 拖动只改渲染：input 连续触发，松手（change）才落盘——避免拖一次写几十遍配置文件。
  range.addEventListener('input', () => {
    const next = Number(range.value);
    value.textContent = formatSize(next);
    if (livePreview) options.onPreview?.(next);
  });
  range.addEventListener('change', () => {
    const next = Number(range.value);
    if (next === bounds.value) return;
    options.onCommit(next);
  });
  closeButton.addEventListener('click', () => close());
  // 面板自己吃掉右键，别让宿主的菜单跟着弹。
  panel.addEventListener('contextmenu', (event) => event.preventDefault());

  document.body.appendChild(panel);
  const point = placeSizePanel(
    options.x,
    options.y,
    panel.offsetWidth,
    panel.offsetHeight,
    window.innerWidth,
    window.innerHeight,
    options.clamp ?? null,
  );
  panel.style.left = point.left + 'px';
  panel.style.top = point.top + 'px';
  panel.style.visibility = 'visible';

  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKeyDown, true);

  return {
    el: panel,
    close,
  };
}

/** 数字后面统一补单位，避免滑块与页脚两处各写一份格式。 */
function formatSize(sizePx: number): string {
  return Math.round(sizePx) + ' px';
}

/** 大小的滑块浮层样式：与右键菜单同一套白底浅描边，两端注入同一份。 */
export const SIZE_PANEL_CSS = [
  // 桌面小窗的宽高跟着宠物走：把浮层宽度夹在视口内，宠物缩得很小时也不会被窗口裁掉。
  '.dsh-pet-size-panel{position:fixed;z-index:2147483001;box-sizing:border-box;width:220px;max-width:calc(100vw - 16px);padding:10px 12px 12px;background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.2);color:#2b2b2b;font-size:13px;font-family:"Microsoft YaHei","Segoe UI","PingFang SC",sans-serif;user-select:none}',
  '.dsh-pet-size-panel *{box-sizing:border-box}',
  '.dsh-pet-size-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
  '.dsh-pet-size-title{flex:1 1 auto;font-weight:600}',
  '.dsh-pet-size-value{color:#2b63ff;font-variant-numeric:tabular-nums}',
  '.dsh-pet-size-close{border:none;background:transparent;color:#9aa0a6;font-size:16px;line-height:1;padding:0 2px;cursor:pointer}',
  '.dsh-pet-size-close:hover{color:#2b2b2b}',
  '.dsh-pet-size-range{width:100%;margin:0;accent-color:#2b63ff;cursor:pointer}',
  '.dsh-pet-size-foot{display:flex;justify-content:space-between;gap:8px;margin-top:6px;color:#9aa0a6;font-size:12px}',
  '.dsh-pet-size-limit{font-variant-numeric:tabular-nums}',
];
