/**
 * 窗口落位测试：本体贴屏幕边时，窗口被窗口管理器钳回工作区后，本体如何靠窗口内偏移补回来。
 *
 * 尺寸取 issue #274 的实测配置：宠物 size 440（本体 440×247.5），窗口 = 本体 + 左右下各 220、
 * 上 294（气泡/待办面板高度），工作区 1920×1040（1920×1080 减 40px 任务栏）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorPixel, fitWindowInArea } from './motion.ts';

/** 实测窗口尺寸：左右余量 0.5×size，上余量取气泡/待办面板高度的最大值。 */
const WINDOW = { width: 880, height: 782 };
/** 本体盒：宽 = 视频盒宽，高不含脚底透明垫（那截允许出窗口）。 */
const BODY = { width: 440, height: 247.5 };
/** 期望余量 = 窗口原点到本体原点。 */
const INSET = { x: 220, y: 294 };
/** 1920×1080 减去 40px 任务栏。 */
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/** 与调用方一致的入参：本体位置取配置的右下角 + 边距。 */
const fitOf = (bodyX: number, bodyY: number, extra: Partial<Parameters<typeof fitWindowInArea>[0]> = {}) =>
  fitWindowInArea({
    bodyX,
    bodyY,
    width: WINDOW.width,
    height: WINDOW.height,
    bodyWidth: BODY.width,
    bodyHeight: BODY.height,
    insetX: INSET.x,
    insetY: INSET.y,
    ...extra,
  });

describe('fitWindowInArea —— 不钳窗口的平台（Windows / macOS）', () => {
  test('没有工作区：窗口原样探出屏幕 → 本体偏移就是余量', () => {
    const fit = fitOf(1456, 782.5);
    assert.deepEqual(fit, { x: 1236, y: 488.5, offsetX: 220, offsetY: 294 });
  });

  test('窗口本该探出屏幕：不钳制 → 探出屏幕是两端一致的老行为', () => {
    const fit = fitOf(1456, 782.5, { area: undefined });
    assert.equal(fit.x + fit.offsetX, 1456, '窗口原点 + 偏移 = 本体位置');
    assert.equal(fit.y + fit.offsetY, 782.5);
  });
});

describe('fitWindowInArea —— 钳窗口的平台（X11 等把窗口关在工作区里的 WM）', () => {
  test('本体贴右下角：窗口被钳进工作区 → 钳掉的量转成本体偏移，本体落脚点不变', () => {
    const fit = fitOf(1456, 782.5, { area: AREA });
    assert.deepEqual(fit, { x: 1040, y: 258, offsetX: 416, offsetY: 524.5 }, 'x/y = 工作区右下减窗口尺寸');
    assert.equal(fit.x + fit.offsetX, 1456, '本体仍在配置的 x');
    assert.equal(fit.y + fit.offsetY, 782.5, '本体仍在配置的 y');
    assert.ok(fit.offsetX > INSET.x && fit.offsetY > INSET.y, '偏移必须被钳制放大，否则本体退回来一个余量');
  });

  test('窗口在工作区内：偏移保持余量 → 与不钳制的平台逐位一致', () => {
    const fit = fitOf(600, 400, { area: AREA });
    assert.deepEqual(fit, { x: 380, y: 106, offsetX: 220, offsetY: 294 });
  });

  test('贴顶：窗口停在工区顶边 → 本体偏移压到 0（四边都钳，漏一边就能把本体拖出屏幕）', () => {
    const body = anchorPixel({
      corner: 'top-left',
      marginX: 24,
      marginY: 0,
      size: BODY.width,
      W: AREA.width,
      H: AREA.height,
      area: AREA,
    });
    const fit = fitOf(body.x, body.y, { area: AREA });
    assert.equal(fit.x, AREA.x, '左边界照钳');
    assert.equal(fit.y, AREA.y, '窗口顶边贴在工区顶边');
    assert.equal(fit.offsetY, 0, '本体顶边与窗口顶边重合，宠物才真的贴到屏幕顶');
    assert.equal(fit.x + fit.offsetX, 24, '本体离左边 24px，靠窗口内偏移 24 实现');
  });

  test('工作区比窗口还小：本体被夹进工作区 → 窗口贴住起点', () => {
    // 工作区只剩 600×400（窗口 880×782 装不下）：窗口贴住起点，本体按工作区夹到能站的位置
    const narrow = { x: 0, y: 0, width: 600, height: 400 };
    const fit = fitOf(560, 700, { area: narrow });
    assert.equal(fit.x, 0, '窗口比工作区宽时贴住起点');
    assert.equal(fit.x + fit.offsetX, 160, '本体左边最多到 600 − 440');
    assert.equal(fit.y + fit.offsetY, 152.5, '本体上边最多到 400 − 247.5');
  });

  test('越界允许量 reach：本体可以挂出工作区 → 越界那截由窗口裁掉', () => {
    const reach = { left: 144, right: 144, top: 0, bottom: 0 };
    const right = fitOf(1920, 782.5, { area: AREA, reach });
    assert.equal(right.x + right.offsetX, 1624, '本体右边可以挂到 1920 + 144 − 440');
    assert.equal(right.x + right.offsetX + BODY.width, AREA.width + reach.right, '盒右缘正好超出 reach');
    const left = fitOf(-100, 782.5, { area: AREA, reach });
    assert.equal(left.offsetX, -100, '左侧同样允许挂出，偏移转负');
  });

  test('不给 reach：本体完全留在工作区内（缺省不放宽）', () => {
    const fit = fitOf(5000, 5000, { area: AREA });
    assert.equal(fit.x + fit.offsetX, AREA.width - BODY.width);
    assert.equal(fit.y + fit.offsetY, AREA.height - BODY.height);
  });

  test('本体落在工作区外（空洞里） → 偏移夹到 0，不会把本体摆到窗口左边/上边去', () => {
    const right = { x: 1000, y: 500, width: 800, height: 600 };
    const fit = fitOf(0, 0, { area: right });
    assert.equal(fit.x, 1000, '窗口被拉回工作区');
    assert.equal(fit.offsetX, 0);
    assert.equal(fit.offsetY, 0);
  });
});

describe('fitWindowInArea —— 与角落定位拼起来的端到端落点', () => {
  test('配置 bottom-right + marginX24 + marginY10：不给 reach → 本体落在离右 24、离底 10', () => {
    const body = anchorPixel({
      corner: 'bottom-right',
      marginX: 24,
      marginY: 10,
      size: BODY.width,
      W: AREA.width,
      H: AREA.height,
      area: AREA,
    });
    const fit = fitOf(body.x, body.y, { area: AREA });
    assert.equal(fit.x + fit.offsetX, 1456, '右：1920 − 440 − 24 = 1456');
    assert.equal(fit.y + fit.offsetY, 782.5, '底：1040 − 247.5 − 10 = 782.5');
  });
});
