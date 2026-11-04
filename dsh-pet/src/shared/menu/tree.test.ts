/**
 * 菜单放行判定与第三方菜单层级的单元测试。
 *
 * 这份判定被浏览器与桌面两端共用（桌面经 shared-core 拿到同一份），所以钉在这里，
 * 免得一端改了另一端跟着漂移。
 * 跑法：node --experimental-strip-types --test src/shared/menu/tree.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildMoreBranch, buildTopLevelItems, isSleepAllowedAction, readMenuItems } from './tree.ts';

describe('isSleepAllowedAction —— 睡着时仍然放行的动作', () => {
  test('睡觉 / 起来 / 维护类 / 第三方菜单项放行', () => {
    for (const action of ['sleep', 'wake', 'home', 'set-display', 'reload', 'third-party']) {
      assert.equal(isSleepAllowedAction(action), true, action + ' 应放行');
    }
  });

  test('打扰类一律不放行（对话 / 碎碎念 / 余额 / 待办 / 动作点播）', () => {
    for (const action of ['chat', 'whisper', 'show-balance', 'todo']) {
      assert.equal(isSleepAllowedAction(action), false, action + ' 应被拒');
    }
    // 点播动画的叶子只有 anim、没有 action
    assert.equal(isSleepAllowedAction(undefined), false);
  });
});

describe('placement —— 第三方菜单项平铺到一级', () => {
  const data = {
    items: [
      { owner: '状态桥', label: '今日积分', target: 'both', placement: 'top' },
      { owner: '状态桥', label: '查积分', target: 'both', placement: 'top' },
      { owner: '小游戏', label: '弹弓', target: 'both', placement: 'more' },
      { owner: '小游戏', label: '钓鱼', target: 'both' },
    ],
  };

  test('readMenuItems 只认合法的 top，其余按 more', () => {
    assert.deepEqual(readMenuItems(data, 'desktop'), [
      { owner: '状态桥', label: '今日积分', placement: 'top' },
      { owner: '状态桥', label: '查积分', placement: 'top' },
      { owner: '小游戏', label: '弹弓' },
      { owner: '小游戏', label: '钓鱼' },
    ]);
  });

  test('buildTopLevelItems 按快照顺序平铺成 third-party 叶子', () => {
    assert.deepEqual(buildTopLevelItems(readMenuItems(data, 'web')), [
      { label: '今日积分', action: 'third-party', owner: '状态桥' },
      { label: '查积分', action: 'third-party', owner: '状态桥' },
    ]);
  });

  test('buildMoreBranch 跳过 top 项，其余照旧按 owner 分组', () => {
    assert.deepEqual(buildMoreBranch(readMenuItems(data, 'web')), {
      label: '更多',
      children: [
        {
          label: '小游戏',
          children: [
            { label: '弹弓', action: 'third-party', owner: '小游戏' },
            { label: '钓鱼', action: 'third-party', owner: '小游戏' },
          ],
        },
      ],
    });
  });

  test('老宿主快照（无 placement 字段）行为完全不变', () => {
    const legacy = { items: [{ owner: '小游戏', label: '弹弓' }] };
    const items = readMenuItems(legacy, 'desktop');
    assert.deepEqual(buildTopLevelItems(items), []);
    assert.deepEqual(buildMoreBranch(items), {
      label: '更多',
      children: [{ label: '弹弓', action: 'third-party', owner: '小游戏' }],
    });
  });

  test('placement 写坏的值按 more 处理，坏数据不搞崩菜单', () => {
    const bad = {
      items: [
        { owner: '桥', label: 'A', placement: 'TOP' },
        { owner: '桥', label: 'B', placement: 1 },
        { owner: '桥', label: 'C', placement: null },
      ],
    };
    const items = readMenuItems(bad, 'web');
    assert.deepEqual(buildTopLevelItems(items), []);
    assert.equal(buildMoreBranch(items)?.children.length, 1);
  });

  test('target 过滤对 top 项同样生效', () => {
    const onlyWeb = { items: [{ owner: '桥', label: '今日积分', target: 'web', placement: 'top' }] };
    assert.deepEqual(readMenuItems(onlyWeb, 'desktop'), []);
    assert.deepEqual(buildTopLevelItems(readMenuItems(onlyWeb, 'web')), [
      { label: '今日积分', action: 'third-party', owner: '桥' },
    ]);
  });

  test('全是 top 项时「更多」不出现', () => {
    const allTop = {
      items: [
        { owner: '桥', label: 'A', placement: 'top' },
        { owner: '桥', label: 'B', placement: 'top' },
      ],
    };
    const items = readMenuItems(allTop, 'web');
    assert.equal(buildTopLevelItems(items).length, 2);
    assert.equal(buildMoreBranch(items), null);
  });
});
