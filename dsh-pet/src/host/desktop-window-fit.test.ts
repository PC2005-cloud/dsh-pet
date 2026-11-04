/**
 * 桌面端「窗口落位」接线测试：把 sprite/window-fit.js 用替身全局加载一遍，断言它对窗口与偏移的处理。
 *
 * 为什么不只测纯函数：这条链路要跨三个经典 script（constants 的 CONFIG、sprite.js 的 PetSprite、
 * shared-core 的 fitWindowInArea），任何一处名字或加载顺序变了都会表现成「桌面上宠物跑到别处」，
 * 而这种错没有类型检查兜底。这里真跑一遍那段脚本，读的是行为不是文本。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MIN_REACHABLE_PX } from '../shared/constants.ts';
import { resolveRect } from '../shared/displays.ts';
import { fitWindowInArea } from '../shared/motion.ts';

const require = createRequire(import.meta.url);

/** 1920×1080 减 40px 任务栏。 */
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/** 替身全局：让经典 script 里的 CONFIG / WORK_AREAS / S / PetSprite / window 都能解析到。 */
const globals = globalThis as unknown as Record<string, unknown>;
globals.PetSprite = function PetSprite() {};
globals.CONFIG = { isWindowClampedToWorkArea: false };
globals.WORK_AREAS = [AREA];
globals.S = { resolveRect, fitWindowInArea, MIN_REACHABLE_PX };
globals.VIEW = { x: 0, y: 0, w: 1920, h: 1080 };
globals.toScreen = (v: number): number => v; // 上报单位换算在这里取 1:1，断言才看得懂
globals.window = { __dshPetDebug: {} };
// 只加载一次：模块缓存会让第二次 require 变成空操作，平台开关改成调用前改 CONFIG
require('../../runtime/electron-helper/sprite/window-fit.js');

/** 被测脚本挂到 PetSprite.prototype 上的窗口落位。 */
const spriteProto = (globals.PetSprite as { prototype: Record<string, unknown> }).prototype;

/** 切换「平台是否钳窗口」。 */
const setWindowClampedToWorkArea = (value: boolean): void => {
  (globals.CONFIG as { isWindowClampedToWorkArea: boolean }).isWindowClampedToWorkArea = value;
};

/** 窗口落位 + 尺寸：脚本把纯函数的结果补上窗口宽高一起返回。 */
type WindowFit = ReturnType<typeof fitWindowInArea> & { width: number; height: number };

/** 一只宠物在窗口落位里用到的全部状态（尺寸取 issue #274 的实测配置）。 */
interface Sprite {
  size: number;
  /** 本体高，不含脚底透明垫 */
  height: number;
  /** 本体高 + 脚底透明垫 */
  winH: number;
  halfW: number;
  halfH: number;
  margin: { l: number; r: number; t: number; b: number };
  pos: { x: number; y: number };
  winOffset: { x: number; y: number };
  el: { style: Record<string, string> };
  /** 命中区（精灵坐标）：左侧与顶部的透明留白由它决定。 */
  hitRect: { x: number; y: number; w: number; h: number };
  /** 视频盒左右两侧的透明留白。 */
  sideAllow: number;
  /** 飞行中的实时状态；静止时为 null/undefined。 */
  throwState?: { vx: number; vy: number } | null;
  fitWindow(): WindowFit;
  reportWindow(fit: WindowFit): void;
}

/** size 440：窗口 = 本体 + 左右下各 220、上 294；位置取配置 bottom-right（离右 24、离底 10）。 */
const makeSprite = (): Sprite =>
  Object.assign(Object.create(spriteProto), {
    size: 440,
    height: 247.5,
    winH: 268,
    halfW: 220,
    halfH: 123.75,
    margin: { l: 220, r: 220, t: 294, b: 220 },
    pos: { x: 1456, y: 782.5 },
    winOffset: { x: 220, y: 294 },
    el: { style: {} as Record<string, string> },
    bottomPad: 20.625,
    // 视频盒内角色以外的透明留白：左右各 137.5（= 0.3125×size），头顶 55、脚底 17.1
    sideAllow: 137.5,
    hitRect: { x: 137.5, y: 55, w: 165, h: 196 },
  }) as Sprite;

describe('sprite/window-fit.js —— 窗口落位接线', () => {
  test('平台不钳窗口（Windows / macOS）：窗口原样探出屏幕 → 本体偏移不动、不写样式', () => {
    setWindowClampedToWorkArea(false);
    const sprite = makeSprite();
    const fit = sprite.fitWindow();
    assert.deepEqual(fit, { x: 1236, y: 488.5, width: 880, height: 782, offsetX: 220, offsetY: 294 });
    assert.deepEqual(sprite.winOffset, { x: 220, y: 294 }, '没有钳制就不该改本体偏移');
    assert.deepEqual(sprite.el.style, {}, '值没变时不得写样式（逐帧调用）');
  });

  test('平台钳窗口（X11）：窗口被压回工作区 → 本体偏移吸收钳制量并落到 DOM', () => {
    setWindowClampedToWorkArea(true);
    const sprite = makeSprite();
    const fit = sprite.fitWindow();
    assert.deepEqual(fit, { x: 1040, y: 258, width: 880, height: 782, offsetX: 416, offsetY: 524.5 });
    assert.deepEqual(sprite.winOffset, { x: 416, y: 524.5 }, '偏移必须跟着变大，否则本体退回来一个余量');
    assert.equal(sprite.el.style.left, '416px');
    assert.equal(sprite.el.style.top, '524.5px');
  });

  test('窗口在工作区内挪动：偏移保持余量 → 本体位置 = 窗口原点 + 偏移', () => {
    setWindowClampedToWorkArea(true);
    const sprite = makeSprite();
    sprite.pos = { x: 600, y: 400 };
    const fit = sprite.fitWindow();
    assert.deepEqual(sprite.winOffset, { x: 220, y: 294 }, '工作区内不触发补偿');
    assert.equal(fit.x + fit.offsetX, 600);
    assert.equal(fit.y + fit.offsetY, 400);
  });

  test('贴右下角：窗口与偏移配合 → 本体落在配置的位置（离右 24、离底 10）', () => {
    setWindowClampedToWorkArea(true);
    const sprite = makeSprite();
    const fit = sprite.fitWindow();
    assert.equal(fit.x + fit.offsetX, 1456, '本体右缘 = 1456 + 440 = 1896，离屏右 24');
    assert.equal(fit.y + fit.offsetY, 782.5, '本体底缘 = 782.5 + 247.5 = 1030，离任务栏 10（配置值）');
    assert.ok(fit.x + fit.width <= AREA.width, '窗口不得越出工作区右缘（否则又被 WM 钳一次）');
    assert.ok(fit.y + fit.height <= AREA.height, '窗口不得越出工作区下缘');
  });

  test('上报主进程：一次捎带窗口矩形 + 本体盒 + 命中区偏移 → 参数次序即协议', () => {
    setWindowClampedToWorkArea(true);
    const sent: number[][] = [];
    const win = globals.window as { petBridge?: { setBounds: (...args: number[]) => void } };
    win.petBridge = { setBounds: (...args: number[]) => sent.push(args) };
    const sprite = makeSprite();
    const fit = sprite.fitWindow();
    // 与 sendBounds 同一步：先把 pos 落到实际可达位，再上报
    sprite.pos = { x: fit.x + fit.offsetX, y: fit.y + fit.offsetY };
    sprite.reportWindow(fit);
    assert.deepEqual(
      sent,
      [
        [
          1040, // 窗口 x
          258, // 窗口 y
          880, // 窗口宽
          782, // 窗口高
          1456, // 包围盒 x
          782.5, // 包围盒 y
          440, // 本体宽
          20.625, // 脚底透明垫（本体高里已含）
          0, // vx（静止）
          0, // vy
          416, // 命中区判定的左偏移
          524.5, // 命中区判定的上偏移
        ],
      ],
      '命中区与碰撞站场都读这一份，次序错了只会表现成点不中/撞不上',
    );
    delete win.petBridge;
  });

  test('越界：命中区留 24px 在屏幕内 → 本体可以挂出去（与网页端 clampReachableBox 同规则）', () => {
    setWindowClampedToWorkArea(true);
    const sprite = makeSprite();
    sprite.pos = { x: 9999, y: 9999 };
    const right = sprite.fitWindow();
    assert.equal(right.x + right.offsetX + sprite.hitRect.x, AREA.width - 24, '右侧：命中区左缘停在离屏幕右边 24px');
    sprite.pos = { x: 0, y: -9999 };
    const left = sprite.fitWindow();
    assert.equal(
      left.y + left.offsetY + sprite.hitRect.y + sprite.hitRect.h,
      24,
      '顶部：命中区底边留 24px，本体才挂在屏幕上方',
    );
    assert.equal(left.offsetY, -227, '挂出上方时偏移转负');
  });
});
