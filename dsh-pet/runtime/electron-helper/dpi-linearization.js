/**
 * dsh-pet desktop helper —— 「全局 DPI 线性化」的纯判定与纯换算。
 *
 * 背景（完整推理见 main.js 顶部那段长注释）：Windows 上 Chromium 的 DIP↔物理像素换算是**逐显示器**
 * 的仿射变换，窗口骑缝时会两套坐标系横跳（拖过屏缝「分身闪烁」）。helper 的修法是启动前
 * `--force-device-scale-factor=1` 把所有屏塌缩成同一个恒等映射，再按探测到的**真实主屏 scaleFactor**
 * 把宠物放大回原来的观感（`petScale()`）——这就是「线性化」+「补偿」两步。
 *
 * 这里把「要不要启用 / 强制成几 / 渲染端乘几」三条规则抽成纯函数：不 require('electron')、不读
 * process.env、不碰 fs，可被 node:test 直接加载单测（helper 是随包发行的手写 JS，Electron 在
 * 开发机上起不来，判定只能这样钉）。
 *
 * ★ 平台例外 —— 本模块被抽出来的直接原因（macOS 桌面宠物整整大一倍）：
 *
 *   上面那套补偿的前提是「force-device-scale-factor 会把 DIP 换算成物理像素」，**那是 Windows 的
 *   行为**。macOS 上 DIP 恒等于「点」，该开关只改 backing store 分辨率、不改坐标系：实测同一台
 *   机器（1920×1080 屏、backingScaleFactor=2）开关两种状态下，
 *   `screen.getPrimaryDisplay().workArea` 都报 1920×969 点、完全一致 —— 也就是**没有任何东西需要
 *   补偿**，`PRIMARY_SCALE / FORCED_SCALE` 恒为 2，成了纯粹的放大：
 *
 *     · petScale=2，配置 size=462 的宠物被渲染成 924 点宽；
 *     · 窗口（宠物 + 四周各 231 点余量）要 1848×1487 点 —— 比 1920×1080 的屏幕还高，左边缘被挤出
 *       屏幕外，宠物被顶到接近屏幕中央；
 *     · 而同一份配置在浏览器 overlay 里是 462 CSS 像素 —— 桌面端与浏览器端差了整整一倍。
 *
 *   故 darwin 一律不启用（`forcedScale` 停在 0，`petScale()` 回落 base），桌面端与浏览器端 1:1
 *   对齐，同时恢复 Retina 的原生 backing store。win32 / linux 行为完全不变。
 */

'use strict';

/**
 * 是否启用全局 DPI 线性化（+ 强制 device scale factor）。
 *
 * @param {{platform?: string, dpiProbe?: boolean, forceDsf?: string|number|null}} [o]
 *   platform: process.platform
 *   dpiProbe: 本进程是否就是 DPI 探测子进程（DSH_PET_DPI_PROBE=1）
 *   forceDsf: DSH_PET_FORCE_DSF 原始值（'0' = 关闭本机制；正数 = 排障用覆盖）
 * @returns {boolean}
 */
function shouldLinearize(o = {}) {
  if (o.dpiProbe) return false; // 探测子进程自己不做：它会再 spawn 一个探测子进程，无限递归
  if (String(o.forceDsf ?? '') === '0') return false; // 排障开关：整个机制关掉
  if (o.platform === 'darwin') return false; // macOS：DIP 已是「点」，没有可补偿的东西（见文件头）
  return true;
}

/**
 * 实际要强制成的 device scale factor（0 = 不启用）。
 *
 * 正数覆盖最优先（排障用，按注释里说的会踩上面的 bug）；否则只要探测到了真实主屏缩放就锁死 1
 * （恒等映射）；探测失败则返回 0 —— 宁可退回修复前的逐屏 DIP 行为，也不做没有补偿的缩放。
 *
 * @param {{forceDsf?: string|number|null, primaryScale?: number}} [o]
 * @returns {number}
 */
function resolveForcedScale(o = {}) {
  const override = Number(o.forceDsf);
  if (Number.isFinite(override) && override > 0) return override;
  return Number(o.primaryScale) > 0 ? 1 : 0;
}

/**
 * 渲染端的 CONFIG.scale = 宿主给的基准 × 物理像素补偿。
 *
 * 只有「线性化确实生效（forcedScale > 0）且探测到了真实主屏缩放」时才补偿，否则一律等于基准
 * （base 本身缺省/非法也回落 1）。
 *
 * @param {{baseScale?: string|number|null, primaryScale?: number, forcedScale?: number}} [o]
 * @returns {number}
 */
function resolvePetScale(o = {}) {
  const base = Number(o.baseScale ?? '1') || 1;
  const forced = Number(o.forcedScale) || 0;
  const primary = Number(o.primaryScale) || 0;
  return forced > 0 && primary > 0 ? base * (primary / forced) : base;
}

module.exports = {
  shouldLinearize,
  resolveForcedScale,
  resolvePetScale,
};
