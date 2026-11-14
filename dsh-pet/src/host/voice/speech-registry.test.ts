/**
 * 语音识别注册表的行为测试（src/host/voice/speech-registry.ts）。
 *
 * 只钉「谁在表里、谁解析得到、谁不被覆盖」——识别与超时不在本模块，另有测试。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  listSpeechCatalog,
  registerSpeechProvider,
  resetSpeechProviders,
  resolveSpeechProvider,
} from './speech-registry.ts';
import type { SpeechProvider } from './speech-types.ts';

/** 造一个最小实现；只关心 id，transcribe 返回固定文字。 */
const provider = (id: string): SpeechProvider => ({
  id,
  name: id,
  transcribe: async () => '好',
});

afterEach(() => {
  resetSpeechProviders();
});

test('初始状态：目录为空，任何 id 都解析不到', () => {
  assert.deepEqual(listSpeechCatalog(), { providers: [] });
  assert.equal(resolveSpeechProvider('dsh'), undefined);
});

test('注册之后：目录按注册顺序列出，id 可解析', () => {
  registerSpeechProvider(provider('first'));
  registerSpeechProvider(provider('second'));

  assert.deepEqual(
    listSpeechCatalog().providers.map((item) => item.id),
    ['first', 'second'],
    '顺序即注册顺序',
  );
  assert.equal(resolveSpeechProvider('second')?.id, 'second');
});

test('多个实现并存：后注册的不覆盖先注册的', () => {
  registerSpeechProvider(provider('first'));
  registerSpeechProvider(provider('second'));
  assert.equal(resolveSpeechProvider('first')?.id, 'first', '先注册的仍然可用');
  assert.equal(listSpeechCatalog().providers.length, 2);
});

test('重复 id：抛 TypeError，且先注册的那份保持不变', () => {
  const original = provider('dup');
  registerSpeechProvider(original);
  assert.throws(() => registerSpeechProvider(provider('dup')), TypeError);
  assert.equal(resolveSpeechProvider('dup'), original, '被拒绝的注册不能顶掉原有的');
});

test('注销只删自己那份：迟到的注销不会顶掉后来者', () => {
  const disposeFirst = registerSpeechProvider(provider('first'));
  const disposeSecond = registerSpeechProvider(provider('second'));
  disposeFirst();
  assert.equal(resolveSpeechProvider('first'), undefined);
  assert.equal(resolveSpeechProvider('second')?.id, 'second', '别人的注销不该影响自己');
  disposeSecond();
  assert.deepEqual(listSpeechCatalog(), { providers: [] });
});

test('注销是幂等的：连调两次不会抛错，也不影响别的实现', () => {
  const dispose = registerSpeechProvider(provider('gone'));
  registerSpeechProvider(provider('kept'));
  dispose();
  dispose();
  assert.deepEqual(
    listSpeechCatalog().providers.map((item) => item.id),
    ['kept'],
  );
});

test('解析：没注册过的 id 返回 undefined，不做任何猜测', () => {
  registerSpeechProvider(provider('demo'));
  assert.equal(resolveSpeechProvider('missing'), undefined);
  assert.equal(resolveSpeechProvider(''), undefined);
});

test('目录每次现算：注销后立刻反映，不返回陈旧副本', () => {
  const dispose = registerSpeechProvider(provider('demo'));
  assert.equal(listSpeechCatalog().providers.length, 1);
  dispose();
  assert.equal(listSpeechCatalog().providers.length, 0);
});

test('非法定义一律抛 TypeError，且不留下半条登记', () => {
  assert.throws(() => registerSpeechProvider(null as never), TypeError, '非对象');
  assert.throws(() => registerSpeechProvider({ ...provider('Edge') }), TypeError, 'id 不是 kebab-case');
  assert.throws(() => registerSpeechProvider({ ...provider('demo'), transcribe: undefined } as never), TypeError);
  assert.deepEqual(listSpeechCatalog(), { providers: [] }, '失败的定义不该留下任何一条');
});
