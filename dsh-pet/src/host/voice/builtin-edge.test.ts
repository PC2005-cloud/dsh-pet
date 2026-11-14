/**
 * 内置 edge 实现的契约测试（src/host/voice/builtin-edge.ts）。
 *
 * 只钉「它声明了什么、注册完解析得到什么」——真正的合成走网络，不在默认套件里跑。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EDGE_PROVIDER, EDGE_PROVIDER_ID, ensureEdgeProvider } from './builtin-edge.ts';
import { listCatalog, resetVoiceProviders, resolveVoice } from './registry.ts';
import { validateVoiceProvider } from './types.ts';
import { DEFAULT_VOICE, VOICES } from './voices.ts';

afterEach(() => {
  resetVoiceProviders();
});

test('声明：通过注册校验，格式为 mp3，超时 28 秒', () => {
  assert.doesNotThrow(() => validateVoiceProvider(EDGE_PROVIDER));
  assert.equal(EDGE_PROVIDER.format, 'mp3');
  assert.equal(EDGE_PROVIDER.timeoutMs, 28_000);
});

test('音色：与 voices.ts 的白名单同源，id 不含 provider 前缀', () => {
  assert.deepEqual(
    EDGE_PROVIDER.voices.map((voice) => voice.id),
    VOICES.map((voice) => voice.id),
  );
  for (const voice of EDGE_PROVIDER.voices) {
    assert.equal(voice.id.includes('/'), false, `音色 id 不能自带前缀: ${voice.id}`);
  }
});

test('注册：ensureEdgeProvider 之后默认音色可解析，目录里出现 edge 分组', () => {
  ensureEdgeProvider();
  const resolved = resolveVoice(`${EDGE_PROVIDER_ID}/${DEFAULT_VOICE}`);
  assert.equal(resolved?.provider.id, EDGE_PROVIDER_ID);
  assert.equal(resolved?.voice.id, DEFAULT_VOICE);
  const group = listCatalog().providers.find((item) => item.id === EDGE_PROVIDER_ID);
  assert.equal(group?.name, 'Edge');
  assert.equal(group?.voices.length, VOICES.length);
});

test('幂等：重复调用不会重复登记，也不会抛错', () => {
  ensureEdgeProvider();
  ensureEdgeProvider();
  const groups = listCatalog().providers.filter((item) => item.id === EDGE_PROVIDER_ID);
  assert.equal(groups.length, 1, '同一次装配里不该出现两份 edge');
});

test('复位后可重新登记：测试隔离依赖这一点', () => {
  ensureEdgeProvider();
  resetVoiceProviders();
  assert.equal(resolveVoice(`${EDGE_PROVIDER_ID}/${DEFAULT_VOICE}`), undefined);
  ensureEdgeProvider();
  assert.equal(resolveVoice(`${EDGE_PROVIDER_ID}/${DEFAULT_VOICE}`)?.provider.id, EDGE_PROVIDER_ID);
});

test('目录：每个音色的限定 id 都是 edge/<音色>', () => {
  ensureEdgeProvider();
  const group = listCatalog().providers.find((item) => item.id === EDGE_PROVIDER_ID);
  for (const voice of group?.voices ?? []) {
    assert.ok(voice.id.startsWith(`${EDGE_PROVIDER_ID}/`), `限定 id 缺前缀: ${voice.id}`);
  }
});
