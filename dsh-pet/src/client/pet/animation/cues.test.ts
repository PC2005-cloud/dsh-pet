/**
 * 播完判定（src/client/pet/animation/cues.ts）的契约测试。
 *
 * 三条契约：事件动画播完只回事件链，绝不进随机链；档位动画在非终态下轮换或续播，
 * 终态与空闲则回事件结束；转向、拖拽、点击各自回自己的分支，其余才走随机链。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { decideEndedCue } from './cues.ts';
import type { Animations } from '../../../shared/types.ts';

const animations = {
  idle: ['idle1'],
  turn: ['turn1'],
  drag: ['drag1'],
  clicks: ['click1'],
  moves: { default: {}, actions: [] },
  categories: [],
  events: {
    // 两候选档位：播完要轮换；单候选：续播。
    workStatus: [['ws-run-a', 'ws-run-b'], 'ws-error'],
    balance: ['bal1'],
  },
} as unknown as Animations;

describe('decideEndedCue —— 播完之后进哪条分支', () => {
  test('普通自播动画播完：走随机链', () => {
    assert.deepEqual(decideEndedCue({ animations, current: 'idle1', workState: null }), { kind: 'random' });
  });

  test('转向动画播完：回 turn 分支（组件翻转朝向）', () => {
    assert.deepEqual(decideEndedCue({ animations, current: 'turn1', workState: null }), { kind: 'turn' });
  });

  test('拖拽与点击动画播完：回互动结束分支', () => {
    assert.deepEqual(decideEndedCue({ animations, current: 'drag1', workState: null }), {
      kind: 'interaction-done',
    });
    assert.deepEqual(decideEndedCue({ animations, current: 'click1', workState: null }), {
      kind: 'interaction-done',
    });
  });

  test('晕眩动画播完：回互动结束分支', () => {
    const withDizzy = { ...animations, dizzy: ['dizzy1'] } as Animations;
    assert.deepEqual(decideEndedCue({ animations: withDizzy, current: 'dizzy1', workState: null }), {
      kind: 'interaction-done',
    });
  });

  test('档位动画 + 非终态 + 多候选：轮换到下一候选', () => {
    const cue = decideEndedCue({ animations, current: 'ws-run-a', workState: 'working' });
    assert.equal(cue.kind, 'work-rotate');
    assert.equal(cue.kind === 'work-rotate' ? cue.anim : '', 'ws-run-b', '轮换要避开当前这一段');
  });

  test('档位动画 + 非终态 + 单候选：续播同一段', () => {
    assert.deepEqual(decideEndedCue({ animations, current: 'ws-error', workState: 'error' }), {
      kind: 'event-done',
    });
    // ws-error 位于单候选档位，但工作状态是终态 error → 回事件结束而不是续播。
    assert.deepEqual(decideEndedCue({ animations, current: 'ws-error', workState: null }), { kind: 'event-done' });
  });

  test('事件动画播完（非档位）：回事件结束，不进随机链', () => {
    assert.deepEqual(decideEndedCue({ animations, current: 'bal1', workState: null }), { kind: 'event-done' });
  });

  test('工作状态为终态或空闲：不轮换、不续播', () => {
    for (const state of [null, undefined, 'success', 'error']) {
      const cue = decideEndedCue({ animations, current: 'ws-run-a', workState: state });
      assert.deepEqual(cue, { kind: 'event-done' }, `state=${String(state)} 应回事件结束`);
    }
  });
});
