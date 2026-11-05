/**
 * 菜单放行判定的单元测试：睡着时哪些菜单动作还能用。
 *
 * 这份判定被浏览器与桌面两端共用（桌面经 shared-core 拿到同一份），所以钉在这里，
 * 免得一端改了另一端跟着漂移。
 * 跑法：node --experimental-strip-types --test src/shared/menu/tree.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isSleepAllowedAction, buildMenuTree, buildMoreBranch, displayMenuBranch } from './tree.ts';
import type { Animations } from '../types.ts';

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

const animations = {
  idle: ['待机呼吸休闲'],
  turn: [],
  drag: [],
  clicks: [],
  moves: { default: {}, actions: [{ name: '没有这句' }] },
  categories: [{ id: '文字', weight: 1, actions: ['是啊，吃什么'] }],
  events: { balance: ['余额-钱袋满溢'], custom: ['自定义事件'] },
} as Animations;

describe('菜单文案 —— 只有 ru 换成俄语，id 不动', () => {
  test('ru：分类与动作是俄语，anim 仍是原来的名字；没有译文就显示 id', () => {
    const tree = buildMenuTree(animations, 'ru');
    const action = tree[0];
    assert.ok(action && 'children' in action);
    assert.equal(action.label, 'Действия');
    const labels = new Map(action.children.map((node) => [node.label, node]));
    const idle = labels.get('Ожидание');
    assert.ok(idle && 'children' in idle);
    const idleLeaf = idle.children[0];
    assert.ok(idleLeaf && !('children' in idleLeaf));
    assert.equal(idleLeaf.label, 'Спокойное дыхание');
    assert.equal(idleLeaf.anim, '待机呼吸休闲');
    const moves = labels.get('Ходьба');
    assert.ok(moves && 'children' in moves);
    const unknown = moves.children[0];
    assert.ok(unknown && !('children' in unknown));
    assert.equal(unknown.label, '没有这句');
    assert.equal(unknown.anim, '没有这句');
    const category = labels.get('Текст');
    assert.ok(category && 'children' in category);
    const named = category.children[0];
    assert.ok(named && !('children' in named));
    assert.equal(named.anim, '是啊，吃什么');
    assert.equal(labels.get('Баланс') !== undefined, true);
    assert.equal(labels.get('custom') !== undefined, true);
  });

  test('其它语言保持中文', () => {
    for (const id of [undefined, '', 'en', 'zh']) {
      const tree = buildMenuTree(animations, id);
      assert.equal(tree[0]?.label, '动作');
    }
    const display = displayMenuBranch('ru');
    assert.equal(display.label, 'Где показывать');
    const leaf = display.children[0];
    assert.ok(leaf && !('children' in leaf));
    assert.equal(leaf.action, 'set-display');
    assert.equal(displayMenuBranch().label, '显示位置');
  });

  test('第三方写的标题不改，只有「更多」随语言变', () => {
    const items = [{ owner: '插件', label: '原样标题' }];
    const ru = buildMoreBranch(items, 'ru');
    const zh = buildMoreBranch(items);
    assert.equal(ru?.label, 'Ещё');
    assert.equal(zh?.label, '更多');
    const leaf = ru?.children[0];
    assert.ok(leaf && !('children' in leaf));
    assert.equal(leaf.label, '原样标题');
    assert.equal(leaf.action, 'third-party');
  });
});
