/**
 * 级联菜单面板落点（`pickPanelPosition`）的几何测试。
 *
 * 背景：多级菜单曾出现"二级压一级、三级压二级"——`showPanel` 原先只判断"右侧放不下就翻到
 * **触发项**左侧"，而触发项就在父面板里，翻左等于直接压在父面板上。定位逻辑抽成纯函数后，
 * 这里把"不与任何已展开面板重叠"这条不变量钉住。
 *
 * 用例取自真机实测的尺寸（KDE Plasma 6 / 151% 缩放）：面板约 220×320，窗口夹取矩形 900×520。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pickPanelPosition } from './menu.ts';
import type { PanelBox } from './menu.ts';

/** 视口坐标里的夹取范围（窗口 ∩ 工作区） */
const CLAMP = { x: 0, y: 0, w: 900, h: 520 };

/** 一个面板矩形（左上角 + 尺寸 → 四条边） */
const box = (left: number, top: number, w: number, h: number): PanelBox => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

/** 两个矩形是否相交（严格相交，边贴边不算） */
const overlaps = (a: PanelBox, b: PanelBox): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** 落点 → 矩形，便于与 others 比对 */
const at = (left: number, top: number, w: number, h: number): PanelBox => box(left, top, w, h);

describe('pickPanelPosition —— 级联面板不重叠', () => {
  const panel = { w: 220, h: 320 };

  test('二级：父面板右侧放得下 → 贴在父面板右边，且不与父面板相交', () => {
    const parent = box(100, 100, 220, 320);
    const item = { left: 100, right: 320, top: 120 };
    const p = pickPanelPosition({
      panel,
      item,
      parent: { left: parent.left, right: parent.right, top: parent.top },
      others: [parent],
      clamp: CLAMP,
    });
    const rect = at(p.left, p.top, panel.w, panel.h);
    assert.ok(!overlaps(rect, parent), '子面板压住了父面板：' + JSON.stringify(p));
    assert.equal(p.left, parent.right + 4, '右侧放得下时应贴父面板右侧');
  });

  test('二级：右侧放不下 → 翻到父面板左侧（不是触发项左侧）', () => {
    // 父面板紧贴右边界：右侧只剩 900-780-4 < 220
    const parent = box(560, 100, 220, 320);
    const item = { left: 560, right: 780, top: 120 };
    const p = pickPanelPosition({
      panel,
      item,
      parent: { left: parent.left, right: parent.right, top: parent.top },
      others: [parent],
      clamp: CLAMP,
    });
    const rect = at(p.left, p.top, panel.w, panel.h);
    assert.ok(!overlaps(rect, parent), '翻左后仍压住父面板：' + JSON.stringify(p));
    assert.equal(p.left, parent.left - 4 - panel.w, '应贴父面板左侧（旧实现贴的是触发项左侧）');
  });

  test('三级：右侧放不下时不得压到二级或一级', () => {
    // 一级在左、二级在它右边；三级右侧没地方，只能继续往左——但左边被二级/一级占着
    const l1 = box(0, 100, 220, 320);
    const l2 = box(224, 120, 220, 320);
    const item = { left: 224, right: 444, top: 140 };
    const p = pickPanelPosition({
      panel,
      item,
      parent: { left: l2.left, right: l2.right, top: l2.top },
      others: [l1, l2],
      clamp: CLAMP,
    });
    const rect = at(p.left, p.top, panel.w, panel.h);
    assert.ok(!overlaps(rect, l1), '三级压住了一级：' + JSON.stringify(p));
    assert.ok(!overlaps(rect, l2), '三级压住了二级：' + JSON.stringify(p));
  });

  test('候选全被占用时，也优先选不重叠的位置（即使要脱离"紧贴父面板"）', () => {
    // 一级 + 二级把左右都堵住，三级只能落到下方对齐父面板顶的候选上
    const l1 = box(0, 0, 220, 520);
    const l2 = box(224, 0, 220, 520);
    const p = pickPanelPosition({
      panel: { w: 220, h: 200 },
      item: { left: 224, right: 444, top: 10 },
      parent: { left: l2.left, right: l2.right, top: l2.top },
      others: [l1, l2],
      clamp: CLAMP,
    });
    const rect = at(p.left, p.top, 220, 200);
    assert.ok(!overlaps(rect, l1) && !overlaps(rect, l2), '仍有重叠：' + JSON.stringify(p));
  });

  test('落点始终完整落在 clamp 内（含四个边界的极端父面板位置）', () => {
    const cases = [
      box(0, 0, 220, 320),
      box(680, 0, 220, 320),
      box(0, 200, 220, 320),
      box(680, 200, 220, 320),
      box(340, 100, 220, 320),
    ];
    for (const parent of cases) {
      const p = pickPanelPosition({
        panel: { w: 220, h: 200 },
        item: { left: parent.left, right: parent.right, top: parent.top + 10 },
        parent: { left: parent.left, right: parent.right, top: parent.top },
        others: [parent],
        clamp: CLAMP,
      });
      assert.ok(p.left >= CLAMP.x + 4 - 0.5, 'left 越界：' + JSON.stringify({ p, parent }));
      assert.ok(p.left + 220 <= CLAMP.x + CLAMP.w - 4 + 0.5, 'right 越界：' + JSON.stringify({ p, parent }));
      assert.ok(p.top >= CLAMP.y + 4 - 0.5, 'top 越界：' + JSON.stringify({ p, parent }));
      assert.ok(p.top + 200 <= CLAMP.y + CLAMP.h - 4 + 0.5, 'bottom 越界：' + JSON.stringify({ p, parent }));
    }
  });

  test('窗口很窄（任何位置都会重叠）时退化为夹取，而不是返回越界坐标', () => {
    const narrow = { x: 0, y: 0, w: 260, h: 200 };
    const parent = box(0, 0, 220, 180);
    const p = pickPanelPosition({
      panel: { w: 220, h: 120 },
      item: { left: 0, right: 220, top: 10 },
      parent: { left: 0, right: 220, top: 0 },
      others: [parent],
      clamp: narrow,
    });
    assert.ok(p.left >= narrow.x + 4 - 0.5 && p.left + 220 <= narrow.x + narrow.w - 4 + 0.5);
    assert.ok(p.top >= narrow.y + 4 - 0.5 && p.top + 120 <= narrow.y + narrow.h - 4 + 0.5);
  });

  test('没有其它面板时行为与旧实现一致（右侧展开、顶对齐触发项）', () => {
    const p = pickPanelPosition({
      panel: { w: 220, h: 320 },
      item: { left: 100, right: 320, top: 150 },
      parent: { left: 100, right: 320, top: 100 },
      others: [],
      clamp: CLAMP,
    });
    assert.deepEqual(p, { left: 324, top: 150 });
  });
});
