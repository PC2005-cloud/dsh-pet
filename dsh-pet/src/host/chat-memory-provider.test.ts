/**
 * 记忆提供者注册表的契约测试：单槽、后注册覆盖、disposer 只清自己、
 * 原生标识不可占用、recall/capture 至少要有一个。
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeChatMemoryProvider,
  listChatMemoryProviders,
  NATIVE_MEMORY_ID,
  registerChatMemoryProvider,
  resetChatMemoryProviders,
  type ChatMemoryProvider,
} from './chat-memory-provider.ts';

describe('registerChatMemoryProvider', () => {
  beforeEach(() => resetChatMemoryProviders());

  test('注册后成为当前实现；disposer 清空', () => {
    const def: ChatMemoryProvider = { id: 'a', recall: async () => undefined };
    const dispose = registerChatMemoryProvider(def);
    assert.equal(activeChatMemoryProvider(), def);
    dispose();
    assert.equal(activeChatMemoryProvider(), null);
  });

  test('后注册覆盖先注册；旧 disposer 不会清掉新实现', () => {
    const first: ChatMemoryProvider = { id: 'first', capture: () => {} };
    const second: ChatMemoryProvider = { id: 'second', capture: () => {} };
    const disposeFirst = registerChatMemoryProvider(first);
    registerChatMemoryProvider(second);
    disposeFirst();
    assert.equal(activeChatMemoryProvider(), second, '迟到的注销不得顶掉后来者');
  });

  test('拒绝原生标识、空 id、非对象与两个方法都缺失', () => {
    assert.throws(() => registerChatMemoryProvider({ id: NATIVE_MEMORY_ID, recall: async () => undefined }), TypeError);
    assert.throws(() => registerChatMemoryProvider(null as never), TypeError);
    assert.throws(() => registerChatMemoryProvider({ id: '' } as never), TypeError);
    assert.throws(() => registerChatMemoryProvider({ id: 'x' } as never), TypeError, '两个方法都缺失必须拒绝');
    assert.throws(() => registerChatMemoryProvider({ id: 'x', recall: 1 } as never), TypeError);
  });

  test('list 报原生标识与当前第三方 id', () => {
    assert.deepEqual(listChatMemoryProviders(), { builtin: [NATIVE_MEMORY_ID], external: [] });
    registerChatMemoryProvider({ id: 'pc', recall: async () => undefined });
    assert.deepEqual(listChatMemoryProviders(), { builtin: [NATIVE_MEMORY_ID], external: ['pc'] });
  });
});
