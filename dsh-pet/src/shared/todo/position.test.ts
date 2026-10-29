/**
 * 待办面板定位的单元测试：优先放上方，上方不够翻到下方，水平方向夹在视口内。
 *
 * 跑法：node --experimental-strip-types --test src/shared/todo/position.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { placeTodoPanel } from './position.ts';

/** 视口：1000×800。 */
const VIEWPORT = { width: 1000, height: 800 };
/** 面板：300×400。 */
const PANEL = { width: 300, height: 400 };

describe('placeTodoPanel —— 落点', () => {
  test('命中区上方放得下：居中放在上方，留出间距', () => {
    const anchor = { left: 400, top: 600, right: 600, bottom: 700 };
    const point = placeTodoPanel(anchor, PANEL, VIEWPORT);
    assert.equal(point.left, 350); // 中心 500 - 150
    assert.equal(point.top, 188); // 600 - 400 - 12
  });

  test('上方放不下：翻到下方', () => {
    const anchor = { left: 400, top: 100, right: 600, bottom: 200 };
    const point = placeTodoPanel(anchor, PANEL, VIEWPORT);
    assert.equal(point.top, 212); // 200 + 12
  });

  test('靠左 / 靠右时水平夹进视口', () => {
    assert.equal(placeTodoPanel({ left: 0, top: 600, right: 100, bottom: 700 }, PANEL, VIEWPORT).left, 8);
    assert.equal(
      placeTodoPanel({ left: 950, top: 600, right: 990, bottom: 700 }, PANEL, VIEWPORT).left,
      VIEWPORT.width - PANEL.width - 8,
    );
  });

  test('面板比视口还高：上方与下方都放不下时贴上缘', () => {
    const anchor = { left: 400, top: 300, right: 600, bottom: 380 };
    const point = placeTodoPanel(anchor, { width: 300, height: 900 }, VIEWPORT);
    assert.equal(point.top, 8);
  });
});
