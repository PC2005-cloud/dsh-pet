/**
 * 待办面板的定位：贴着宠物命中区摆，放不下就翻到下方，并夹在视口内。
 *
 * 纯计算，不读 DOM：调用方传入命中区矩形、面板尺寸与视口尺寸，测试可直接断言落点。
 * @module dsh-pet/src/shared/todo/position
 */

/** 命中区矩形的四个边（视口坐标 px）。 */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 面板尺寸（px）。 */
export interface PanelSize {
  width: number;
  height: number;
}

/** 视口尺寸（px）。 */
export interface ViewportSize {
  width: number;
  height: number;
}

/** 面板落点（左上角，视口坐标 px）。 */
export interface Placement {
  left: number;
  top: number;
}

/** 面板与命中区的间距（px）。 */
export const PANEL_GAP_PX = 12;

/** 面板与视口边缘的最小留白（px）。 */
export const VIEWPORT_MARGIN_PX = 8;

/** 把值夹进 [min, max]；max 小于 min 时取 min（面板比视口还大时至少露出左上角）。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 计算面板落点。
 *
 * 水平方向以命中区中心对齐；垂直方向优先放在命中区上方，上方放不下时放到下方，
 * 仍然放不下就贴着视口上缘（面板自身的 max-height 负责滚动）。
 *
 * @param anchor - 宠物命中区矩形。
 * @param panel - 面板实际尺寸（已挂载后测得）。
 * @param viewport - 视口尺寸。
 * @returns 面板左上角坐标。
 */
export function placeTodoPanel(anchor: AnchorRect, panel: PanelSize, viewport: ViewportSize): Placement {
  const maxLeft = viewport.width - panel.width - VIEWPORT_MARGIN_PX;
  const center = (anchor.left + anchor.right) / 2;
  const left = clamp(center - panel.width / 2, VIEWPORT_MARGIN_PX, maxLeft);

  const above = anchor.top - panel.height - PANEL_GAP_PX;
  if (above >= VIEWPORT_MARGIN_PX) return { left, top: above };
  const below = anchor.bottom + PANEL_GAP_PX;
  const maxTop = viewport.height - panel.height - VIEWPORT_MARGIN_PX;
  return { left, top: clamp(below, VIEWPORT_MARGIN_PX, maxTop) };
}
