/**
 * 宠物盒的几何：由宽度推出半宽半高、脚垫与左右余量，并换算归一化中心 ↔ 包围盒左上角。
 * 位置指令用归一化比例、拖拽与抛掷用左上角像素，两个方向必须互逆，否则松手会跳位。
 * 纯计算：视口、盒尺寸与画布基准都由调用方传入，不读 `window`。
 * @module dsh-pet/src/client/pet/motion/geometry
 */
import { CANVAS_H, FEET_Y, HIT_BOX } from '../../../shared/constants.ts';
import type { CSSProperties } from 'react';

/** 视口尺寸。 */
export interface Viewport {
  width: number;
  height: number;
}

/** 宠物盒的半宽与半高（高度按 16:9 由宽度推出）。 */
export interface HalfSize {
  w: number;
  h: number;
}

/** 归一化中心（0..1，相对视口）。 */
export interface Center {
  rx: number;
  ry: number;
}

/** 包围盒左上角像素坐标。 */
export interface BoxPoint {
  x: number;
  y: number;
}

/** 宠物盒的派生度量（px），全部由宽度按固定画布基准推出。 */
export interface PetMetrics {
  /** 盒半宽。 */
  halfW: number;
  /** 盒半高，按 16:9 由宽度推出。 */
  halfH: number;
  /** 舞台脚底垫高：命中框与碰撞 body 框都按它上移。 */
  bottomPad: number;
  /** 左右透明边余量：漫游夹取按身体贴边，宠物能走到屏幕边缘而身体不越界。 */
  sideAllow: number;
}

/**
 * 按宠物宽度算出盒子度量。
 *
 * @param size - 宠物宽度 px。
 * @returns 四个派生量，随宽度线性缩放。
 */
export function derivePetMetrics(size: number): PetMetrics {
  return {
    halfW: size / 2,
    halfH: (size * 9) / 16 / 2,
    bottomPad: (size * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H,
    sideAllow: (HIT_BOX.x0 / 640) * size,
  };
}

/**
 * 归一化中心 → 包围盒左上角像素。
 *
 * @param center - 宠物中心相对视口的比例。
 * @param viewport - 视口尺寸。
 * @param half - 盒的半宽半高。
 * @returns 根节点 `left`/`top` 该写的像素值。
 */
export function centerToBox(center: Center, viewport: Viewport, half: HalfSize): BoxPoint {
  return { x: center.rx * viewport.width - half.w, y: center.ry * viewport.height - half.h };
}

/**
 * 包围盒左上角像素 → 归一化中心；{@link centerToBox} 的逆运算。
 *
 * @param box - 根节点当前的 `left`/`top`（px）。
 * @param viewport - 视口尺寸。
 * @param half - 盒的半宽半高。
 * @returns 可提交给 `customPos` 的归一化中心。
 */
export function boxToRatio(box: BoxPoint, viewport: Viewport, half: HalfSize): Center {
  return { rx: (box.x + half.w) / viewport.width, ry: (box.y + half.h) / viewport.height };
}

/**
 * 限制静止宠物的身体命中区在视口内；命中区大于视口的轴居中显示。
 *
 * @param box - 根节点左上角像素坐标。
 * @param viewport - 视口尺寸。
 * @param size - 宠物宽度 px。
 * @returns 允许透明留白越界、身体仍可点击的根节点位置。
 */
export function clampPetBox(box: BoxPoint, viewport: Viewport, size: number): BoxPoint {
  const scale = size / 640;
  const { bottomPad } = derivePetMetrics(size);
  const minX = -HIT_BOX.x0 * scale;
  const maxX = viewport.width - HIT_BOX.x1 * scale;
  const minY = -HIT_BOX.y0 * scale - bottomPad;
  const maxY = viewport.height - HIT_BOX.y1 * scale - bottomPad;
  return {
    x: minX > maxX ? (minX + maxX) / 2 : Math.max(minX, Math.min(maxX, box.x)),
    y: minY > maxY ? (minY + maxY) / 2 : Math.max(minY, Math.min(maxY, box.y)),
  };
}

/** 舞台内联样式：拖拽中取消脚垫位移，让视频贴着指针走。 */
export function petStageStyle(dragging: boolean, bottomPad: number): CSSProperties {
  return dragging ? { transform: 'none' } : { transform: 'translateY(' + bottomPad + 'px)' };
}

/**
 * 根节点的定位内联样式。
 *
 * 有 customPos 时按归一化中心换算成 px 定位；没有时返回空对象，交给角落与边距的 CSS 变量定位。
 * 拖拽落点与视口重排的边界由运动装配约束，这里只换算定位样式。
 *
 * @param customPos - 用户拖拽后的归一化中心；null 表示仍按角落定位。
 * @param viewport - 视口尺寸。
 * @param half - 盒的半宽半高。
 * @returns 可直接并入根节点 style 的定位字段；未定位时为空对象。
 */
export function petRootStyle(customPos: Center | null, viewport: Viewport, half: HalfSize): CSSProperties {
  if (!customPos) return {};
  return {
    left: customPos.rx * viewport.width - half.w + 'px',
    top: customPos.ry * viewport.height - half.h + 'px',
    // 角落定位按 data-corner 写 left/right 与 top/bottom；另一侧不归零，两套定位会同时生效、位置跳回角落。
    right: 'auto',
    bottom: 'auto',
  };
}

/** 命中区样式：把 640×360 画布上的命中框换算成相对宠物盒的百分比。 */
export const PET_HIT_STYLE: CSSProperties = {
  left: (HIT_BOX.x0 / 640) * 100 + '%',
  top: (HIT_BOX.y0 / 360) * 100 + '%',
  width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + '%',
  height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + '%',
};
