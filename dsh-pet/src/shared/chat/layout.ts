/** 对话弹窗的纯布局计算（桌面和网页共用，不依赖 DOM）。 */
export interface ChatAnchor {
  x: number;
  y: number;
}

export interface ChatClampRect extends ChatAnchor {
  w: number;
  h: number;
}

/** 取工作区与视口的交集，留少量内边距；异常或无交集时退回视口。 */
export function chatDialogBounds(
  clamp: ChatClampRect | null | undefined,
  width: number,
  height: number,
): ChatClampRect {
  let bounds = { x: 0, y: 0, w: width, h: height };
  if (clamp && [clamp.x, clamp.y, clamp.w, clamp.h].every(Number.isFinite)) {
    const x = Math.max(0, clamp.x);
    const y = Math.max(0, clamp.y);
    const w = Math.min(width, clamp.x + clamp.w) - x;
    const h = Math.min(height, clamp.y + clamp.h) - y;
    if (w > 0 && h > 0) bounds = { x, y, w, h };
  }
  const pad = Math.min(4, bounds.w / 4, bounds.h / 4);
  return { x: bounds.x + pad, y: bounds.y + pad, w: bounds.w - 2 * pad, h: bounds.h - 2 * pad };
}

/** 在限制尺寸后，尽量贴近所请求的落点。 */
export function chatDialogPosition(
  bounds: ChatClampRect,
  anchor: ChatAnchor,
  width: number,
  height: number,
): ChatAnchor {
  return {
    x: Math.max(bounds.x, Math.min(anchor.x, bounds.x + bounds.w - width)),
    y: Math.max(bounds.y, Math.min(anchor.y, bounds.y + bounds.h - height)),
  };
}
