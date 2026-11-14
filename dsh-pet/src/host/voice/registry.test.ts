/**
 * 语音注册表的行为测试（src/host/voice/registry.ts）。
 *
 * 只钉「谁在表里、谁解析得到、谁不被覆盖」——合成与缓存不在本模块，另有测试。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { listCatalog, registerVoiceProvider, resetVoiceProviders, resolveVoice } from './registry.ts';
import type { VoiceInfo, VoiceProvider } from './types.ts';

/** 造一个最小实现；只关心 id 与音色，synthesize 返回一字节占位。 */
const provider = (id: string, voices: readonly VoiceInfo[] = [{ id: 'v1', name: '音色一' }]): VoiceProvider => ({
  id,
  name: id,
  voices,
  synthesize: async () => new Uint8Array([1]),
});

afterEach(() => {
  resetVoiceProviders();
});

test('初始状态：目录为空，任何限定 id 都解析不到', () => {
  assert.deepEqual(listCatalog(), { providers: [] });
  assert.equal(resolveVoice('edge/zh-CN-XiaoyiNeural'), undefined);
});

test('注册之后：目录按注册顺序列出，限定 id 可解析', () => {
  registerVoiceProvider(provider('first'));
  registerVoiceProvider(provider('second'));

  const catalog = listCatalog();
  assert.deepEqual(
    catalog.providers.map((item) => item.id),
    ['first', 'second'],
    '顺序即注册顺序',
  );
  assert.deepEqual(catalog.providers[0]?.voices, [{ id: 'first/v1', name: '音色一' }], '音色 id 带 provider 前缀');

  const resolved = resolveVoice('second/v1');
  assert.equal(resolved?.provider.id, 'second');
  assert.equal(resolved?.voice.id, 'v1', '解析结果里的音色仍是不带前缀的原始 id');
  assert.equal(resolved?.limitedId, 'second/v1');
});

test('多个实现并存：后注册的不覆盖先注册的', () => {
  registerVoiceProvider(provider('first'));
  registerVoiceProvider(provider('second'));
  assert.equal(resolveVoice('first/v1')?.provider.id, 'first', '先注册的仍然可用');
  assert.equal(resolveVoice('second/v1')?.provider.id, 'second');
  assert.equal(listCatalog().providers.length, 2);
});

test('重复 id：抛 TypeError，且先注册的那份保持不变', () => {
  const original = provider('dup');
  registerVoiceProvider(original);
  assert.throws(() => registerVoiceProvider(provider('dup')), TypeError);
  assert.equal(resolveVoice('dup/v1')?.provider, original, '被拒绝的注册不能顶掉原有的');
});

test('注销只删自己那份：迟到的注销不会顶掉后来者', () => {
  const disposeFirst = registerVoiceProvider(provider('first'));
  const disposeSecond = registerVoiceProvider(provider('second'));
  disposeFirst();
  assert.equal(resolveVoice('first/v1'), undefined);
  assert.equal(resolveVoice('second/v1')?.provider.id, 'second', '别人的注销不该影响自己');
  disposeSecond();
  assert.deepEqual(listCatalog(), { providers: [] });
});

test('注销是幂等的：连调两次不会抛错，也不会影响别的实现', () => {
  const dispose = registerVoiceProvider(provider('gone'));
  registerVoiceProvider(provider('kept'));
  dispose();
  dispose();
  assert.deepEqual(
    listCatalog().providers.map((item) => item.id),
    ['kept'],
  );
});

test('resolveVoice：provider 不存在、音色不存在、裸 id 一律返回 undefined', () => {
  registerVoiceProvider(provider('demo', [{ id: 'a', name: 'A' }]));
  assert.equal(resolveVoice('missing/a'), undefined, 'provider 不存在');
  assert.equal(resolveVoice('demo/zzz'), undefined, '音色不存在');
  assert.equal(resolveVoice('a'), undefined, '裸 id 不再等价于任何 provider');
  assert.equal(resolveVoice('demo/'), undefined);
  assert.equal(resolveVoice(''), undefined);
});

test('目录：tag 缺省时不出现该键，给了就原样带出', () => {
  registerVoiceProvider(
    provider('demo', [
      { id: 'plain', name: '朴素' },
      { id: 'styled', name: '带标签', tag: '女 · 活泼' },
    ]),
  );
  const voices = listCatalog().providers[0]?.voices ?? [];
  assert.deepEqual(voices[0], { id: 'demo/plain', name: '朴素' });
  assert.equal('tag' in (voices[0] ?? {}), false, '没给 tag 就不该凭空写入');
  assert.deepEqual(voices[1], { id: 'demo/styled', name: '带标签', tag: '女 · 活泼' });
});

test('目录每次现算：注销后立刻反映，不返回陈旧副本', () => {
  const dispose = registerVoiceProvider(provider('demo'));
  assert.equal(listCatalog().providers.length, 1);
  dispose();
  assert.equal(listCatalog().providers.length, 0);
});

test('非法定义一律抛 TypeError，且不留下半条登记', () => {
  assert.throws(() => registerVoiceProvider(null as never), TypeError, '非对象');
  assert.throws(() => registerVoiceProvider({ ...provider('Edge') }), TypeError, 'id 不是 kebab-case');
  assert.throws(() => registerVoiceProvider({ ...provider('demo'), voices: [] }), TypeError, '空音色');
  for (const bad of [null, { ...provider('Edge') }, { ...provider('demo'), synthesize: undefined }]) {
    assert.throws(() => registerVoiceProvider(bad as never), TypeError);
  }
  assert.deepEqual(listCatalog(), { providers: [] }, '失败的定义不该留下任何一条');
});
