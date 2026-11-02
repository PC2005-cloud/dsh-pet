import assert from 'node:assert/strict';
import { test } from 'node:test';

import { automaticWhisperSchedule } from './whisper-policy.ts';

test('DSH scheduling preserves existing pet flag and configured cadence', () => {
  assert.deepEqual(automaticWhisperSchedule(undefined, true, 125), { enabled: true, periodSec: 125 });
  assert.deepEqual(automaticWhisperSchedule(undefined, false, 125), { enabled: false, periodSec: 125 });
});

test('standalone scheduling additionally requires AI readiness, and keeps the configured cadence', () => {
  const policy = { isReady: () => true };
  assert.deepEqual(automaticWhisperSchedule(policy, true, 300), { enabled: true, periodSec: 300 });
  assert.equal(automaticWhisperSchedule(policy, false, 300).enabled, false, '宠物自己关掉时不得启用');
  assert.equal(
    automaticWhisperSchedule({ isReady: () => false }, true, 300).enabled,
    false,
    '独立模式 AI 未就绪时不得启用',
  );
});

test('configured cadence flows through unchanged under a standalone policy', () => {
  const policy = { isReady: () => true };
  assert.equal(automaticWhisperSchedule(policy, true, 61).periodSec, 61);
  assert.equal(automaticWhisperSchedule(policy, true, 7200).periodSec, 7200);
});
