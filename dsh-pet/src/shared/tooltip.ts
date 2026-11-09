/**
 * 宠物悬浮提示：替代原生 title（它的样式、字体、延迟全由浏览器或系统决定，改不动），按光标位置显示。
 * 本模块给 class、样式与摆位纯函数；节点构造与宽高实测留在两端各自的壳里。
 * 坐标一律是各端自己的视口坐标（fixed 定位），宠物走动或窗口位移不会带着提示漂。
 * 尺寸取宠物宽的 CSS 变量（两端变量名不同），用回退兼容，调用方无需传尺寸。
 * 不用 DSH 主题变量：它只存在于 DSH 页面，桌面 Electron 页里没有，会退化成透明底。
 * @module dsh-pet/src/shared/tooltip
 */
/** 提示框 class（两端共用）。 */
export const TOOLTIP_CLASS = 'pet-tooltip';

/** 光标与提示框之间的间隙（占宠物宽度比例）：462px 的宠物下约 10px，与原生提示的偏移观感接近。 */
export const TOOLTIP_GAP_RATIO = 0.022;

/** 一个点（视口坐标）。 */
export type TipPoint = { x: number; y: number };
/** 矩形（与 TipPoint 同坐标系）。 */
export type TipRect = { x: number; y: number; w: number; h: number };

/** 光标位置 + 提示框实测尺寸 + 允许范围 → 提示框左上角坐标。
 *  摆法与原生提示一致：优先放光标右下，右边装不下翻到左侧，下边装不下翻到上方，翻完仍越界就夹回范围内。
 *  尺寸必须实测（offsetWidth/offsetHeight）：翻边判据依赖真实宽高，估算偏大会贴着边就翻、偏小会越界被裁。
 *  @param cursor - 光标位置。
 *  @param tip - 提示框实测尺寸（px）。
 *  @param bounds - 允许显示的范围：桌面端是窗口 ∩ 光标所在屏的工作区，浏览器端是整个视口。
 *  @param gap - 光标与提示框的间隙（px）。 */
export function tooltipPlacement(
  cursor: TipPoint,
  tip: { w: number; h: number },
  bounds: TipRect,
  gap: number,
): TipPoint {
  const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));
  const rightMax = bounds.x + bounds.w;
  const bottomMax = bounds.y + bounds.h;
  let x = cursor.x + gap;
  if (x + tip.w > rightMax) x = cursor.x - gap - tip.w;
  x = clamp(x, bounds.x, rightMax - tip.w);
  let y = cursor.y + gap;
  if (y + tip.h > bottomMax) y = cursor.y - gap - tip.h;
  y = clamp(y, bounds.y, bottomMax - tip.h);
  return { x, y };
}

/** 提示框样式 —— 两端注入同一份（浏览器并入插件 CSS，桌面由 renderer.js 建 style 标签）。 */
export const TOOLTIP_CSS = [
  '.pet-tooltip{',
  // fixed + 坐标由 JS 按光标写：left/top 只是未定位前的兜底，不会真的显示
  'position:fixed;left:0;top:0;',
  'max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.8);',
  'padding:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.010) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.021);',
  'border-radius:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.016);',
  // 白底黑字：对齐原生提示的观感，深色胶囊落在浅色宠物身上太抢眼
  'background:rgba(255,255,255,.96);color:#1f1f1f;',
  // 细边框：白底压在浅色宠物或浅色页面上会糊成一片，靠它划出轮廓
  'border:1px solid rgba(0,0,0,.12);',
  // 字体与气泡同一套；字体族走全局配置变量（注入在 documentElement），继承不到宠物根容器
  'font-family:var(--dsh-pet-font-family,"DshPetRu","ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif);',
  // 字号对齐 Windows 原生提示（9pt ≈ 12px）：462px 的宠物下 0.026 → 约 12px。
  // --dsh-pet-font-tip 由两端按该宠物尺寸算好注入（shared/fonts.ts 的 resolveFontPx），未注入时回退原表达式。
  'font-size:var(--dsh-pet-font-tip,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.026));line-height:1.4;',
  // nowrap + 截断：宽度锁成一行才好和光标一起摆（换行会让宽度随位置跳变）
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
  // 不设 backdrop-filter：白底没必要，原生提示也没有毛玻璃
  'box-shadow:0 calc(var(--dsh-pet-size,var(--pet-size,462px))*0.004) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.013) rgba(0,0,0,.18);',
  // 层级低于气泡：两者不抢同一块地方（提示跟光标、气泡在头顶），保留层序只是兜底
  'opacity:0;transition:opacity .12s ease;pointer-events:none;z-index:2}',
  '.pet-tooltip.is-on{opacity:1}',
].join('');
