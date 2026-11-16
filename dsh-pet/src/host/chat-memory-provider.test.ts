/**
 * 记忆提供者注册表的契约测试：多槽、id 唯一、disposer 只清自己、内置实现常驻。
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MEMORY_TIMEOUT_MS,
  listChatMemoryProviders,
  NATIVE_MEMORY_ID,
  registerChatMemoryProvider,
  resetChatMemoryProviders,
  resolveChatMemoryProvider,
  type ChatMemoryProvider,
} from './chat-memory-provider.ts';

/** 最小可用实现：给一个 id 与 name，召回返回 undefined。 */
function provider(id: string, extra: Partial<ChatMemoryProvider> = {}): ChatMemoryProvider {
  return { id, name: id.toUpperCase(), recall: () => undefined, ...extra };
}

describe('registerChatMemoryProvider', () => {
  beforeEach(() => resetChatMemoryProviders());

  test('注册后可按 id 解析；disposer 清掉自己那条', () => {
    const dispose = registerChatMemoryProvider(provider('pc'));
    assert.equal(resolveChatMemoryProvider('pc').id, 'pc');
    dispose();
    assert.equal(resolveChatMemoryProvider('pc').id, NATIVE_MEMORY_ID);
  });

  test('重复 id：拒绝注册，不覆盖已有那一份', () => {
    const first = provider('pc');
    registerChatMemoryProvider(first);
    assert.throws(() => registerChatMemoryProvider(provider('pc')), TypeError);
    assert.equal(resolveChatMemoryProvider('pc'), first);
  });

  test('多个实现并存：注销一个不影响另一个，迟到的注销不顶掉后来者', () => {
    const disposeA = registerChatMemoryProvider(provider('a'));
    const b = provider('b');
    registerChatMemoryProvider(b);
    disposeA();
    assert.equal(resolveChatMemoryProvider('b'), b);
    assert.equal(resolveChatMemoryProvider('a').id, NATIVE_MEMORY_ID);
  });

  test('拒绝占用内置标识、非法 id、空 name、两个方法都缺失与非法超时', () => {
    assert.throws(() => registerChatMemoryProvider(provider(NATIVE_MEMORY_ID)), TypeError);
    assert.throws(() => registerChatMemoryProvider(null as never), TypeError);
    assert.throws(() => registerChatMemoryProvider({ id: '', name: 'x' } as never), TypeError);
    assert.throws(() => registerChatMemoryProvider({ id: 'Bad Id', name: 'x' } as never), TypeError);
    assert.throws(() => registerChatMemoryProvider({ id: 'x', name: ' ' } as never), TypeError);
    assert.throws(() => registerChatMemoryProvider({ id: 'x', name: 'x' } as never), TypeError);
    assert.throws(() => registerChatMemoryProvider(provider('x', { timeoutMs: 0 })), TypeError);
    assert.throws(() => registerChatMemoryProvider(provider('x', { timeoutMs: Number.NaN })), TypeError);
  });

  test('未注册的 id：解析回落内置实现', () => {
    assert.equal(resolveChatMemoryProvider('nope').id, NATIVE_MEMORY_ID);
    assert.equal(resolveChatMemoryProvider('').id, NATIVE_MEMORY_ID);
  });
});

describe('listChatMemoryProviders', () => {
  beforeEach(() => resetChatMemoryProviders());

  test('内置恒在首位，第三方按注册顺序追加', () => {
    assert.deepEqual(listChatMemoryProviders(), { providers: [{ id: NATIVE_MEMORY_ID, name: '内置记忆' }] });
    registerChatMemoryProvider(provider('a'));
    registerChatMemoryProvider(provider('b'));
    assert.deepEqual(
      listChatMemoryProviders().providers.map((item) => item.id),
      [NATIVE_MEMORY_ID, 'a', 'b'],
    );
  });
});

describe('resolveChatMemoryProvider', () => {
  test('内置实现：召回直接交回核心拼好的那份请求体', () => {
    const prepared = { system: '人设', history: [], userText: '在吗' };
    const native = resolveChatMemoryProvider(NATIVE_MEMORY_ID);
    assert.deepEqual(
      native.recall?.({ petId: 'main', userText: '在吗', prepared, raw: rawFacts() }, new AbortController().signal),
      prepared,
    );
  });

  test('内置实现没有声明超时，走注册表的缺省值', () => {
    assert.equal(resolveChatMemoryProvider(NATIVE_MEMORY_ID).timeoutMs, undefined);
    assert.equal(DEFAULT_MEMORY_TIMEOUT_MS, 15_000);
  });
});

/** 一份最小原始事实，只为满足类型。 */
function rawFacts() {
  return {
    persona: '人设',
    now: 0,
    memes: [],
    actions: [],
    pet: { id: 'main', name: '小黑', entry: 'main', display: 'both' },
  };
}
