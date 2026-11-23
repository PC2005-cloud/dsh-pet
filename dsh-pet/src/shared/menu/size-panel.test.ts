/**
 * 大小滑块浮层的纯逻辑测试：只钉定位（不碰 DOM，Node 里也能跑）。
 *
 * 跑法：node --experimental-strip-types --test src/shared/menu/size-panel.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { placeSizePanel } from './size-panel.ts';

describe('placeSizePanel —— 贴着右键落点摆，放不下就翻面并夹回视口', () => {
  test('空间够：左上角对准落点', () => {
    assert.deepEqual(placeSizePanel(100, 100, 220, 90, 1920, 1080), { left: 100, top: 100 });
  });

  test('右侧放不下：横向夹回视口内', () => {
    assert.deepEqual(placeSizePanel(1900, 100, 220, 90, 1920, 1080), { left: 1692, top: 100 });
  });

  test('下方放不下：翻到落点上方', () => {
    assert.deepEqual(placeSizePanel(100, 1060, 220, 90, 1920, 1080), { left: 100, top: 970 });
  });

  test('视口比面板还小：两端都贴到安全边距', () => {
    assert.deepEqual(placeSizePanel(10, 70, 220, 90, 200, 80), { left: 8, top: 8 });
  });

  test('负坐标不会把面板推出视口', () => {
    assert.deepEqual(placeSizePanel(-40, -20, 220, 90, 1920, 1080), { left: 8, top: 8 });
  });
});

describe('placeSizePanel —— 桌面端传入窗口与工作区的交集', () => {
  test('可用区从 (100,50) 起算：右下越界都夹回区内', () => {
    assert.deepEqual(placeSizePanel(650, 400, 220, 90, 1920, 1080, { x: 100, y: 50, w: 600, h: 400 }), {
      left: 472,
      top: 310,
    });
  });

  test('落点在可用区左上方：贴到区内的安全边距', () => {
    assert.deepEqual(placeSizePanel(0, 0, 220, 90, 1920, 1080, { x: 100, y: 50, w: 600, h: 400 }), {
      left: 108,
      top: 58,
    });
  });

  test('可用区比面板还窄：横向贴左边而不是被推出去', () => {
    assert.deepEqual(placeSizePanel(300, 200, 220, 90, 1920, 1080, { x: 40, y: 30, w: 120, h: 300 }), {
      left: 48,
      top: 200,
    });
  });
});
