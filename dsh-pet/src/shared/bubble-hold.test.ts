/**
 * 气泡收起状态机的行为契约（src/shared/bubble-hold.ts）。
 *
 * 覆盖挂起、收尾、迟到的上一句与未点亮时的忽略分支；计时器本身由两端各自验收。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUBBLE_HOLD_IDLE,
  BUBBLE_HOLD_MAX_MS,
  BUBBLE_HOLD_TAIL_MS,
  reduceBubbleHold,
  type BubbleHoldState,
} from './bubble-hold.ts';

/** 点亮后的状态，作为多数用例的起点。 */
function shown(durationMs = 10_000): BubbleHoldState {
  return reduceBubbleHold(BUBBLE_HOLD_IDLE, { durationMs, kind: 'show' });
}

describe('reduceBubbleHold —— 点亮与收起', () => {
  test('show：点亮并按给定时长计时', () => {
    assert.deepEqual(shown(), { delayMs: 10_000, holdSeq: null, on: true });
  });

  test('show 的时长非法：夹到 0 而不是负数', () => {
    assert.equal(shown(-5).delayMs, 0);
  });

  test('hide：点着就收，并且不再计时', () => {
    assert.equal(reduceBubbleHold(shown(), { kind: 'hide' }), BUBBLE_HOLD_IDLE);
  });

  test('hide 对着没点亮的状态：原样返回同一引用', () => {
    assert.equal(reduceBubbleHold(BUBBLE_HOLD_IDLE, { kind: 'hide' }), BUBBLE_HOLD_IDLE);
  });

  test('clear：无论此前在等什么，一律回到初值', () => {
    const held = reduceBubbleHold(shown(), { kind: 'hold', seq: 1 });
    assert.equal(reduceBubbleHold(held, { kind: 'clear' }), BUBBLE_HOLD_IDLE);
  });
});

describe('reduceBubbleHold —— 跟着语音挂起与收尾', () => {
  test('hold：挂起计时，改等上限', () => {
    assert.deepEqual(reduceBubbleHold(shown(), { kind: 'hold', seq: 1 }), {
      delayMs: BUBBLE_HOLD_MAX_MS,
      holdSeq: 1,
      on: true,
    });
  });

  test('hold：同一句重复通知不重置上限', () => {
    const held = reduceBubbleHold(shown(), { kind: 'hold', seq: 1 });
    assert.equal(reduceBubbleHold(held, { kind: 'hold', seq: 1 }), held);
  });

  test('release：这句播完，改成留尾巴', () => {
    const held = reduceBubbleHold(shown(), { kind: 'hold', seq: 1 });
    assert.deepEqual(reduceBubbleHold(held, { kind: 'release', seq: 1 }), {
      delayMs: BUBBLE_HOLD_TAIL_MS,
      holdSeq: null,
      on: true,
    });
  });

  test('release：上一句迟到的收尾（序号不符）不生效', () => {
    const held = reduceBubbleHold(shown(), { kind: 'hold', seq: 2 });
    assert.equal(reduceBubbleHold(held, { kind: 'release', seq: 1 }), held);
  });

  test('没点亮时的 hold / release：忽略，绝不凭空点亮气泡', () => {
    assert.equal(reduceBubbleHold(BUBBLE_HOLD_IDLE, { kind: 'hold', seq: 1 }), BUBBLE_HOLD_IDLE);
    assert.equal(reduceBubbleHold(BUBBLE_HOLD_IDLE, { kind: 'release', seq: 1 }), BUBBLE_HOLD_IDLE);
  });

  test('show 会清掉上一句的挂起：新气泡重新按自己的时长计时', () => {
    const held = reduceBubbleHold(shown(), { kind: 'hold', seq: 1 });
    assert.deepEqual(reduceBubbleHold(held, { durationMs: 3_000, kind: 'show' }), {
      delayMs: 3_000,
      holdSeq: null,
      on: true,
    });
  });
});
