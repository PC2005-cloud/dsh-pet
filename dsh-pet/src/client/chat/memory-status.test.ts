import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeMemoryStatus } from './memory-status.ts';

test('delivery counts do not claim extracted or recalled memories', () => {
  const text = describeMemoryStatus({ backend: 'powercontext', captured: 12, pending: 2, recall: 'not_run' });
  assert.match(text, /已同步 12 轮/);
  assert.match(text, /待同步 2/);
  assert.match(text, /尚未检索/);
  assert.doesNotMatch(text, /已记住|已整理|已召回/);
});

test('unavailable recall explicitly explains recent-history fallback', () => {
  assert.match(
    describeMemoryStatus({ backend: 'powercontext', captured: 1, pending: 0, recall: 'unavailable' }),
    /聊天使用近期对话/,
  );
  assert.match(describeMemoryStatus({ backend: 'native', captured: 1, pending: 0, recall: 'ready' }), /长期记忆未开启/);
  assert.doesNotMatch(
    describeMemoryStatus({ backend: 'powercontext', captured: 1, pending: 0, recall: 'unavailable', error: 'timeout' }),
    /同步异常/,
  );
});
