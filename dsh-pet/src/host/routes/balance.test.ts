/**
 * `POST /balance` 的契约测试：不带 pet 走全局刷新，带 pet 过门禁并把归属写进叶子。
 *
 * 直接测导出的路由处理函数，不启 HTTP 服务、不联网：取数由注入的 refreshBalance 顶替，
 * 这里只钉「路由把什么交给了刷新函数、什么时候不调用它」。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { handleBalanceRoutes } from './balance.ts';
import { failResult } from './result.ts';

/** 内置默认配置：真读包内 assets/config.jsonc，pet 参数存在性校验才有依据。 */
const CONFIG_PATH = fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url));

/** 一次 refreshBalance 的入参。 */
type RefreshCall = { manual: boolean; petId?: string };

/** 造最小路由依赖：requirePet 认 main，refreshBalance 记录入参。 */
function makeDeps(overrides: Partial<PetRouteDeps> = {}): { deps: PetRouteDeps; calls: RefreshCall[] } {
  const calls: RefreshCall[] = [];
  const deps = {
    configPaths: { defaultFile: CONFIG_PATH, userFile: '/nonexistent/main-config.jsonc', petDir: '/nonexistent/pet' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    requirePet: (params: URLSearchParams) =>
      String(params.get('pet') ?? '') === 'main'
        ? { ok: true as const, petId: 'main', entry: 'main', conf: {} }
        : { ok: false as const, res: failResult('unknown-pet', '没有这只桌宠') },
    surfaceBlocked: () => null,
    lockBlocked: () => null,
    refreshBalance: async (manual?: boolean, petId?: string) => {
      calls.push({ manual: manual === true, ...(petId === undefined ? {} : { petId }) });
    },
    ...overrides,
  } as unknown as PetRouteDeps;
  return { deps, calls };
}

/** 一次 POST /balance。 */
function post(query = '', method = 'POST'): RouteInput {
  return { url: new URL('http://127.0.0.1/dsh-pet-7340/balance' + query), rest: 'balance', method };
}

/** 取应答的 JSON 体。 */
function body(result: Awaited<ReturnType<typeof handleBalanceRoutes>>): Record<string, unknown> {
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('/balance —— 方法与非余额路径', () => {
  test('路径不匹配 → 交回分发器（undefined）', async () => {
    const { deps } = makeDeps();
    assert.equal(await handleBalanceRoutes(deps, { ...post(), rest: 'other' }), undefined);
  });

  test('GET → 405', async () => {
    const { deps } = makeDeps();
    const result = await handleBalanceRoutes(deps, post('', 'GET'));
    assert.equal((result as { status: number }).status, 405);
  });
});

describe('/balance —— 不带 pet：全局刷新', () => {
  test('不写归属，一次手动刷新', async () => {
    const { deps, calls } = makeDeps();
    const b = body(await handleBalanceRoutes(deps, post()));

    assert.deepEqual(b, { ok: true });
    assert.deepEqual(calls, [{ manual: true }], '不带 pet 时不该带 petId');
  });

  test('空串 pet 视作没给', async () => {
    const { deps, calls } = makeDeps();
    body(await handleBalanceRoutes(deps, post('?pet=')));
    assert.deepEqual(calls, [{ manual: true }]);
  });
});

describe('/balance —— 带 pet：只让该宠物显示', () => {
  test('校验通过后把 petId 交给刷新函数', async () => {
    const { deps, calls } = makeDeps();
    const b = body(await handleBalanceRoutes(deps, post('?pet=main&surface=web')));

    assert.deepEqual(b, { ok: true });
    assert.deepEqual(calls, [{ manual: true, petId: 'main' }]);
  });

  test('宠物不存在 → unknown-pet，且一次都不刷新', async () => {
    const { deps, calls } = makeDeps();
    const b = body(await handleBalanceRoutes(deps, post('?pet=ghost&surface=web')));
    assert.equal(b.reason, 'unknown-pet');
    assert.deepEqual(calls, [], '门禁拦住的请求不该触发查询');
  });

  test('显示端门禁拦住 → 原样返回，不刷新', async () => {
    const { deps, calls } = makeDeps({
      surfaceBlocked: () => failResult('pet-not-displayed', '这只宠物当前不在这一端'),
    } as Partial<PetRouteDeps>);
    const b = body(await handleBalanceRoutes(deps, post('?pet=main&surface=web')));
    assert.equal(b.reason, 'pet-not-displayed');
    assert.deepEqual(calls, []);
  });

  test('占用锁门禁拦住 → 原样返回，不刷新', async () => {
    const { deps, calls } = makeDeps({ lockBlocked: () => failResult('locked', '正被占用') } as Partial<PetRouteDeps>);
    const b = body(await handleBalanceRoutes(deps, post('?pet=main&surface=web')));
    assert.equal(b.reason, 'locked');
    assert.deepEqual(calls, []);
  });
});
