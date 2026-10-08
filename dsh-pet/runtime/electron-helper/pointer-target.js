/**
 * dsh-pet desktop helper —— 点击穿透「兜底通道」的纯判定（issue #55 报告者补丁的逻辑部分）。
 *
 * 背景：窗口默认整窗点击穿透（`setIgnoreMouseEvents(true, { forward: true })`），只靠 Electron 的
 * forward 低级鼠标钩子把 mousemove 转发进渲染端，渲染端再做命中判定并 IPC 回来翻转可交互——
 * **整条链路只有一个入口**。该钩子在 Windows 上会静默失效（回调超时被系统摘掉、或被其它软件的
 * 钩子干扰），失效后没有任何退路：光标悬浮不触发手套光标、拖不动、点击与右键全无反应。
 *
 * 这里把「按真实光标位置决定要不要可交互」抽成纯函数：不 require('electron')，可被 node:test
 * 直接加载单测。主进程侧只负责 60ms 轮询取光标 + 调用本函数 + 翻转窗口。
 *
 * 坐标系：全部用 DIP（`win.getBounds()` 与 `screen.getCursorScreenPoint()` 同为 DIP，可比）。
 */

'use strict';

/** 宠物身体命中区（画布坐标，与 src/shared/constants.ts 的 HIT_BOX 一致；守卫测试钉住二者同步） */
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
/** 动画画布尺寸：高取 shared 的 CANVAS_H，宽与 sprite.js / shared 一样用字面量 640（shared 未导出宽） */
const CANVAS_H = 360;
const STAGE_W = 640;

/**
 * 窗口矩形 → 宠物身体命中区的屏幕矩形（DIP）。
 * 窗口 = 宠物包围盒 + 四周各半只宠物的余量（renderer 的 WINDOW_MARGIN_RATIO = 0.5）：
 * 横向 `margin = round(width / 4)`、stageW = width − 2×margin；纵向从窗口顶边往下 margin 才是画布顶边
 * （底部还多一个 bottomPad，命中区计算用不到）。判定公式与渲染端 sprite.js 的命中判定同源，
 * 故两条通道的判定区域严格一致（报告者补丁里用 width/4 内缩会覆盖整个画布，比身体大一倍多）。
 */
function spriteHitRect(bounds) {
  const margin = Math.round(bounds.width / 4);
  const stageW = bounds.width - margin * 2;
  const stageH = (stageW * CANVAS_H) / STAGE_W;
  return {
    left: bounds.x + margin + (HIT_BOX.x0 / STAGE_W) * stageW,
    top: bounds.y + margin + (HIT_BOX.y0 / CANVAS_H) * stageH,
    right: bounds.x + margin + (HIT_BOX.x1 / STAGE_W) * stageW,
    bottom: bounds.y + margin + (HIT_BOX.y1 / CANVAS_H) * stageH,
  };
}

/** 判定轮询间隔（ms，与 issue #55 报告者实测值一致） */
const POINTER_POLL_MS = 60;

/** 光标停在窗口余量区（非 busy）的最长保持时间（ms）：超过即恢复穿透 */
const OFF_BODY_RELEASE_MS = 400;

/**
 * 光标相对窗口的分区：'outside' | 'body' | 'margin'。
 *
 * 主进程除判定外还要按分区累计余量区停留时长，判定区域只在此处维护，避免两条通道漂移。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口矩形（DIP）
 * @param {{x:number,y:number}} point 真实光标位置（DIP）
 * @returns {'outside'|'body'|'margin'} 分区
 */
function pointerZone(bounds, point) {
  const inWindow =
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height;
  if (!inWindow) return 'outside';
  const r = spriteHitRect(bounds);
  const inSprite = point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
  return inSprite ? 'body' : 'margin';
}

/**
 * 该不该让窗口保持穿透（= `setIgnoreMouseEvents` 的第一个参数）。
 *
 * 规则（与 issue #55 报告者实测的表一致）：
 *  - 渲染端正拿着鼠标输入（拖拽中 / 菜单开着 / 对话弹窗开着）→ **不穿透**，最高优先级；
 *  - 光标在宠物身体上 → 不穿透（可交互）；
 *  - 光标在窗口内、宠物外 → **保持当前状态**（渲染端自绘的右键菜单/对话弹窗要可点），
 *    但非 busy 且连续停留超过 OFF_BODY_RELEASE_MS 后强制恢复穿透；
 *  - 光标在窗口外 → 恢复穿透（透明像素不挡下层应用）。
 *
 * 为什么 busy 必须优先于位置判定（0.2.10 的回归）：本函数判定的是**光标与窗口矩形**的关系，
 * 而窗口矩形比宠物身体大一圈（四周各半只宠物的余量）。拖拽时宠物由 rAF 弹簧追赶光标、**滞后**于
 * 光标；甩得快时滞后量超过那一圈余量，光标就落在矩形外 → 判成"窗外" → 翻回穿透 → 渲染端正在
 * 拖拽的 window 级 pointermove/pointerup 全断（鼠标还按着，宠物却按旧速度"飞"出去；速度不是被
 * 估算出来的——收不到 pointermove 就采不到新轨迹，连松手的 pointerup 都没人报，轨迹停在最后一次
 * 采样上继续积分）。所以"正拿着输入"这件事必须能**否决**位置判定，而不是被位置判定否决。
 *
 * 位置判定里**不含**拖拽容差：一旦 busy，位置完全不参与（任何"离得近才算"的阈值都会重新引入
 * "滞后量 > 余量"这个致命条件，正是 bug 本身）。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口矩形（DIP）
 * @param {{x:number,y:number}} point 真实光标位置（screen.getCursorScreenPoint()，DIP）
 * @param {boolean} ignoring 窗口当前是否穿透（取自主进程的 windowIgnore 镜像，不用本地副本：
 *   渲染端那条通道也在翻转它，本地副本会与之失步）
 * @param {boolean} busy 渲染端是否正在用这个窗口的鼠标输入（拖拽中/菜单开/弹窗开，见 inputBusy）
 * @param {number} [offBodyMs=0] 光标在窗口余量区（非 busy）的连续停留时长，超时即恢复穿透
 * @returns {boolean} 新的穿透状态
 */
function decideWindowIgnore(bounds, point, ignoring, busy, offBodyMs = 0) {
  if (busy) return false; // 输入租约期内保持可交互
  const zone = pointerZone(bounds, point);
  if (zone === 'outside') return true; // 窗外：恢复穿透
  if (zone === 'body') return false; // 宠物身上：可交互
  if (offBodyMs >= OFF_BODY_RELEASE_MS) return true; // 余量区停留超时：恢复穿透
  return ignoring; // 余量区：保持（菜单/弹窗由 busy 覆盖）
}

module.exports = {
  HIT_BOX,
  CANVAS_H,
  STAGE_W,
  POINTER_POLL_MS,
  OFF_BODY_RELEASE_MS,
  spriteHitRect,
  pointerZone,
  decideWindowIgnore,
};
