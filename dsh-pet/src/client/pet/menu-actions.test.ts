/**
 * 菜单动作派发（src/client/pet/menu-actions.ts）的契约测试。
 *
 * 四条契约：内置动作各走各的端点和回调；点播移动动画优先走真实位移，挪不动才退化成纯播放；
 * 文字类动画点播前强制朝左（keepFacing 时跳过）；移动系统接管点播时如实回 failed/busy。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createMenuActions, type MenuActionDeps } from './menu-actions.ts';
import type { MenuLeaf } from '../../shared/menu.ts';
import type { Animations } from '../../shared/types.ts';

const animations = {
  idle: ['idle1'],
  turn: [],
  drag: [],
  clicks: [],
  moves: { default: {}, actions: [{ name: 'walk1' }] },
  // noMirror: true 的分类：朝右站姿是镜像的，点播前要强制朝左。
  categories: [{ id: 'text', weight: 1, noMirror: true, actions: ['say1'] }],
  events: {},
} as unknown as Animations;

/** 造一套记录调用的依赖。 */
function harness(overrides: Partial<MenuActionDeps> = {}) {
  const calls: string[] = [];
  const deps: MenuActionDeps = {
    petId: 'pet-1',
    animations: () => animations,
    isFacingRight: () => true,
    faceLeft: () => calls.push('faceLeft'),
    tryMove: () => 'walk1',
    stopMove: () => calls.push('stopMove'),
    stopThrow: () => calls.push('stopThrow'),
    playOnce: (anim, playbackId) => calls.push(`playOnce:${anim}:${playbackId ?? 'null'}`),
    resetPosition: () => calls.push('resetPosition'),
    openChat: () => calls.push('openChat'),
    openTodo: () => calls.push('openTodo'),
    report: (id, status, reason) => calls.push(`report:${id}:${status}:${reason}`),
    applyMerged: () => calls.push('applyMerged'),
    warn: (message) => calls.push('warn:' + message.slice(0, 20)),
    ...overrides,
  };
  return { actions: createMenuActions(deps), calls };
}

describe('createMenuActions —— 内置动作', () => {
  test('回到初始位置：先停飞行与走位再清位置', () => {
    const { actions, calls } = harness();
    actions.run({ label: '回到初始位置', action: 'home' } as MenuLeaf);
    assert.deepEqual(calls, ['stopThrow', 'stopMove', 'resetPosition']);
  });

  test('对话：交给 openChat', () => {
    const { actions, calls } = harness();
    actions.run({ label: '对话', action: 'chat' } as MenuLeaf);
    assert.deepEqual(calls, ['openChat']);
  });

  test('待办：交给 openTodo', () => {
    const { actions, calls } = harness();
    actions.run({ label: '待办事项', action: 'todo' } as MenuLeaf);
    assert.deepEqual(calls, ['openTodo']);
  });

  test('显示位置：没有 display 就什么都不做', () => {
    const { actions, calls } = harness();
    actions.run({ label: '显示位置', action: 'set-display' } as MenuLeaf);
    assert.deepEqual(calls, []);
  });
});

describe('createMenuActions —— 点播动画', () => {
  test('普通动画：停走位后纯播放，并把点播编号带上', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'idle1', anim: 'idle1' } as MenuLeaf, 'pb-1');
    assert.deepEqual(calls, ['stopMove', 'playOnce:idle1:pb-1']);
  });

  test('移动动画：走位接管，不换视频源；点播如实回 failed/busy', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf, 'pb-1');
    assert.deepEqual(calls, ['report:pb-1:failed:busy'], '走位在跑，这段点播不可能真的播起来');
  });

  test('移动动画 + 自播（无点播编号）：什么都不额外做', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf);
    assert.deepEqual(calls, []);
  });

  test('移动动画挪不动：退化成纯播放', () => {
    const { actions, calls } = harness({ tryMove: () => false });
    actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf);
    assert.deepEqual(calls, ['stopMove', 'playOnce:walk1:null']);
  });

  test('走位已被占用（返回 true）：同样如实回 failed/busy', () => {
    const busy = harness({ tryMove: () => true });
    busy.actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf, 'pb-2');
    assert.deepEqual(busy.calls, ['report:pb-2:failed:busy']);
  });

  test('文字类动画 + 朝右：点播前强制朝左', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'say1', anim: 'say1' } as MenuLeaf);
    assert.equal(calls[0], 'faceLeft');
    assert.equal(calls[1], 'stopMove');
  });

  test('keepFacing：显式朝向优先，不强制朝左', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'say1', anim: 'say1' } as MenuLeaf, undefined, true);
    assert.deepEqual(calls, ['stopMove', 'playOnce:say1:null']);
  });

  test('朝左时不需要再强制朝左', () => {
    const { actions, calls } = harness({ isFacingRight: () => false });
    actions.run({ label: 'say1', anim: 'say1' } as MenuLeaf);
    assert.deepEqual(calls, ['stopMove', 'playOnce:say1:null']);
  });
});
