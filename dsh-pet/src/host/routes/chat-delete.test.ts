/**
 * `DELETE /chat` 的契约测试：参数解析、方法白名单与「删除不走 surface 校验」。
 *
 * 直接测导出的路由处理函数，不启 HTTP 服务：删除的记忆读写行为由 chat-memory.test.ts 覆盖，
 * 这里只钉「路由把什么交给了服务层」——参数被解析成什么、什么情况一次都不该调用。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/chat-delete.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { PetRouteDeps, RouteInput } from './types.ts';
import { handleChatRoutes } from './chat.ts';

/** 一次 deleteHistory 调用（用来断言路由透传了什么） */
type DeleteCall = { petId: string; ts?: readonly number[] };

/** 造最小路由依赖；requirePet 固定回 main，deleteHistory 记录入参并回成功。 */
function makeDeps(): { deps: PetRouteDeps; calls: DeleteCall[] } {
  const calls: DeleteCall[] = [];
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {} },
    memoryPath: '/tmp/dsh-pet-memory.json',
    memoryRounds: () => 5,
    readMemory: async () => ({}),
    requirePet: () => ({ ok: true, petId: 'main', entry: 'main', conf: {} }),
    deleteHistory: async (petId: string, ts?: readonly number[]) => {
      calls.push({ petId, ...(ts === undefined ? {} : { ts }) });
      return { ok: true as const, removed: 2 };
    },
    orphanHistory: async () => [{ entry: 'main', petId: 'gone', messages: 4, lastTs: 1000 }],
    deleteOrphans: async () => ({ ok: true as const, pets: 1, messages: 4 }),
  } as unknown as PetRouteDeps;
  return { deps, calls };
}

/** 一次 DELETE /chat；`query` 直接拼在 `?pet=main` 之后（如 `&ts=1&ts=2`）。 */
function del(query = '', surface = 'web'): RouteInput {
  return {
    url: new URL(`http://127.0.0.1/dsh-pet-7340/chat?pet=main&surface=${surface}${query}`),
    rest: 'chat',
    method: 'DELETE',
  };
}

/** 取应答的 JSON 体。 */
function body(result: Awaited<ReturnType<typeof handleChatRoutes>>): Record<string, unknown> {
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('DELETE /chat —— 删除对话记忆', () => {
  test('不带 ts → 清空整只（服务收到 undefined）', async () => {
    const { deps, calls } = makeDeps();
    const b = body(await handleChatRoutes(deps, del()));
    assert.equal(b.ok, true);
    assert.equal(b.removed, 2, '服务给的数量应原样带回');
    assert.deepEqual(calls, [{ petId: 'main' }]);
  });

  test('带多个 ts → 去重后下传', async () => {
    const { deps, calls } = makeDeps();
    body(await handleChatRoutes(deps, del('&ts=1000&ts=2000&ts=1000')));
    assert.deepEqual(calls, [{ petId: 'main', ts: [1000, 2000] }]);
  });

  test('ts 非法（负数 / 小数 / 非数字 / 空串）→ bad-request，且一次都不调用服务', async () => {
    for (const bad of ['-1', '1.5', 'abc', '', '%20']) {
      const { deps, calls } = makeDeps();
      const b = body(await handleChatRoutes(deps, del(`&ts=${bad}`)));
      assert.equal(b.ok, false, bad);
      assert.equal(b.reason, 'bad-request', bad);
      assert.deepEqual(calls, [], `非法 ts 必须在调用 deleteHistory 之前被拒：${bad}`);
    }
  });

  test('PUT 等其它方法仍是 405（不因为新增了 DELETE 就放宽白名单）', async () => {
    const { deps } = makeDeps();
    const result = await handleChatRoutes(deps, { ...del(), method: 'PUT' });
    assert.equal((result as { status: number }).status, 405);
  });

  test('不校验 surface：删除是存储管理，与宠物显示在哪一端无关', async () => {
    const { deps, calls } = makeDeps();
    const b = body(await handleChatRoutes(deps, del('', 'nope')));
    assert.equal(b.ok, true, '非法 surface 不该拦住删除');
    assert.equal(calls.length, 1);
  });

  test('宠物不存在 → 服务层的 unknown-pet 原样透传', async () => {
    const { deps } = makeDeps();
    const failing = {
      ...deps,
      deleteHistory: async () => ({ ok: false as const, reason: 'unknown-pet' as const, message: '没有这只桌宠' }),
    };
    const b = body(await handleChatRoutes(failing, del()));
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'unknown-pet');
  });
});

describe('/chat/memory —— 已删宠物的残留历史', () => {
  /** 一次 /chat/memory 请求；不需要 pet 参数。 */
  const memory = (method = 'GET'): RouteInput => ({
    url: new URL('http://127.0.0.1/dsh-pet-7340/chat/memory'),
    rest: 'chat/memory',
    method,
  });

  test('GET 列出残留：只给条数与最后时间，不给正文', async () => {
    const { deps } = makeDeps();
    const b = body(await handleChatRoutes(deps, memory()));
    assert.equal(b.ok, true);
    assert.deepEqual(b.orphans, [{ entry: 'main', petId: 'gone', messages: 4, lastTs: 1000 }]);
  });

  test('DELETE 一次清空全部残留，回删掉的宠物数与消息数', async () => {
    const { deps } = makeDeps();
    const b = body(await handleChatRoutes(deps, memory('DELETE')));
    assert.deepEqual(b, { ok: true, pets: 1, messages: 4 });
  });

  test('其它方法 → 405（这对端点只读列表与清空）', async () => {
    const { deps } = makeDeps();
    const result = await handleChatRoutes(deps, memory('POST'));
    assert.equal((result as { status: number }).status, 405);
  });
});

test('PowerContext status and sync leave orphan-history routes intact', async () => {
  const { deps: base } = makeDeps();
  let synced = false;
  const deps: PetRouteDeps = {
    ...base,
    memoryStatus: async () => ({
      ok: true,
      backend: 'powercontext',
      pending: synced ? 0 : 1,
      captured: synced ? 1 : 0,
      skipped: 0,
      scopeId: 'scope-test',
      recall: 'empty',
      error: null,
      processing: 'Source capture does not establish Memory extraction.',
    }),
    syncMemory: async () => {
      synced = true;
    },
  };
  const input: RouteInput = {
    rest: 'chat/powercontext',
    method: 'GET',
    url: new URL('http://127.0.0.1/dsh-pet-7340/chat/powercontext?pet=main'),
  };
  assert.equal(body(await handleChatRoutes(deps, input)).pending, 1);
  assert.equal(body(await handleChatRoutes(deps, { ...input, method: 'POST' })).pending, 0);
  assert.equal(((await handleChatRoutes(deps, { ...input, method: 'DELETE' })) as { status: number }).status, 405);
  assert.ok(Array.isArray(body(await handleChatRoutes(deps, { ...input, rest: 'chat/memory' })).orphans));
});
