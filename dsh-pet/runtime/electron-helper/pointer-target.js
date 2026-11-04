/**
 * 点击穿透兜底通道的纯判定（不 require electron，可被 node:test 直接加载）。
 * 窗口默认整窗穿透，常规链路只有 Electron 的 forward 鼠标钩子一个入口，而该钩子在 Windows 上会静默失效
 * ——失效后悬浮、拖拽、点击与右键全无反应。本模块只算「该不该可交互」，主进程负责取光标并翻转窗口；
 * 坐标一律 DIP（窗口矩形与光标同单位）。
 * @module dsh-pet/runtime/electron-helper/pointer-target
 */

'use strict';

/** 宠物身体命中区（画布坐标，与 src/shared/constants.ts 的 HIT_BOX 一致；守卫测试钉住二者同步） */
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
/** 动画画布尺寸：高取 shared 的 CANVAS_H，宽与 sprite.js / shared 一样用字面量 640（shared 未导出宽） */
const CANVAS_H = 360;
const STAGE_W = 640;
const FEET_Y = 330;

/**
 * 窗口矩形 → 宠物身体命中区的屏幕矩形（DIP）。
 *
 * 窗口 = 宠物包围盒 + 四周余量，而余量不再四边相等（上边距按气泡最大高度加高），所以不能按
 * 「窗口宽/4」反推，否则命中区整体偏移。左/上偏移由渲染端随 setBounds 上报，右侧由主进程按
 * 「窗口宽 − 本体宽 − 左偏移」算出——窗口被系统钳回工作区后本体在窗口内会向右偏，左右不再是同一个数。
 *
 * @param bounds - 窗口矩形（DIP）。
 * @param margins - 渲染端上报的左/上偏移（DIP），右侧可在 margins.r 给出。
 */
function spriteHitRect(bounds, margins) {
  const legacy = Math.round(bounds.width / 4);
  const ml = Number.isFinite(margins?.l) ? margins.l : legacy;
  const mt = Number.isFinite(margins?.t) ? margins.t : legacy;
  const mr = Number.isFinite(margins?.r) ? margins.r : ml;
  const stageW = Math.max(0, bounds.width - ml - mr);
  const stageH = (stageW * CANVAS_H) / STAGE_W;
  const bottomPad = (stageH * (CANVAS_H - FEET_Y)) / CANVAS_H;
  return {
    left: bounds.x + ml + (HIT_BOX.x0 / STAGE_W) * stageW,
    top: bounds.y + mt + bottomPad + (HIT_BOX.y0 / CANVAS_H) * stageH,
    right: bounds.x + ml + (HIT_BOX.x1 / STAGE_W) * stageW,
    bottom: bounds.y + mt + bottomPad + (HIT_BOX.y1 / CANVAS_H) * stageH,
  };
}

/** 判定轮询间隔（ms） */
const POINTER_POLL_MS = 60;

/** 光标停在窗口余量区（非 busy）的最长保持时间（ms）：超过即恢复穿透 */
const OFF_BODY_RELEASE_MS = 400;

/**
 * 光标相对窗口的分区：'outside' | 'body' | 'margin'。
 *
 * 主进程除判定外还要按分区累计余量区停留时长；分区规则只在此处维护，避免两条通道漂移。
 *
 * @param bounds - 窗口矩形（DIP）。
 * @param point - 真实光标位置（DIP）。
 * @param margins - 渲染端上报的左/上偏移（DIP），见 spriteHitRect。
 * @returns 分区。
 */
function pointerZone(bounds, point, margins) {
  const inWindow =
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height;
  if (!inWindow) return 'outside';
  const r = spriteHitRect(bounds, margins);
  const inSprite = point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
  return inSprite ? 'body' : 'margin';
}

/**
 * 该不该让窗口保持穿透（setIgnoreMouseEvents 的第一个参数）。
 * busy 期间位置完全不参与：拖拽时宠物滞后于光标，位置判定会断掉正在用的 pointermove/pointerup。
 *
 * @param ignoring - 当前是否穿透（取自主进程镜像，避免与渲染端通道失步）。
 * @param busy - 渲染端是否正在使用本窗口的鼠标输入。
 * @param offBodyMs - 余量区（非 busy）的连续停留时长。
 * @param input - 渲染端上报的控件矩形与拖拽标记。
 * @param margins - 渲染端上报的左/上偏移（DIP）。
 * @returns 新的穿透状态。
 */
function decideWindowIgnore(bounds, point, ignoring, busy, offBodyMs = 0, input, margins) {
  if (busy) {
    if (!input || input.dragging) return false; // 兼容旧渲染端；拖拽租约绝不被位置判定打断
    const inControl = input.rects.some(
      (r) =>
        point.x >= bounds.x + r.x &&
        point.x < bounds.x + r.x + r.width &&
        point.y >= bounds.y + r.y &&
        point.y < bounds.y + r.y + r.height,
    );
    return !inControl && pointerZone(bounds, point, margins) !== 'body';
  }
  const zone = pointerZone(bounds, point, margins);
  if (zone === 'outside') return true; // 窗外：恢复穿透
  if (zone === 'body') return false; // 宠物身上：可交互
  if (offBodyMs >= OFF_BODY_RELEASE_MS) return true; // 余量区停留超时：恢复穿透
  return ignoring; // 余量区：保持（菜单/弹窗由 busy 覆盖）
}

module.exports = {
  HIT_BOX,
  CANVAS_H,
  STAGE_W,
  FEET_Y,
  POINTER_POLL_MS,
  OFF_BODY_RELEASE_MS,
  spriteHitRect,
  pointerZone,
  decideWindowIgnore,
};
