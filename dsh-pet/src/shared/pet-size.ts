/**
 * 宠物实际渲染宽度的解析：把「像素上限 + 人物占屏百分比」合成画框宽度（px）。
 *
 * 百分比说的是**人物本体**占屏宽多少，而 stage 是 16:9 画框、两侧各留 0.3125 的透明边，
 * 所以换算要除以人物占画框的比例（{@link BODY_WIDTH_RATIO}）。纯函数，不读 DOM。
 * @module dsh-pet/src/shared/pet-size
 */
import { HIT_BOX } from './constants.ts';

/** 人物本体宽度占画框宽度的比例；由命中框反推（240/640），不在别处再写一份 0.375。 */
const BODY_WIDTH_RATIO = (HIT_BOX.x1 - HIT_BOX.x0) / 640;

/** 百分比下限（%）：小于它等于没写。不设上限——填 150 就是「人物比屏还宽」，由 `size` 决定画框最终多大。 */
export const SIZE_PERCENT_MIN = 1;

/** 默认值：人物占屏宽的 20%——小屏不糊脸，宽屏下实际仍被 `size` 这个画框上限夹住。 */
export const SIZE_PERCENT_DEFAULT = 20;

/**
 * 百分比是否可用：必须是有限数字，且不小于下限。
 *
 * @param value - 配置里的原始值，可能未定义。
 * @returns 可用时 true 并把类型收窄为 number；`undefined`、字符串、`NaN`、`< 1` 均为 false。
 */
export function isValidSizePercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= SIZE_PERCENT_MIN;
}

/**
 * 取本次挂载使用的宽度。
 *
 * @param sizePx - 配置里的画框宽度，同时是百分比的上限（百分比算出的画框超过它就取它）。
 * @param sizePercent - 人物占屏宽的百分比；缺省按 {@link SIZE_PERCENT_DEFAULT} 处理。
 * @param viewportWidthPx - 调用时刻的视口宽（CSS 像素）；非正数表示拿不到，直接回落到 `sizePx`。
 * @returns 实际渲染的画框宽度，单位 px。
 */
export function resolvePetSizePx(sizePx: number, sizePercent: number | undefined, viewportWidthPx: number): number {
  const percent = sizePercent ?? SIZE_PERCENT_DEFAULT;
  if (!isValidSizePercent(percent)) return sizePx;
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) return sizePx;
  const bodyWidthPx = (viewportWidthPx * percent) / 100;
  return Math.min(sizePx, bodyWidthPx / BODY_WIDTH_RATIO);
}
