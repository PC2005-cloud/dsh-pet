/**
 * 回车处理判定的契约测试：哪次回车发送、哪次只拦默认行为、哪次完全不碰。
 * 跑法：node --experimental-strip-types --test src/shared/chat/enter.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPOSITION_SETTLE_MS, createCompositionWatch, decideEnter } from './enter.ts';
import type { EnterKeyEvent } from './enter.ts';

/** 造一次按键；只填判定关心的字段。 */
function key(overrides: Partial<EnterKeyEvent> = {}): EnterKeyEvent {
  return { key: 'Enter', shiftKey: false, ...overrides };
}

describe('decideEnter', () => {
  test('普通回车 → 发送', () => {
    assert.equal(decideEnter(key(), createCompositionWatch(), 0), 'send');
  });

  test('Shift+回车 → 不干预（留给换行）', () => {
    assert.equal(decideEnter(key({ shiftKey: true }), createCompositionWatch(), 0), 'ignore');
  });

  test('组合中的回车（isComposing） → 不干预（交给输入法上屏）', () => {
    assert.equal(decideEnter(key({ isComposing: true }), createCompositionWatch(), 0), 'ignore');
  });

  test('keyCode 229（输入法吞键） → 不干预', () => {
    assert.equal(decideEnter(key({ keyCode: 229 }), createCompositionWatch(), 0), 'ignore');
  });

  test('组合还没结束（watch 在组合中） → 不干预', () => {
    const watch = createCompositionWatch();
    watch.start();
    assert.equal(decideEnter(key(), watch, 0), 'ignore');
  });

  test('组合中的长按重复回车 → 仍然不干预（归输入法）', () => {
    const watch = createCompositionWatch();
    watch.start();
    assert.equal(decideEnter(key({ isComposing: true, repeat: true }), watch, 0), 'ignore');
  });

  test('长按产生的重复回车 → 拦下但不发（否则一直换行）', () => {
    assert.equal(decideEnter(key({ repeat: true }), createCompositionWatch(), 0), 'swallow');
  });

  test('组合刚结束：静默窗内只拦下，出了窗就发送', () => {
    const watch = createCompositionWatch();
    watch.start();
    watch.end(1000);
    assert.equal(decideEnter(key(), watch, 1000), 'swallow', '上屏那一下不该当发送，也别插空行');
    assert.equal(decideEnter(key(), watch, 1000 + COMPOSITION_SETTLE_MS - 1), 'swallow', '窗内仍拦下');
    assert.equal(decideEnter(key(), watch, 1000 + COMPOSITION_SETTLE_MS), 'send', '出了静默窗恢复正常发送');
  });

  test('非回车键 → 不干预', () => {
    assert.equal(decideEnter(key({ key: 'a' }), createCompositionWatch(), 0), 'ignore');
  });
});

describe('createCompositionWatch', () => {
  test('start / end 维护组合态与结束时刻', () => {
    const watch = createCompositionWatch();
    assert.equal(watch.isComposing(), false, '初始不在组合中');
    watch.start();
    assert.equal(watch.isComposing(), true);
    watch.end(500);
    assert.equal(watch.isComposing(), false);
    assert.equal(watch.endedWithin(500), true);
  });

  test('从未结束过组合 → 永远不在静默窗内', () => {
    const watch = createCompositionWatch();
    assert.equal(watch.endedWithin(0), false);
    assert.equal(watch.endedWithin(Number.MAX_SAFE_INTEGER), false);
  });
});
