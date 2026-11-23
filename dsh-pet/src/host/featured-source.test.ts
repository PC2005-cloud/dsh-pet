/**
 * 精选插件宿主半接入的单元测试 —— 钉住桩守卫、服务登记与聚合路由的口径。
 *
 * 为什么要单独钉：featured 接入在宿主进程里挂跨插件服务与 HTTP 路由，注册错或重复注册
 * 都会静默降级（路由丢失 / 双 tab），出问题没有日志。这里用最小桩 ctx 把生态约定的
 * 四条口径钉死：
 *   ① 缺 get/inject 的桩环境（standalone / 桌面模式）直接不跑，不抛错；
 *   ② 首个激活方 provide 服务、登记源并持有聚合路由；
 *   ③ 第二个接入方只登记源，不重复 provide 也不重复挂路由；
 *   ④ 聚合路由按包名去重、条目汇总来自所有登记源；跨源请求 403、非 GET 405。
 *
 * 跑法：node --experimental-strip-types --test src/host/featured-source.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FEATURED_SOURCE, ROUTE, SERVICE, integrateFeaturedPlugins } from './featured-source.ts';

/** 聚合路由注册形态（只取测试关心的字段）。 */
interface RegisteredRoute {
  kind: string;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 宿主 webServer 的 handler 无静态类型
  handler: (req: any, res: any) => Promise<void> | void;
}

/** 最小桩 ctx：cordis 的 effect/provide/get/inject 子集 + webServer.register 记名册。 */
function makeStubCtx(sharedServices?: Map<string, unknown>) {
  const services = sharedServices ?? new Map<string, unknown>();
  const routes: RegisteredRoute[] = [];
  const disposers: Array<{ label: string; dispose: () => void }> = [];
  const effect = (fn: () => (() => void) | void, label?: string): (() => void) | void => {
    const d = fn();
    if (typeof d === 'function') disposers.push({ label: String(label ?? ''), dispose: d });
    return d;
  };
  // 桩不做等待：inject 回调同步执行，webServer 恒可用（pluginManager 缺席时 watcher 自兜）。
  const inject = (_deps: string[], cb: (child: Record<string, unknown>) => void) => {
    cb({
      effect,
      webServer: {
        register: (opts: RegisteredRoute) => {
          routes.push(opts);
          return () => {
            const i = routes.indexOf(opts);
            if (i >= 0) routes.splice(i, 1);
          };
        },
      },
    });
  };
  const ctx: Record<string, unknown> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试桩对齐宿主 ctx 的无类型形态
    get: (name: string) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试桩对齐宿主 ctx 的无类型形态
    inject: (deps: string[], cb: (child: any) => void) => void;
  } = {
    effect,
    inject,
    provide: (name: string, value: unknown) => {
      services.set(name, value);
      return () => {
        if (services.get(name) === value) services.delete(name);
      };
    },
    get: (name: string) => services.get(name),
  };
  return { ctx, services, routes, disposers };
}

/** 响应桩：收集 writeHead 与 end 的内容，供断言 JSON 输出。 */
function makeResStub() {
  const chunks: string[] = [];
  let status = 0;
  return {
    writeHead(code: number): void {
      status = code;
    },
    end(body?: string): void {
      if (body) chunks.push(body);
    },
    status: () => status,
    body: () => chunks.join(''),
  };
}

describe('integrateFeaturedPlugins — 桩守卫', () => {
  test('缺 get/inject 的桩环境直接不跑，不抛错', () => {
    assert.doesNotThrow(() => integrateFeaturedPlugins(null, FEATURED_SOURCE));
    assert.doesNotThrow(() => integrateFeaturedPlugins(undefined, FEATURED_SOURCE));
    assert.doesNotThrow(() => integrateFeaturedPlugins({} as Record<string, never>, FEATURED_SOURCE));
    assert.doesNotThrow(() => integrateFeaturedPlugins({ get: () => undefined }, FEATURED_SOURCE));
  });
});

describe('integrateFeaturedPlugins — 服务与路由', () => {
  test('首个激活方 provide 服务、登记源并持有聚合路由', () => {
    const { ctx, services, routes } = makeStubCtx();
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE);
    const registry = services.get(SERVICE) as { list: () => Array<{ id: string; entries: unknown[] }> };
    assert.ok(registry, 'featured-plugins 服务应已 provide');
    assert.deepEqual(registry.list(), [{ id: 'dsh-pet', title: 'dsh-pet', entries: [] }]);
    assert.equal(routes.length, 1, '宿主方应恰好挂一条聚合路由');
    assert.equal(routes[0].kind, 'exact');
    assert.equal(routes[0].path, ROUTE);
  });

  test('第二个接入方只登记源：不重复 provide，也不重复挂路由', () => {
    const shared = new Map<string, unknown>();
    const first = makeStubCtx(shared);
    integrateFeaturedPlugins(first.ctx, FEATURED_SOURCE);
    const second = makeStubCtx(shared);
    const otherSource = {
      id: 'other-pet',
      title: 'other',
      entries: [{ package: 'pkg-x', title: 'X', source: 'other-pet' }],
    };
    integrateFeaturedPlugins(second.ctx, otherSource);
    assert.equal(first.routes.length + second.routes.length, 1, '聚合路由仍只有宿主方那一条');
    const registry = shared.get(SERVICE) as { list: () => Array<{ id: string; entries: Array<{ package: string }> }> };
    assert.deepEqual(
      registry.list().map((s) => s.id),
      ['dsh-pet', 'other-pet'],
    );
    assert.deepEqual(registry.list()[1].entries, [{ package: 'pkg-x', title: 'X', source: 'other-pet' }]);
  });

  test('登记源注销后不再出现在 list()（插件停用即注销）', () => {
    const { ctx, services, disposers } = makeStubCtx();
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE);
    const registry = services.get(SERVICE) as { list: () => Array<{ id: string }> };
    assert.equal(registry.list().length, 1);
    // 源注销挂在 inject 子上下文的 effect 上（label 以 'featured-plugins source:' 开头），
    // 与 registry 服务的 provide 注销是两个不同的 disposer，按 label 精确取。
    const unregister = disposers.find((d) => d.label.startsWith('featured-plugins source:'));
    assert.ok(unregister, '登记源应返回注销函数');
    unregister.dispose();
    assert.deepEqual(registry.list(), [], '注销后 sources 应清空');
  });
});

describe('integrateFeaturedPlugins — 聚合路由行为', () => {
  // 远程目录在测试里一律断网（桩 fetch 全部 ok:false），聚合只剩登记源，断网不进外网。
  test('GET 返回 200：登记条目汇总、按包名去重', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    try {
      const shared = new Map<string, unknown>();
      const first = makeStubCtx(shared);
      integrateFeaturedPlugins(first.ctx, FEATURED_SOURCE);
      const second = makeStubCtx(shared);
      integrateFeaturedPlugins(second.ctx, {
        id: 'other-pet',
        title: 'other',
        entries: [
          { package: 'pkg-x', title: 'X', source: 'other-pet' },
          { package: 'pkg-x', title: 'X duplicated', source: 'other-pet' }, // 同包名 → 先到者优先，后者丢弃
        ],
      });
      const route = first.routes[0];
      const res = makeResStub();
      await route.handler({ method: 'GET', headers: {} }, res);
      const doc = JSON.parse(res.body()) as {
        ok: boolean;
        data: { entries: Array<{ package: string }>; sources: Array<{ id: string }> };
      };
      assert.equal(doc.ok, true);
      assert.deepEqual(
        doc.data.entries.map((e) => e.package),
        ['pkg-x'],
        '同包名去重后只剩一条',
      );
      assert.deepEqual(
        doc.data.sources.map((s) => s.id),
        ['dsh-pet', 'other-pet'],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('跨源请求 403；无 Origin（属主 curl）放行', async () => {
    const shared = new Map<string, unknown>();
    const { ctx, routes } = makeStubCtx(shared);
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE);
    const handler = routes[0].handler;
    const resForbidden = makeResStub();
    await handler({ method: 'GET', headers: { origin: 'http://evil.example', host: '127.0.0.1:1' } }, resForbidden);
    assert.equal(resForbidden.status(), 403);
    const resOk = makeResStub();
    await handler({ method: 'GET', headers: {} }, resOk);
    assert.equal(resOk.status(), 200);
  });

  test('非 GET/HEAD 返回 405', async () => {
    const shared = new Map<string, unknown>();
    const { ctx, routes } = makeStubCtx(shared);
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE);
    const res = makeResStub();
    await routes[0].handler({ method: 'POST', headers: {} }, res);
    assert.equal(res.status(), 405);
  });
});
