// 多显示器几何：纯计算（无 Electron / DOM）。
// 桌面 Helper 把 Electron screen 的 bounds + workArea 注入后，用这里的函数
// 决定「窗口落在哪一块屏」以及「抛掷该对哪块屏的边反弹 / 何时允许跨屏」。
//
// 背景：把全部工作区收成一个外接矩形当视口，矩形里会有不属于任何屏幕的空洞
// （副屏上移、竖屏并排等）。透明分层窗口一旦骑在屏缝上，Windows DWM 会在
// 两块屏上同时合成同一窗口——拖过缝、副屏抛甩时就会跳变 / 分身闪烁。
import type { ThrowBounds } from './physics';

/** 轴对齐矩形（屏幕 DIP） */
export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 一块物理屏：bounds 用于窗口落点（允许压到任务栏），
 * work* 用于抛掷/漫游（宠物待在工作区内）。
 */
export interface DisplayInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  workX: number;
  workY: number;
  workW: number;
  workH: number;
}

export const displayBounds = (d: DisplayInfo): DisplayRect => ({
  x: d.x,
  y: d.y,
  width: d.width,
  height: d.height,
});

export const displayWorkArea = (d: DisplayInfo): DisplayRect => ({
  x: d.workX,
  y: d.workY,
  width: d.workW,
  height: d.workH,
});

export const sameRect = (a: DisplayRect, b: DisplayRect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export const pointInRect = (x: number, y: number, r: DisplayRect): boolean =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

export const clampPointToRect = (x: number, y: number, r: DisplayRect): { x: number; y: number } => ({
  x: Math.min(Math.max(x, r.x), r.x + Math.max(r.width, 1) - 1),
  y: Math.min(Math.max(y, r.y), r.y + Math.max(r.height, 1) - 1),
});

/** 包含该点的矩形；不在任何矩形内则取距离最近的一块 */
export const nearestRect = (x: number, y: number, rects: DisplayRect[]): DisplayRect | null => {
  if (!rects.length) return null;
  for (const r of rects) {
    if (pointInRect(x, y, r)) return r;
  }
  let best = rects[0];
  let bestDist = Infinity;
  for (const r of rects) {
    const c = clampPointToRect(x, y, r);
    const dist = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return best;
};

export const nearestDisplay = (x: number, y: number, displays: DisplayInfo[]): DisplayInfo | null => {
  if (!displays.length) return null;
  const hit = displays.find((d) => pointInRect(x, y, displayBounds(d)));
  if (hit) return hit;
  const near = nearestRect(x, y, displays.map(displayBounds));
  return near ? displays.find((d) => sameRect(displayBounds(d), near)) || null : null;
};

/**
 * 把窗口矩形收进「中心点所在屏」的 bounds，避免透明窗骑缝。
 * 尺寸保持不变（窗口比该屏还大时只钉在该屏原点）。
 */
export const fitWindowToDisplay = (
  win: { x: number; y: number; width: number; height: number },
  displays: DisplayInfo[],
): { x: number; y: number; width: number; height: number } => {
  const cx = win.x + win.width / 2;
  const cy = win.y + win.height / 2;
  const d = nearestDisplay(cx, cy, displays);
  if (!d) return win;
  let { x, y } = win;
  const { width, height } = win;
  if (width <= d.width) {
    if (x < d.x) x = d.x;
    if (x + width > d.x + d.width) x = d.x + d.width - width;
  } else {
    x = d.x;
  }
  if (height <= d.height) {
    if (y < d.y) y = d.y;
    if (y + height > d.y + d.height) y = d.y + d.height - height;
  } else {
    y = d.y;
  }
  return { x, y, width, height };
};

export type CrossDir = 'left' | 'right' | 'up' | 'down';

/**
 * 沿当前工作区边缘外探 1px：那边若还有别的工作区，允许跨过去，否则当墙。
 * 副屏上移时，缝外上半段探不到主屏——必须弹回，不能飞进外接矩形的空洞。
 */
export const canCrossWorkArea = (
  current: DisplayRect,
  displays: DisplayRect[],
  screenCX: number,
  screenCY: number,
  dir: CrossDir,
): boolean => {
  let px = screenCX;
  let py = screenCY;
  if (dir === 'left') px = current.x - 1;
  else if (dir === 'right') px = current.x + current.width;
  else if (dir === 'up') py = current.y - 1;
  else py = current.y + current.height;
  return displays.some((d) => !sameRect(d, current) && pointInRect(px, py, d));
};

/** 当前工作区 → 视口坐标下的抛掷边界（不含跨屏开口） */
export const throwBoundsOnDisplay = (o: {
  display: DisplayRect;
  originX: number;
  originY: number;
  size: number;
  sideAllow: number;
}): ThrowBounds => {
  const h = (o.size * 9) / 16;
  const ox = o.display.x - o.originX;
  const oy = o.display.y - o.originY;
  return {
    minX: ox - o.sideAllow,
    minY: oy,
    maxX: ox + o.display.width - o.size + o.sideAllow,
    maxY: oy + o.display.height - h,
  };
};

/** 当前工作区抛掷边界：与邻屏重叠的边开口，其余边照常夹取反弹 */
export const throwBoundsOpen = (o: {
  current: DisplayRect;
  displays: DisplayRect[];
  originX: number;
  originY: number;
  size: number;
  sideAllow: number;
  screenCX: number;
  screenCY: number;
}): ThrowBounds => {
  const b = throwBoundsOnDisplay({
    display: o.current,
    originX: o.originX,
    originY: o.originY,
    size: o.size,
    sideAllow: o.sideAllow,
  });
  if (canCrossWorkArea(o.current, o.displays, o.screenCX, o.screenCY, 'left')) b.minX = Number.NEGATIVE_INFINITY;
  if (canCrossWorkArea(o.current, o.displays, o.screenCX, o.screenCY, 'right')) b.maxX = Number.POSITIVE_INFINITY;
  if (canCrossWorkArea(o.current, o.displays, o.screenCX, o.screenCY, 'up')) b.minY = Number.NEGATIVE_INFINITY;
  if (canCrossWorkArea(o.current, o.displays, o.screenCX, o.screenCY, 'down')) b.maxY = Number.POSITIVE_INFINITY;
  return b;
};

/**
 * 主进程注入的显示器列表（屏幕 DIP）。非法/空 → []，调用方回落单屏旧路径。
 */
export const parseDisplays = (raw: string | null | undefined): DisplayInfo[] => {
  let list: unknown = [];
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: DisplayInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const x = Number(rec.x);
    const y = Number(rec.y);
    const width = Number(rec.width);
    const height = Number(rec.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const workX = Number(rec.workX);
    const workY = Number(rec.workY);
    const workW = Number(rec.workW);
    const workH = Number(rec.workH);
    out.push({
      x,
      y,
      width,
      height,
      workX: Number.isFinite(workX) ? workX : x,
      workY: Number.isFinite(workY) ? workY : y,
      workW: Number.isFinite(workW) && workW > 0 ? workW : width,
      workH: Number.isFinite(workH) && workH > 0 ? workH : height,
    });
  }
  return out;
};

/** 视口相对坐标下、当前宠物中心所在工作区的抛掷边界；单屏/未知返回 null（调用方用外接矩形）。 */
export const throwBoundsForPet = (o: {
  displays: DisplayInfo[];
  originX: number;
  originY: number;
  size: number;
  sideAllow: number;
  petX: number;
  petY: number;
  halfW: number;
  halfH: number;
}): ThrowBounds | null => {
  if (o.displays.length <= 1) return null;
  const works = o.displays.map(displayWorkArea);
  const screenCX = o.petX + o.halfW + o.originX;
  const screenCY = o.petY + o.halfH + o.originY;
  const current = nearestRect(screenCX, screenCY, works);
  if (!current) return null;
  return throwBoundsOpen({
    current,
    displays: works,
    originX: o.originX,
    originY: o.originY,
    size: o.size,
    sideAllow: o.sideAllow,
    screenCX,
    screenCY,
  });
};

