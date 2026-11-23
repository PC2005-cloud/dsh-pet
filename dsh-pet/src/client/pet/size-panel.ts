/**
 * 宠物大小滑块浮层：右键菜单「调整大小」弹出的轻量面板，拖动即时改渲染宽度，松手写配置。
 *
 * 不依赖 React：菜单、提示与这只面板都是同一个宿主页面里的 DOM 浮层，用同一套白底样式；
 * 面板只负责取值范围、预览与提交请求，写盘由宿主 `POST /pet-size` 完成（设置页不动）。
 * @module dsh-pet/src/client/pet/size-panel
 */
import { ROUTE_PATH } from '../../shared/constants.ts';
import { resolveSizeBounds } from '../../shared/pet-size.ts';

/** 成品的配置聚合：与 `GET /config` 的响应同形，直接交给 `petBridge.reload`。 */
export type MergedPetConfig = Record<string, Record<string, unknown>>;

/** 存取结果的判别联合：失败不抛给调用方，面板只管选一句文案。 */
export type SizeSaveOutcome =
  | { readonly kind: 'ok'; readonly merged: MergedPetConfig }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'error' };

/** 挂载参数。 */
export interface SizePanelOptions {
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
  /** 拖动过程中：只改渲染，不写盘。 */
  onPreview: (sizePx: number) => void;
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

/** 面板定位点：视口坐标，已夹进可视区。 */
export interface SizePanelPoint {
  left: number;
  top: number;
}

/** 面板离视口边缘的安全距离（px）。 */
const VIEWPORT_MARGIN = 8;

/**
 * 把面板摆到落点附近，放不下时翻到另一侧并夹回视口。
 *
 * @param x - 右键落点横坐标。
 * @param y - 右键落点纵坐标。
 * @param w - 面板宽度。
 * @param h - 面板高度。
 * @param vw - 视口宽。
 * @param vh - 视口高。
 * @returns `{ left, top }`，单位 px。
 */
export function placeSizePanel(x: number, y: number, w: number, h: number, vw: number, vh: number): SizePanelPoint {
  const left = Math.max(VIEWPORT_MARGIN, Math.min(x, vw - w - VIEWPORT_MARGIN));
  // 先按落点摆；下方塞不下就翻到上面，仍塞不下再夹回视口内。
  const preferredTop = y + h + VIEWPORT_MARGIN > vh ? y - h : y;
  const top = Math.max(VIEWPORT_MARGIN, Math.min(preferredTop, vh - h - VIEWPORT_MARGIN));
  return { left, top };
}

/**
 * 把一只宠物的大小写回配置。
 *
 * @param petId - 宠物 id（层归属由宿主反查，调用方不用知道它在哪个种类文件里）。
 * @param sizePx - 新的画框宽度（px），必须大于 0。
 * @returns 写后的成品聚合，或失败分类；`invalid` 带出宿主给的就地文案。
 */
export async function savePetSize(petId: string, sizePx: number): Promise<SizeSaveOutcome> {
  try {
    const response = await fetch(ROUTE_PATH + '/pet-size', {
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
  let current = bounds.value;
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
  value.textContent = formatSize(current);
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
  hint.textContent = '拖动即时预览';
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
    if (event.target instanceof Node && panel.contains(event.target)) return;
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
    current = Number(range.value);
    value.textContent = formatSize(current);
    options.onPreview(current);
  });
  range.addEventListener('change', () => {
    if (Number(range.value) === bounds.value) return;
    current = Number(range.value);
    options.onCommit(current);
  });
  closeButton.addEventListener('click', () => close());
  // 面板自己吃掉右键与滚轮切换，别让宿主的菜单/页面跟着动。
  panel.addEventListener('contextmenu', (event) => event.preventDefault());

  document.body.appendChild(panel);
  const point = placeSizePanel(
    options.x,
    options.y,
    panel.offsetWidth,
    panel.offsetHeight,
    window.innerWidth,
    window.innerHeight,
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

/** 大小的滑块浮层样式：与右键菜单同一套白底浅描边，只在本页面注入一次。 */
export const SIZE_PANEL_CSS = [
  '.dsh-pet-size-panel{position:fixed;z-index:2147483001;box-sizing:border-box;width:220px;padding:10px 12px 12px;background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.2);color:#2b2b2b;font-size:13px;font-family:"Microsoft YaHei","Segoe UI","PingFang SC",sans-serif;user-select:none}',
  '.dsh-pet-size-panel *{box-sizing:border-box}',
  '.dsh-pet-size-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
  '.dsh-pet-size-title{flex:1 1 auto;font-weight:600}',
  '.dsh-pet-size-value{color:#2b63ff;font-variant-numeric:tabular-nums}',
  '.dsh-pet-size-close{border:none;background:transparent;color:#9aa0a6;font-size:16px;line-height:1;padding:0 2px;cursor:pointer}',
  '.dsh-pet-size-close:hover{color:#2b2b2b}',
  '.dsh-pet-size-range{width:100%;margin:0;accent-color:#2b63ff;cursor:pointer}',
  '.dsh-pet-size-foot{display:flex;justify-content:space-between;gap:8px;margin-top:6px;color:#9aa0a6;font-size:12px}',
  '.dsh-pet-size-limit{font-variant-numeric:tabular-nums}',
].join('\n');
