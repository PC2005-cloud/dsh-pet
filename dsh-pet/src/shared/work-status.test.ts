/**
 * 工作状态演出滞回决策的单元测试（decideWorkTier）。
 *
 * 钉住的不变式（都是"后台工具密集调用时不闪"的直接前提）：
 *   - 空闲 → 任意：立刻起播（不能等）；
 *   - 任意 → 终态（success/error）：立刻接受（反馈不能迟到）；
 *   - 升档（优先级更高）：立刻插队；
 *   - 降档：候选必须**连续两拍**，且当前档已驻留 ≥ WORK_MIN_HOLD_MS，否则压住不换；
 *   - 同档位：永远 hold（旧实现每拍都把同一段从第 0 帧重播，是第一号闪烁源）。
 *
 * 跑法：node --experimental-strip-types --test src/shared/work-status.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideWorkTier,
  WORK_DEMOTE_TICKS,
  WORK_MIN_HOLD_MS,
  WORK_STATUS_PRIORITY,
  type WorkTierInput,
} from './work-status.ts';

const NOW = 10_000_000;

/** 造一条输入：默认"当前播 working、已驻留很久、候选 result 第一拍" */
function input(patch: Partial<WorkTierInput> = {}): WorkTierInput {
  return {
    shown: 'working',
    shownAt: NOW - 5000,
    candidate: 'result',
    candTicks: 1,
    now: NOW,
    ...patch,
  };
}

describe('decideWorkTier', () => {
  test('空闲 → 任意：立刻起播', () => {
    assert.equal(decideWorkTier(input({ shown: null, candidate: 'thinking' })), 'accept');
    assert.equal(decideWorkTier(input({ shown: null, candidate: 'result', candTicks: 1 })), 'accept');
  });

  test('任意 → 终态：立刻接受（不看驻留、不看拍数）', () => {
    assert.equal(decideWorkTier(input({ candidate: 'success', candTicks: 1, shownAt: NOW })), 'accept');
    assert.equal(decideWorkTier(input({ candidate: 'error', candTicks: 1, shownAt: NOW })), 'accept');
  });

  test('升档：立刻插队', () => {
    assert.equal(decideWorkTier(input({ candidate: 'waiting', candTicks: 1, shownAt: NOW })), 'accept');
    assert.equal(decideWorkTier(input({ shown: 'thinking', candidate: 'working', candTicks: 1 })), 'accept');
  });

  test('降档：候选只有一拍 → 压住不换（working↔result 的 1s 毛刺）', () => {
    assert.equal(decideWorkTier(input({ candTicks: 1 })), 'hold');
  });

  test('降档：候选连续 WORK_DEMOTE_TICKS 拍且已驻留够久 → 接受', () => {
    assert.equal(decideWorkTier(input({ candTicks: WORK_DEMOTE_TICKS })), 'accept');
  });

  test('降档：驻留不足 WORK_MIN_HOLD_MS → 即使连拍也不换', () => {
    assert.equal(
      decideWorkTier(input({ candTicks: WORK_DEMOTE_TICKS, shownAt: NOW - (WORK_MIN_HOLD_MS - 1) })),
      'hold',
    );
    assert.equal(decideWorkTier(input({ candTicks: WORK_DEMOTE_TICKS, shownAt: NOW - WORK_MIN_HOLD_MS })), 'accept');
  });

  test('同档位：永远 hold（等价于"不要重播当前片段"）', () => {
    assert.equal(decideWorkTier(input({ candidate: 'working', candTicks: 9 })), 'hold');
  });

  test('优先级表与 host 侧同口径（waiting > error > working > thinking > result > success）', () => {
    const order = (['waiting', 'error', 'working', 'thinking', 'result', 'success'] as const).map(
      (s) => WORK_STATUS_PRIORITY[s],
    );
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] > order[i], 'priority order broken');
  });
});
