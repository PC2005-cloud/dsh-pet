/**
 * 识别契约的纯校验测试（src/host/voice/speech-types.ts）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SPEECH_TIMEOUT_MS, SpeechUnavailableError, validateSpeechProvider } from './speech-types.ts';

/** 造一个最小合法定义；只覆盖必填字段，可选字段由各用例自己加。 */
const minimal = (extra: Record<string, unknown> = {}) => ({
  id: 'demo',
  name: '演示',
  transcribe: async () => '好',
  ...extra,
});

test('validateSpeechProvider —— 最小定义通过，可选字段缺省', () => {
  assert.doesNotThrow(() => validateSpeechProvider(minimal()));
});

test('validateSpeechProvider —— timeoutMs 合法值通过', () => {
  assert.doesNotThrow(() => validateSpeechProvider(minimal({ timeoutMs: 1000 })));
});

test('validateSpeechProvider —— id 必须是 kebab-case', () => {
  for (const id of ['', 'Demo', 'de mo', 'demo/x', 1, undefined]) {
    assert.throws(() => validateSpeechProvider(minimal({ id })), TypeError, `id=${JSON.stringify(id)} 应被拒绝`);
  }
});

test('validateSpeechProvider —— name 与 transcribe 必填', () => {
  assert.throws(() => validateSpeechProvider(minimal({ name: '   ' })), TypeError, '空白 name');
  assert.throws(() => validateSpeechProvider(minimal({ transcribe: undefined })), TypeError, 'transcribe 缺失');
  assert.throws(() => validateSpeechProvider(minimal({ transcribe: 1 })), TypeError, 'transcribe 非函数');
});

test('validateSpeechProvider —— timeoutMs 必须是正有限数', () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '30000']) {
    assert.throws(
      () => validateSpeechProvider(minimal({ timeoutMs })),
      TypeError,
      `timeoutMs=${String(timeoutMs)} 应被拒绝`,
    );
  }
});

test('validateSpeechProvider —— 非对象一律拒绝', () => {
  for (const value of [null, undefined, 1, 'x', []]) {
    assert.throws(() => validateSpeechProvider(value), TypeError, `${JSON.stringify(value)} 应被拒绝`);
  }
});

test('SpeechUnavailableError —— 有稳定 name，能被 instanceof 认出', () => {
  const error = new SpeechUnavailableError('host has no speech-to-text service');
  assert.equal(error.name, 'SpeechUnavailableError');
  assert.equal(error instanceof SpeechUnavailableError, true);
  assert.equal(error instanceof Error, true);
});

test('DEFAULT_SPEECH_TIMEOUT_MS —— 是正数，供缺省使用', () => {
  assert.equal(Number.isFinite(DEFAULT_SPEECH_TIMEOUT_MS), true);
  assert.equal(DEFAULT_SPEECH_TIMEOUT_MS > 0, true);
});
