/**
 * 跳会话信号的解析边界：判重水位与重放窗口。
 *
 * 这两条错了的表现都很隐蔽——重复跳会让页面来回切会话，窗口太大则打开页面时被硬拽走。
 * 跑法：node --experimental-strip-types --test src/shared/focus-session.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FOCUS_REPLAY_WINDOW_MS, readFocusSession } from './focus-session.ts';

describe('readFocusSession —— 该不该跳', () => {
  test('新信号 → 给出会话与时刻', () => {
    assert.deepEqual(readFocusSession({ sessionId: 's1', ts: 1000 }, 1000, 0), { sessionId: 's1', ts: 1000 });
  });

  test('与水位相同或更旧 → null（首拉补跳后那一拍增量不再跳一次）', () => {
    assert.equal(readFocusSession({ sessionId: 's1', ts: 1000 }, 1000, 1000), null);
    assert.equal(readFocusSession({ sessionId: 's1', ts: 999 }, 1000, 1000), null);
  });

  test('超过重放窗口 → null（打开页面时不该被很久以前的一次点击拽走）', () => {
    const stale = FOCUS_REPLAY_WINDOW_MS + 1;
    assert.equal(readFocusSession({ sessionId: 's1', ts: 1000 }, 1000 + stale, 0), null);
    assert.deepEqual(readFocusSession({ sessionId: 's1', ts: 1000 }, 1000 + FOCUS_REPLAY_WINDOW_MS, 0), {
      sessionId: 's1',
      ts: 1000,
    });
  });

  test('形状非法 → null（空 id / 非字符串 / 缺 ts / 非有限数 / 非对象）', () => {
    for (const raw of [
      null,
      undefined,
      'x',
      {},
      { sessionId: '' },
      { sessionId: 42 },
      { sessionId: 's1' },
      { sessionId: 's1', ts: '1000' },
      { sessionId: 's1', ts: Number.NaN },
      { sessionId: 's1', ts: Number.POSITIVE_INFINITY },
    ]) {
      assert.equal(readFocusSession(raw, 1000, 0), null);
    }
  });
});
