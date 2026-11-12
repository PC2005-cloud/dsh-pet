/**
 * `POST /environment` 的契约测试：参数解析、门禁顺序、写 S 与应答形状。
 *
 * 直接测导出的路由处理函数，不启 HTTP 服务、不联网：取数由注入的 environment 顶替，
 * 这里只钉「路由把什么交给了取数层、什么时候不调用它、往 S 里写了什么」。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { EnvironmentFacts } from '../environment.ts';
import { handleEnvironmentRoutes } from './environment.ts';
import { failResult } from './result.ts';

/** 取数层的成功结果（省市分开给，weather 与 WeatherSnapshot 同形）。 */
const FACTS: EnvironmentFacts = {
  region: '江西省',
  city: '南昌市',
  weather: {
    city: '南昌',
    summary: '阴',
    temperatureC: 12.7,
    apparentC: 12.5,
    humidityPercent: 90,
    windKph: 2.9,
    code: 3,
    observedAt: '2026-11-11T21:45',
  },
};

/** 内置默认配置：真读包内 assets/config.jsonc，pet 参数存在性校验才有依据。 */
const CONFIG_PATH = fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url));

/** 造最小路由依赖：requirePet 认 main，environment 记录入参并回固定结果。 */
function makeDeps(overrides: Partial<PetRouteDeps> = {}): {
  deps: PetRouteDeps;
  writes: { name: string; data: unknown }[];
  envCalls: { fresh: boolean }[];
} {
  const writes: { name: string; data: unknown }[] = [];
  const envCalls: { fresh: boolean }[] = [];
  const deps = {
    configPaths: { defaultFile: CONFIG_PATH, userFile: '/nonexistent/main-config.jsonc', petDir: '/nonexistent/pet' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    state: {
      writeSection: (name: string, data: unknown) => {
        writes.push({ name, data });
      },
    },
    requirePet: (params: URLSearchParams) =>
      String(params.get('pet') ?? '') === 'main'
        ? { ok: true as const, petId: 'main', entry: 'main', conf: {} }
        : { ok: false as const, res: failResult('unknown-pet', '没有这只桌宠') },
    surfaceBlocked: () => null,
    lockBlocked: () => null,
    environment: async (opts?: { fresh?: boolean }) => {
      envCalls.push({ fresh: opts?.fresh === true });
      return FACTS;
    },
    ...overrides,
  } as unknown as PetRouteDeps;
  return { deps, writes, envCalls };
}

/** 一次 POST /environment。 */
function post(query = '', method = 'POST'): RouteInput {
  return { url: new URL('http://127.0.0.1/dsh-pet-7340/environment' + query), rest: 'environment', method };
}

/** 取应答的 JSON 体。 */
function body(result: Awaited<ReturnType<typeof handleEnvironmentRoutes>>): Record<string, unknown> {
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('/environment —— 方法与非环境路径', () => {
  test('路径不匹配 → 交回分发器（undefined）', async () => {
    const { deps } = makeDeps();
    const result = await handleEnvironmentRoutes(deps, { ...post(), rest: 'other' });
    assert.equal(result, undefined);
  });

  test('GET → 405（写 S 的动作只收 POST）', async () => {
    const { deps } = makeDeps();
    const result = await handleEnvironmentRoutes(deps, post('', 'GET'));
    assert.equal((result as { status: number }).status, 405);
  });
});

describe('/environment —— 不带 pet：纯查询', () => {
  test('返回省市与天气，但不写 S、不带 petId', async () => {
    const { deps, writes } = makeDeps();
    const b = body(await handleEnvironmentRoutes(deps, post()));

    assert.deepEqual(b, { ok: true, region: '江西省', city: '南昌市', weather: FACTS.weather });
    assert.equal('petId' in b, false, '纯查询不该带 petId');
    assert.deepEqual(writes, [], '不带 pet 不许写 S');
  });

  test('查不到：只回 ok:true，不编字段', async () => {
    const { deps } = makeDeps({ environment: async () => ({}) } as Partial<PetRouteDeps>);
    const b = body(await handleEnvironmentRoutes(deps, post()));
    assert.deepEqual(b, { ok: true });
  });

  test('fresh 缺省 → false；fresh=1 → true', async () => {
    const { deps, envCalls } = makeDeps();
    await handleEnvironmentRoutes(deps, post());
    await handleEnvironmentRoutes(deps, post('?fresh=1'));
    assert.deepEqual(envCalls, [{ fresh: false }, { fresh: true }]);
  });
});

describe('/environment —— 带 pet：写 S 供气泡使用', () => {
  test('写 sections.env：省市、天气、petId 与写入时刻齐全', async () => {
    const { deps, writes } = makeDeps();
    const b = body(await handleEnvironmentRoutes(deps, post('?pet=main&fresh=1')));

    assert.equal(b.ok, true);
    assert.equal(b.petId, 'main');
    assert.equal(writes.length, 1);
    const written = writes[0];
    assert.equal(written?.name, 'env');
    const data = written?.data as Record<string, unknown>;
    assert.equal(data.petId, 'main');
    assert.equal(data.region, '江西省');
    assert.equal(data.city, '南昌市');
    assert.deepEqual(data.weather, FACTS.weather);
    assert.equal(typeof data.ts, 'number', '叶子必须带写入时刻');
  });

  test('查不到时也写：只带 petId 与时刻，前端据此显示“查不到”', async () => {
    const { deps, writes } = makeDeps({ environment: async () => ({}) } as Partial<PetRouteDeps>);
    body(await handleEnvironmentRoutes(deps, post('?pet=main')));

    const data = writes[0]?.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), ['petId', 'ts']);
  });

  test('宠物不存在 → unknown-pet，且一次都不去查环境', async () => {
    const { deps, envCalls } = makeDeps();
    const b = body(await handleEnvironmentRoutes(deps, post('?pet=ghost')));
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'unknown-pet');
    assert.deepEqual(envCalls, [], '门禁拦住的请求不该产生网络请求');
  });

  test('显示端门禁拦住 → 原样返回，不查环境、不写 S', async () => {
    const { deps, writes, envCalls } = makeDeps({
      surfaceBlocked: () => failResult('pet-not-displayed', '这只宠物当前不在这一端'),
    } as Partial<PetRouteDeps>);
    const b = body(await handleEnvironmentRoutes(deps, post('?pet=main')));
    assert.equal(b.reason, 'pet-not-displayed');
    assert.deepEqual(envCalls, []);
    assert.deepEqual(writes, []);
  });

  test('占用锁门禁拦住 → 原样返回', async () => {
    const { deps } = makeDeps({
      lockBlocked: () => failResult('locked', '宠物正被占用'),
    } as Partial<PetRouteDeps>);
    const b = body(await handleEnvironmentRoutes(deps, post('?pet=main')));
    assert.equal(b.reason, 'locked');
  });
});
