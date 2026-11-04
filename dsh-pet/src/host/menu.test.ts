/**
 * 第三方菜单注册表：placement 的校验、整体覆盖与快照。
 *
 * placement 是 owner 级设置，与 target 一起被每次注册整体覆盖；缺省必须是 'more'，
 * 保证老调用方（只传 owner + labels）行为一字不变。
 * 跑法：node --experimental-strip-types --test src/host/menu.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MenuRegistry } from './menu.ts';

describe('MenuRegistry —— placement', () => {
  test('不传 placement = more（老调用方零改动）', () => {
    const registry = new MenuRegistry();
    assert.deepEqual(registry.register({ owner: '小游戏', labels: ['弹弓'] }), { ok: true });
    assert.deepEqual(registry.snapshot(), [{ owner: '小游戏', label: '弹弓', target: 'both', placement: 'more' }]);
  });

  test('top / more 分别写进快照，顺序 = 注册顺序', () => {
    const registry = new MenuRegistry();
    assert.deepEqual(registry.register({ owner: '桥', labels: ['今日积分', '查积分'], placement: 'top' }), {
      ok: true,
    });
    assert.deepEqual(registry.register({ owner: '小游戏', labels: ['弹弓'], placement: 'more' }), { ok: true });
    assert.deepEqual(registry.snapshot(), [
      { owner: '桥', label: '今日积分', target: 'both', placement: 'top' },
      { owner: '桥', label: '查积分', target: 'both', placement: 'top' },
      { owner: '小游戏', label: '弹弓', target: 'both', placement: 'more' },
    ]);
  });

  test('非法 placement 回 invalid-placement，且不写入注册表', () => {
    const registry = new MenuRegistry();
    const result = registry.register({ owner: '桥', labels: ['A'], placement: 'TOP' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid-placement');
    assert.deepEqual(registry.snapshot(), []);
  });

  test('整体覆盖：再次注册不带 placement 会退回 more', () => {
    const registry = new MenuRegistry();
    registry.register({ owner: '桥', labels: ['A'], placement: 'top' });
    assert.deepEqual(registry.register({ owner: '桥', labels: ['B'] }), { ok: true });
    assert.deepEqual(registry.snapshot(), [{ owner: '桥', label: 'B', target: 'both', placement: 'more' }]);
  });

  test('clear 之后快照为空（placement 不留残状态）', () => {
    const registry = new MenuRegistry();
    registry.register({ owner: '桥', labels: ['A'], placement: 'top' });
    assert.deepEqual(registry.clear('桥'), { ok: true, removed: 1 });
    assert.deepEqual(registry.snapshot(), []);
  });
});
