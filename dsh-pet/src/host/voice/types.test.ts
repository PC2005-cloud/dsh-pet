/**
 * 语音契约的纯函数测试（src/host/voice/types.ts）。
 *
 * 只钉「限定 id 怎么切、注册定义什么算非法」——注册表行为另有 registry.test.ts。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  VOICE_ID_PATTERN,
  limitedVoiceId,
  splitVoiceId,
  validateVoiceProvider,
} from './types.ts';

/** 造一个最小合法定义；只覆盖必填字段，可选字段由各用例自己加。 */
const minimal = (extra: Record<string, unknown> = {}) => ({
  id: 'demo',
  name: '演示',
  voices: [{ id: 'v1', name: '音色一' }],
  synthesize: async () => new Uint8Array([1]),
  ...extra,
});

test('splitVoiceId —— 正常切分：首段是 provider，其余全部归音色', () => {
  assert.deepEqual(splitVoiceId('edge/zh-CN-XiaoyiNeural'), {
    providerId: 'edge',
    voiceId: 'zh-CN-XiaoyiNeural',
  });
});

test('splitVoiceId —— 缺分隔符、任一侧为空、含第二个分隔符都返回 undefined', () => {
  assert.equal(splitVoiceId('zh-CN-XiaoyiNeural'), undefined, '旧裸 id 不该被当成合法限定 id');
  assert.equal(splitVoiceId('/voice'), undefined, 'provider 段为空');
  assert.equal(splitVoiceId('edge/'), undefined, '音色段为空');
  assert.equal(splitVoiceId('edge/a/b'), undefined, '音色段含分隔符');
  assert.equal(splitVoiceId(''), undefined);
});

test('limitedVoiceId —— 与 splitVoiceId 互逆', () => {
  const id = limitedVoiceId('azure', 'zh-CN-YunxiNeural');
  assert.equal(id, 'azure/zh-CN-YunxiNeural');
  assert.deepEqual(splitVoiceId(id), { providerId: 'azure', voiceId: 'zh-CN-YunxiNeural' });
});

test('VOICE_ID_PATTERN —— 只有带 provider 前缀的形态算合法', () => {
  assert.equal(VOICE_ID_PATTERN.test('edge/zh-CN-XiaoyiNeural'), true);
  assert.equal(VOICE_ID_PATTERN.test('azure/zh-CN-YunxiNeural'), true);
  assert.equal(VOICE_ID_PATTERN.test('my-tts/voice_1'), true);
  assert.equal(VOICE_ID_PATTERN.test('zh-CN-XiaoyiNeural'), false, '裸音色 id 不再合法');
  assert.equal(VOICE_ID_PATTERN.test('edge/'), false);
  assert.equal(VOICE_ID_PATTERN.test('/zh-CN-XiaoyiNeural'), false);
  assert.equal(VOICE_ID_PATTERN.test('Edge/voice'), false, 'provider 段必须小写');
  assert.equal(VOICE_ID_PATTERN.test('edge/voice name'), false, '音色段不许含空白');
});

test('validateVoiceProvider —— 最小定义通过，可选字段全部缺省', () => {
  assert.doesNotThrow(() => validateVoiceProvider(minimal()));
});

test('validateVoiceProvider —— 可选字段合法值通过', () => {
  assert.doesNotThrow(() => validateVoiceProvider(minimal({ format: 'mp3', timeoutMs: 28_000 })));
  assert.doesNotThrow(() => validateVoiceProvider(minimal({ format: 'wav' })));
});

test('validateVoiceProvider —— id 必须是 kebab-case 且不含斜杠', () => {
  for (const id of ['', 'Edge', 'edge_x', 'ed ge', 'edge/x', 1, undefined]) {
    assert.throws(() => validateVoiceProvider(minimal({ id })), TypeError, `id=${JSON.stringify(id)} 应被拒绝`);
  }
});

test('validateVoiceProvider —— name 与 synthesize 必填', () => {
  assert.throws(() => validateVoiceProvider(minimal({ name: '   ' })), TypeError, '空白 name');
  assert.throws(() => validateVoiceProvider(minimal({ synthesize: undefined })), TypeError, 'synthesize 缺失');
  assert.throws(() => validateVoiceProvider(minimal({ synthesize: 1 })), TypeError, 'synthesize 非函数');
});

test('validateVoiceProvider —— format 只认 mp3 / wav', () => {
  for (const format of ['ogg', 'opus', 'MP3', '']) {
    assert.throws(() => validateVoiceProvider(minimal({ format })), TypeError, `format=${format} 应被拒绝`);
  }
});

test('validateVoiceProvider —— timeoutMs 必须是正有限数', () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '15000']) {
    assert.throws(
      () => validateVoiceProvider(minimal({ timeoutMs })),
      TypeError,
      `timeoutMs=${String(timeoutMs)} 应被拒绝`,
    );
  }
});

test('validateVoiceProvider —— voices 必须非空且每项有 id / name', () => {
  assert.throws(() => validateVoiceProvider(minimal({ voices: [] })), TypeError, '空数组');
  assert.throws(() => validateVoiceProvider(minimal({ voices: undefined })), TypeError, '缺失');
  assert.throws(() => validateVoiceProvider(minimal({ voices: [{ name: 'x' }] })), TypeError, '缺 id');
  assert.throws(() => validateVoiceProvider(minimal({ voices: [{ id: 'v1' }] })), TypeError, '缺 name');
  assert.throws(() => validateVoiceProvider(minimal({ voices: [{ id: 'a/b', name: 'x' }] })), TypeError, 'id 含斜杠');
  assert.throws(() => validateVoiceProvider(minimal({ voices: [null] })), TypeError, '非对象');
});

test('validateVoiceProvider —— 音色 id 组内不得重复', () => {
  assert.throws(
    () =>
      validateVoiceProvider(
        minimal({
          voices: [
            { id: 'v1', name: '一' },
            { id: 'v1', name: '二' },
          ],
        }),
      ),
    TypeError,
  );
});

test('validateVoiceProvider —— 非对象一律拒绝', () => {
  for (const value of [null, undefined, 1, 'x', []]) {
    assert.throws(() => validateVoiceProvider(value), TypeError, `${JSON.stringify(value)} 应被拒绝`);
  }
});

test('DEFAULT_PROVIDER_TIMEOUT_MS —— 是正数，供注册表缺省使用', () => {
  assert.equal(Number.isFinite(DEFAULT_PROVIDER_TIMEOUT_MS), true);
  assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS > 0, true);
});
