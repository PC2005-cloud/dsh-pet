/**
 * `/memory/providers` 的路由契约：只转发注册表结论，方法错回 405，其余路径不认领。
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleMemoryRoutes } from './memory.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import {
  listChatMemoryProviders,
  NATIVE_MEMORY_ID,
  registerChatMemoryProvider,
  resetChatMemoryProviders,
} from '../chat-memory-provider.ts';

/** 只填这条路由用到的依赖。 */
function deps(): PetRouteDeps {
  return { memory: { list: listChatMemoryProviders } } as unknown as PetRouteDeps;
}

/** 一条路由输入；rest 已去掉前缀。 */
function input(rest: string, method = 'GET'): RouteInput {
  return { url: new URL('http://localhost/' + rest), rest, method };
}

describe('handleMemoryRoutes', () => {
  beforeEach(() => resetChatMemoryProviders());

  test('GET /memory/providers：返回目录，内置实现恒在首位', async () => {
    const res = await handleMemoryRoutes(deps(), input('memory/providers'));
    assert.equal(res?.kind, 'json');
    const body = (res as { obj: { ok: boolean; providers: Array<{ id: string; name: string }> } }).obj;
    assert.equal(body.ok, true);
    assert.deepEqual(body.providers, [{ id: NATIVE_MEMORY_ID, name: '内置记忆' }]);
  });

  test('注册第三方后出现在目录里，注销后消失', async () => {
    const dispose = registerChatMemoryProvider({ id: 'my-memory', name: '我的记忆', recall: () => undefined });
    try {
      const res = await handleMemoryRoutes(deps(), input('memory/providers'));
      const body = (res as { obj: { providers: Array<{ id: string }> } }).obj;
      assert.deepEqual(
        body.providers.map((item) => item.id),
        [NATIVE_MEMORY_ID, 'my-memory'],
      );
    } finally {
      dispose();
    }
    const after = await handleMemoryRoutes(deps(), input('memory/providers'));
    const body = (after as { obj: { providers: Array<{ id: string }> } }).obj;
    assert.deepEqual(
      body.providers.map((item) => item.id),
      [NATIVE_MEMORY_ID],
    );
  });

  test('方法不是 GET → 405', async () => {
    const res = await handleMemoryRoutes(deps(), input('memory/providers', 'POST'));
    assert.equal((res as { status: number }).status, 405);
  });

  test('其它路径不认领', async () => {
    assert.equal(await handleMemoryRoutes(deps(), input('memory')), undefined);
    assert.equal(await handleMemoryRoutes(deps(), input('memory/other')), undefined);
  });
});
