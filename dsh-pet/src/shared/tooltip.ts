// 宠物悬浮提示（两端共用同一份）——替代原生 title 属性，按**光标位置**显示（原生提示也是贴光标摆的）。
//
// 为什么不继续用原生 title：它的样式、字体、延迟全由浏览器/系统决定，改不动，也跟宠物观感无关；
// 它要显示的内容只是宠物显示名（host 已保证 name = rawName || id，见 host/config.ts，不会空）。
//
// 为什么放 src/shared：display: both 时同一只宠物在网页与桌面各显一只，两端提示必须同一个样、
// 同一个摆法（与 MENU_CSS / CHAT_CSS / SCORE_POPUP_CSS 同一条约定）。本模块给常量、class、
// 样式与**摆位纯函数**；节点构造与宽高实测留在两端各自的壳里（浏览器 React、桌面 DOM）。
//
// 坐标口径：定位用 position:fixed，坐标一律是「各端自己的视口坐标」——
//   浏览器 = 页面视口（clientX/clientY 直接用）；
//   桌面   = Electron 窗口（光标坐标由 onMouseMove 换算，另见 sprite.js 的注释）。
// 这样宠物自己走动/被抛出时窗口位移不会带着提示漂：坐标里没有容器位移这一项。
//
// 尺寸一律取宠物宽度变量：浏览器是 --dsh-pet-size、桌面是 --pet-size（两端既有差异），
// 用 CSS 变量回退同时兼容两者，调用方无需传尺寸（与 MEME_BUBBLE_CSS 同一手法）。
//
// 为什么不用 DSH 主题变量：settings.ts 的问号提示用 var(--dsw-alias-tooltip-bg)，那个变量只
// 存在于 DSH 页面，桌面 Electron 页里没有（会退化成透明底），所以这里自成一套浅色胶囊。

/** 提示框 class（两端共用） */
export const TOOLTIP_CLASS = 'pet-tooltip';

/** 光标与提示框之间的间隙（占宠物宽度比例）：462px 的宠物下约 10px，与原生提示的偏移观感接近 */
export const TOOLTIP_GAP_RATIO = 0.022;

/** 一个点（视口坐标） */
export type TipPoint = { x: number; y: number };
/** 矩形（与 {@link TipPoint} 同坐标系） */
export type TipRect = { x: number; y: number; w: number; h: number };

/**
 * 光标位置 + 提示框实测尺寸 + 允许显示范围 → 提示框左上角坐标。
 *
 * 摆法与原生提示一致：优先放光标**右下**；右边装不下翻到光标左侧，下边装不下翻到光标上方；
 * 翻完仍越界就夹回范围内（提示框比允许范围还宽时，至少保证左上角不越界）。两端共用同一份，
 * 避免出现「网页翻左、桌面翻右」这种不一致。
 *
 * 为什么尺寸要调用方实测（offsetWidth/offsetHeight）而不是按宠物宽度估算：翻边判据依赖真实宽高，
 * 估算偏大会贴着边就翻、偏小会越界被裁；提示框常驻 DOM（opacity:0 也有布局），实测不额外花代价。
 *
 * @param cursor 光标位置
 * @param tip 提示框实测尺寸（px）——调用方传 offsetWidth/offsetHeight
 * @param bounds 允许显示的范围：桌面端是「窗口 ∩ 光标所在屏的工作区」，浏览器端是整个视口
 * @param gap 光标与提示框的间隙（px）
 */
export function tooltipPlacement(
  cursor: TipPoint,
  tip: { w: number; h: number },
  bounds: TipRect,
  gap: number,
): TipPoint {
  const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));
  const rightMax = bounds.x + bounds.w;
  const bottomMax = bounds.y + bounds.h;
  // 横向：优先光标右侧，装不下翻到左侧
  let x = cursor.x + gap;
  if (x + tip.w > rightMax) x = cursor.x - gap - tip.w;
  x = clamp(x, bounds.x, rightMax - tip.w);
  // 纵向：优先光标下方，装不下翻到上方
  let y = cursor.y + gap;
  if (y + tip.h > bottomMax) y = cursor.y - gap - tip.h;
  y = clamp(y, bounds.y, bottomMax - tip.h);
  return { x, y };
}

/** 提示框样式 —— 两端注入同一份（客户端进 pet.ts 的 css 数组，桌面由 renderer.js 建 style 标签） */
export const TOOLTIP_CSS = [
  '.pet-tooltip{',
  // fixed + 坐标由 JS 按光标写（见 tooltipPlacement）：left/top 只是未定位前的兜底，不会显示出来
  'position:fixed;left:0;top:0;',
  'max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.8);',
  'padding:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.010) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.021);',
  'border-radius:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.016);',
  // 白底黑字（对齐原生提示的观感；文字色与气泡一致）——深色胶囊落在浅色宠物身上太抢眼
  'background:rgba(255,255,255,.96);color:#1f1f1f;',
  // 细边框：白底压到浅色宠物或浅色页面上会糊成一片，靠它划出轮廓（原生提示也有一道边）
  'border:1px solid rgba(0,0,0,.12);',
  // 字体与气泡同一套（上首软糖体由两端各自注入 @font-face：客户端 bubble.ts、桌面 renderer.js）
  'font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif;',
  // 字号对齐 Windows 原生提示（9pt ≈ 12px）：462px 的宠物下 0.026 → 约 12px
  'font-size:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.026);line-height:1.4;',
  // nowrap + 截断：宽度锁成一行才好和光标一起摆（换行会让宽度随位置跳变）
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
  // 不设 backdrop-filter：白底没必要，原生提示也没有毛玻璃
  'box-shadow:0 calc(var(--dsh-pet-size,var(--pet-size,462px))*0.004) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.013) rgba(0,0,0,.18);',
  // 层级低于气泡（气泡 z-index:3）：两者不再抢同一块地方（提示跟光标、气泡在头顶），保留层序只是兜底
  'opacity:0;transition:opacity .12s ease;pointer-events:none;z-index:2}',
  '.pet-tooltip.is-on{opacity:1}',
].join('');
