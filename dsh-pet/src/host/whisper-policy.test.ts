import assert from 'node:assert/strict';
import { test } from 'node:test';

import { automaticWhisperSchedule } from './whisper-policy.ts';

test('DSH scheduling preserves existing pet flag and configured cadence', () => {
  assert.deepEqual(automaticWhisperSchedule(undefined, true, 125), { enabled: true, periodSec: 125 });
  assert.deepEqual(automaticWhisperSchedule(undefined, false, 125), { enabled: false, periodSec: 125 });
});

test('standalone scheduling requires readiness, explicit automatic opt-in and pet opt-in', () => {
  const policy = { isReady: () => true, canWhisper: () => true, whisperIntervalSec: () => 90 };
  assert.deepEqual(automaticWhisperSchedule(policy, true, 300), { enabled: true, periodSec: 90 });
  assert.equal(automaticWhisperSchedule(policy, false, 300).enabled, false);
  assert.equal(automaticWhisperSchedule({ ...policy, isReady: () => false }, true, 300).enabled, false);
  assert.equal(automaticWhisperSchedule({ ...policy, canWhisper: () => false }, true, 300).enabled, false);
});

test('standalone period cannot cause a rapid request loop even when policy is malformed', () => {
  const policy = { isReady: () => true, canWhisper: () => true, whisperIntervalSec: () => 0 };
  assert.equal(automaticWhisperSchedule(policy, true, 300).periodSec, 60);
  assert.equal(automaticWhisperSchedule({ ...policy, whisperIntervalSec: () => NaN }, true, 300).periodSec, 300);
});
