/**
 * WMO 天气码 → 图标几何：24×24 描边图形，供环境气泡按码取图。
 *
 * 只描述形状，不产出节点——网页端映射成 React 元素、桌面端映射成 SVG DOM，形状本身可离线单测。
 * 27 个码各自独立（同组用线条数量/长度表示强度）；表外的码回落成「阴」的那朵云。
 * @module dsh-pet/src/shared/env-icon
 */

/** 一个描边图元；线与圆用数值，路径用 SVG 的 d。 */
export type EnvIconShape =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number };

/** 描边线。 */
const line = (x1: number, y1: number, x2: number, y2: number): EnvIconShape => ({ kind: 'line', x1, y1, x2, y2 });

/** 圆点（雨滴以外的雪点、冰点、太阳本体都用它）。 */
const dot = (cx: number, cy: number, r: number): EnvIconShape => ({ kind: 'circle', cx, cy, r });

/** 标准云。 */
const CLOUD: EnvIconShape = {
  kind: 'path',
  d: 'M8.4 18h9.1a3.5 3.5 0 0 0 .3-6.98A4.7 4.7 0 0 0 9 10.4 3.1 3.1 0 0 0 8.4 18z',
};

/** 小云（与太阳并排时用，避免两个主体互相压住）。 */
const CLOUD_SM: EnvIconShape = {
  kind: 'path',
  d: 'M10.6 18.2h7.5a3 3 0 0 0 .3-6A4 4 0 0 0 11.1 11.6a2.8 2.8 0 0 0-.5 6.6z',
};

/** 大云（「多云」比「晴间多云」更满）。 */
const CLOUD_LG: EnvIconShape = {
  kind: 'path',
  d: 'M7.6 18.4h10.2a3.8 3.8 0 0 0 .4-7.6A5 5 0 0 0 8.6 10.2 3.4 3.4 0 0 0 7.6 18.4z',
};

/** 完整太阳：本体 + 八道光线。 */
const SUN: readonly EnvIconShape[] = [
  dot(12, 12, 4),
  line(12, 3.4, 12, 5.4),
  line(12, 18.6, 12, 20.6),
  line(3.4, 12, 5.4, 12),
  line(18.6, 12, 20.6, 12),
  line(5.9, 5.9, 7.3, 7.3),
  line(18.2, 5.9, 16.7, 7.3),
  line(5.9, 18.2, 7.3, 16.7),
  line(18.2, 18.2, 16.7, 16.7),
];

/** 角上一轮小太阳（与云组合时只留四道光线）。 */
const SUN_CORNER: readonly EnvIconShape[] = [
  dot(8, 7.6, 2.5),
  line(8, 3.1, 8, 4.6),
  line(3.5, 7.6, 5, 7.6),
  line(4.9, 4.5, 5.9, 5.5),
  line(11.1, 4.5, 10.1, 5.5),
];

/** 两条雾线。 */
const FOG: readonly EnvIconShape[] = [line(7.6, 19.4, 16.4, 19.4), line(9.2, 21.4, 14.8, 21.4)];

/** 短斜线（毛毛雨）。 */
const DRIZZLE_2: readonly EnvIconShape[] = [line(10, 19.4, 9.4, 20.9), line(13.4, 19.4, 12.8, 20.9)];
const DRIZZLE_3: readonly EnvIconShape[] = [
  line(9.4, 19.4, 8.8, 21),
  line(12, 19.4, 11.4, 21),
  line(14.6, 19.4, 14, 21),
];
const DRIZZLE_4: readonly EnvIconShape[] = [
  line(8.6, 19.4, 8.1, 20.6),
  line(11, 19.4, 10.5, 20.6),
  line(13.4, 19.4, 12.9, 20.6),
  line(15.8, 19.4, 15.3, 20.6),
];

/** 长斜线（雨）。 */
const RAIN_3: readonly EnvIconShape[] = [
  line(9.4, 19.4, 8.4, 21.8),
  line(12, 19.4, 11, 21.8),
  line(14.6, 19.4, 13.6, 21.8),
];
const RAIN_4: readonly EnvIconShape[] = [
  line(8.6, 19.2, 7.5, 22),
  line(11.2, 19.2, 10.1, 22),
  line(13.8, 19.2, 12.7, 22),
  line(16.4, 19.2, 15.3, 22),
];
const RAIN_5: readonly EnvIconShape[] = [
  line(7.6, 19, 6.6, 21.6),
  line(9.8, 19, 8.8, 21.6),
  line(12, 19, 11, 22),
  line(14.2, 19, 13.2, 21.6),
  line(16.4, 19, 15.4, 21.6),
];

/** 雪点：三颗 / 五颗 / 六颗，表示小、中、大雪。 */
const SNOW_3: readonly EnvIconShape[] = [dot(9.6, 20.4, 0.95), dot(12.4, 21.4, 0.95), dot(15.2, 20.4, 0.95)];
const SNOW_5: readonly EnvIconShape[] = [
  dot(8.6, 19.8, 0.8),
  dot(11.2, 20.8, 0.8),
  dot(13.6, 19.8, 0.8),
  dot(16, 20.8, 0.8),
  dot(13.6, 22, 0.8),
];
const SNOW_6: readonly EnvIconShape[] = [
  dot(8, 19.6, 0.75),
  dot(10.4, 20.6, 0.75),
  dot(12.8, 19.6, 0.75),
  dot(15.2, 20.6, 0.75),
  dot(17.6, 19.6, 0.75),
  dot(12.8, 21.8, 0.75),
];

/** 雪粒：两颗小点。 */
const GRAIN: readonly EnvIconShape[] = [dot(10.4, 20.6, 0.7), dot(13.6, 21.2, 0.7)];

/** 冰点：冻雨 / 冻毛毛雨 / 雾凇的标记。 */
const ICE: readonly EnvIconShape[] = [dot(18.6, 20.2, 0.95)];

/** 闪电。 */
const BOLT: EnvIconShape = { kind: 'path', d: 'M12.8 12.6l-2.6 4.6h2.2l-1.1 3.8 4.2-5.6h-2.2l1.4-2.8z' };

/** 冰雹：一颗 / 两颗。 */
const HAIL_1: readonly EnvIconShape[] = [dot(9.4, 21.2, 0.9)];
const HAIL_2: readonly EnvIconShape[] = [dot(9.4, 21.2, 0.9), dot(14.4, 21.6, 0.9)];

/** 码 → 形状；同组用不同数量区分强度，保证 27 个码两两不同。 */
const ICONS = new Map<number, readonly EnvIconShape[]>([
  [0, SUN],
  [1, [...SUN_CORNER, CLOUD_SM]],
  [2, [...SUN_CORNER, CLOUD_LG]],
  [3, [CLOUD]],
  [45, [CLOUD, ...FOG]],
  [48, [CLOUD, ...FOG, ...ICE]],
  [51, [CLOUD, ...DRIZZLE_2]],
  [53, [CLOUD, ...DRIZZLE_3]],
  [55, [CLOUD, ...DRIZZLE_4]],
  [56, [CLOUD, ...DRIZZLE_3, ...ICE]],
  [57, [CLOUD, ...DRIZZLE_4, ...ICE]],
  [61, [CLOUD, ...RAIN_3]],
  [63, [CLOUD, ...RAIN_4]],
  [65, [CLOUD, ...RAIN_5]],
  [66, [CLOUD, ...RAIN_3, ...ICE]],
  [67, [CLOUD, ...RAIN_4, ...ICE]],
  [71, [CLOUD, ...SNOW_3]],
  [73, [CLOUD, ...SNOW_5]],
  [75, [CLOUD, ...SNOW_6]],
  [77, [CLOUD, ...GRAIN]],
  [80, [...SUN_CORNER, CLOUD_SM, ...DRIZZLE_2]],
  [81, [...SUN_CORNER, CLOUD_SM, ...DRIZZLE_3]],
  [82, [...SUN_CORNER, CLOUD_SM, ...DRIZZLE_4]],
  [85, [...SUN_CORNER, CLOUD_SM, ...SNOW_3]],
  [86, [...SUN_CORNER, CLOUD_SM, ...SNOW_5]],
  [95, [CLOUD, BOLT]],
  [96, [CLOUD, BOLT, ...HAIL_1]],
  [99, [CLOUD, BOLT, ...HAIL_2]],
]);

/** 表外的码用的兜底图形（一朵云，与「阴」同形）。 */
const FALLBACK: readonly EnvIconShape[] = [CLOUD];

/**
 * 取某个天气码的图标形状。
 *
 * @param code - WMO 天气码；未知码（上游新增或数据异常）回落到云。
 * @returns 可直接映射成 SVG 子节点的形状列表。
 */
export function envIconShapes(code: number): readonly EnvIconShape[] {
  return ICONS.get(code) ?? FALLBACK;
}
