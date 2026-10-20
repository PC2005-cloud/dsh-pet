/**
 * 桌面端实况快照（src/host/pose.ts）的单测 —— issue #122 第 1 条。
 *
 * 契约：
 *   1. 入参收窄：**非有限数字**（NaN / Infinity / 字符串）与**非法朝向**一律 `bad-request`；
 *   2. **越界坐标照收**：实况是"报什么就是什么"，不做夹取（宠物贴边时中心点本来就可能略出界）；
 *   3. 快照后写覆盖，同一只宠物只有一份，`updatedAt` 来自可注入的时钟。
 *
 * 用 Node 内置 test runner，不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PoseStore, normalizePoseInput } from './pose.ts';

describe('normalizePoseInput —— 上报原值收窄', () => {
  test('合法 → 原样收窄', () => {
    assert.deepEqual(normalizePoseInput({ x: 0.25, y: 1, facing: 'right' }), {
      ok: true,
      pose: { x: 0.25, y: 1, facing: 'right' },
    });
  });

  test('越界坐标照收（不夹取：实况要能对得上眼睛）', () => {
    for (const x of [-0.03, 1.02]) {
      const r = normalizePoseInput({ x, y: 0.5, facing: 'left' });
      assert.equal(r.ok, true, 'x=' + x + ' 应通过');
      assert.equal(r.ok === true && r.pose.x, x);
    }
  });

  test('非对象 / 缺字段 / 非有限数字 / 非法朝向 → bad-request', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'x',
      [],
      { y: 0.5, facing: 'left' }, // 缺 x
      { x: 0.5, facing: 'left' }, // 缺 y
      { x: NaN, y: 0.5, facing: 'left' },
      { x: Infinity, y: 0.5, facing: 'left' },
      { x: '0.5', y: 0.5, facing: 'left' },
      { x: 0.5, y: 0.5 }, // 缺 facing
      { x: 0.5, y: 0.5, facing: 'RIGHT' },
      { x: 0.5, y: 0.5, facing: 'up' },
    ];
    for (const raw of bad) {
      const r = normalizePoseInput(raw);
      assert.equal(r.ok, false, JSON.stringify(raw) + ' 不应通过');
      assert.equal(r.ok === false && r.reason, 'bad-request');
    }
  });
});

describe('PoseStore —— 快照覆盖', () => {
  test('从没有 → undefined；set 后可读，updatedAt 来自注入的时钟', () => {
    let now = 1000;
    const store = new PoseStore({ now: () => now });
    assert.equal(store.get('main'), undefined);
    assert.deepEqual(store.set('main', { x: 0.4, y: 0.6, facing: 'left' }), {
      x: 0.4,
      y: 0.6,
      facing: 'left',
      updatedAt: 1000,
    });
    now = 2000;
    store.set('main', { x: 0.1, y: 0.2, facing: 'right' });
    assert.deepEqual(store.get('main'), { x: 0.1, y: 0.2, facing: 'right', updatedAt: 2000 }, '后写覆盖');
    assert.equal(store.count(), 1, '同一只宠物只有一份');
  });

  test('多只宠物互不干扰', () => {
    const store = new PoseStore({ now: () => 1 });
    store.set('a', { x: 0, y: 0, facing: 'left' });
    store.set('b', { x: 1, y: 1, facing: 'right' });
    assert.equal(store.count(), 2);
    assert.equal(store.get('a')?.facing, 'left');
    assert.equal(store.get('b')?.facing, 'right');
  });
});
