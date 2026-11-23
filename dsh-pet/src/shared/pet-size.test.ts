/**
 * 百分比尺寸解析的单元测试：钉住「size 是上限、百分比只收口」与缺省回落的边界。
 *
 * 跑法：node --experimental-strip-types --test src/shared/pet-size.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidSizePercent,
  resolvePetSizePx,
  resolveSizeBounds,
  SIZE_PERCENT_MIN,
  SIZE_PX_MAX,
  SIZE_PX_MIN,
} from './pet-size.ts';

describe('isValidSizePercent —— 不小于 1 的有限数（不设上限）', () => {
  test('合法：包含超过 100 的值', () => {
    for (const value of [SIZE_PERCENT_MIN, 40, 99.5, 100, 150, 400]) {
      assert.equal(isValidSizePercent(value), true, `${value} 应合法`);
    }
  });

  test('非数字与小于下限的值都不合法', () => {
    for (const value of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '40', null, undefined, true, { a: 1 }]) {
      assert.equal(isValidSizePercent(value), false, `${String(value)} 应非法`);
    }
  });
});

describe('resolvePetSizePx —— 百分比按人物本体换算成画框宽度', () => {
  test('没配百分比 → 按默认 20：宽窗口等于 px，窄窗口被屏宽夹住', () => {
    assert.equal(resolvePetSizePx(400, undefined, 1920), 400);
    assert.equal(resolvePetSizePx(400, undefined, 375), 200);
  });

  test('窄屏：20% 人物 → 画框 200px（本体 75px = 屏宽 20%）', () => {
    assert.equal(resolvePetSizePx(462, 20, 375), 200);
  });

  test('宽屏：百分比算出的画框超过 size → 仍取 px（桌面观感不变）', () => {
    assert.equal(resolvePetSizePx(400, 40, 1920), 400);
  });

  test('刚好卡在 size 上时取该值', () => {
    // 375 × 40% = 150 本体 → 画框 400，正好等于 size
    assert.equal(resolvePetSizePx(400, 40, 375), 400);
  });

  test('视口拿不到（0 / 负数 / 非数）→ 回落到 px', () => {
    for (const width of [0, -100, Number.NaN]) {
      assert.equal(resolvePetSizePx(400, 40, width), 400, `${width} 应回落`);
    }
  });

  test('百分比非法 → 回落到 px（配置脏值不进渲染）', () => {
    for (const value of [0, 101, Number.NaN]) {
      assert.equal(resolvePetSizePx(400, value, 375), 400, `${value} 应回落`);
    }
  });

  test('平板竖屏：15% 人物 → 画框 307.2（本体 115.2 = 768 的 15%）', () => {
    assert.equal(resolvePetSizePx(462, 15, 768), 307.2);
  });
});

describe('resolveSizeBounds —— 滑块范围由百分比上限与当前值共同决定', () => {
  test('1080p 默认 20%：上限 1024，当前 462', () => {
    assert.deepEqual(resolveSizeBounds(462, undefined, 1920), { min: SIZE_PX_MIN, max: 1024, value: 462 });
  });

  test('平板竖屏 15%：调用方传实际渲染值 307，滑块只在 120~307 里走', () => {
    assert.deepEqual(resolveSizeBounds(307.2, 15, 768), { min: SIZE_PX_MIN, max: 307, value: 307 });
  });

  test('当前值超过百分比上限：上限放宽到当前值，滑块不会一拖就跳', () => {
    assert.deepEqual(resolveSizeBounds(2000, 20, 1920), { min: SIZE_PX_MIN, max: 2000, value: 2000 });
  });

  test('上限比下限还小：两头一起收到上限（小屏塞不下 120px）', () => {
    assert.deepEqual(resolveSizeBounds(20, 2, 375), { min: 20, max: 20, value: 20 });
  });

  test('视口拿不到 → 用兜底上限 SIZE_PX_MAX', () => {
    assert.deepEqual(resolveSizeBounds(462, 20, 0), { min: SIZE_PX_MIN, max: SIZE_PX_MAX, value: 462 });
  });

  test('脏值与小数：当前值先取整再夹进范围', () => {
    assert.deepEqual(resolveSizeBounds(Number.NaN, 20, 1920), {
      min: SIZE_PX_MIN,
      max: 1024,
      value: SIZE_PX_MIN,
    });
    assert.equal(resolveSizeBounds(264.6, 20, 1920).value, 265);
    assert.equal(resolveSizeBounds(50, 20, 1920).value, SIZE_PX_MIN);
  });
});
