/**
 * 独立模式 HTTP 服务的契约测试。
 *
 * 这一层**不碰插件**（路由注入假 handler）：它钉的是独立模式自己写的那部分 ——
 * 前缀转交、运维端点（`/`、`/health`、`/shutdown`）、异常收口、端口顺延与关闭释放。
 * 插件路由表本身的契约由 integration.test.ts 覆盖（那份是真实 apply 注册出来的）。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { RegisteredRoute, StandaloneLogger } from './context.ts';
import { createRequestListener, listenStandaloneServer } from './server.ts';

/** 静默日志器（测试只断言行为） */
const silent: StandaloneLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 最小响应桩：记状态码/响应头/正文，并支持断言"已断连" */
class FakeRes {
  status = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  destroyed = false;
  private readonly chunks: string[] = [];

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    this.headersSent = true;
    return this;
  }

  end(chunk?: string): void {
    if (typeof chunk === 'string') this.chunks.push(chunk);
  }

  destroy(): void {
    this.destroyed = true;
  }

  body(): string {
    return this.chunks.join('');
  }
}

/** 用假 req/res 驱动监听器（不必真的起 socket） */
function call(listener: (req: IncomingMessage, res: ServerResponse) => void, url: string, method = 'GET'): FakeRes {
  const res = new FakeRes();
  // 只给监听器真正会读的两个字段（method/url）；其余成员本测试不触碰
  listener({ method, url } as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

/** 一个"插件式"路由：handler 自己写头与 body（与 DSH WebServer 的契约一致） */
function pluginLikeRoute(onCall?: (url: string) => void): RegisteredRoute {
  return {
    kind: 'prefix',
    path: '/dsh-pet-7340',
    handler: (req, res) => {
      onCall?.(req.url ?? '');
      const payload = JSON.stringify({ ok: true, seen: req.url });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(payload);
    },
  };
}

/** 占住一个端口，返回端口号与关闭函数 */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => res.end('busy'));
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', () => accept()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((accept) => server.close(() => accept())) };
}

describe('createRequestListener —— 转交给插件路由', () => {
  test('前缀下的请求原样交给插件 handler（URL 含前缀，由插件自己切）', () => {
    let seen = '';
    const listener = createRequestListener({ routes: [pluginLikeRoute((url) => (seen = url))], logger: silent });
    const res = call(listener, '/dsh-pet-7340/config?force=1');
    assert.equal(res.status, 200);
    assert.equal(seen, '/dsh-pet-7340/config?force=1', '插件 handler 拿到的必须是完整 URL（它自己 slice 前缀）');
    assert.equal(res.body(), JSON.stringify({ ok: true, seen: '/dsh-pet-7340/config?force=1' }));
  });

  test('前缀之外 → 404，并把已注册路由列出来（"插件没注册"要能一眼看出）', () => {
    const listener = createRequestListener({ routes: [pluginLikeRoute()], logger: silent });
    const res = call(listener, '/nope');
    assert.equal(res.status, 404);
    assert.match(res.body(), /\/dsh-pet-7340/, '404 正文应带上已注册前缀');
    assert.equal(res.headers['access-control-allow-origin'], '*', '独立模式自己写的响应带跨源头');
  });

  test('kind=exact 的路由按全等匹配，不吃子路径', () => {
    const exact: RegisteredRoute = {
      kind: 'exact',
      path: '/dsh-pet-7340/state',
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('exact');
      },
    };
    const listener = createRequestListener({ routes: [exact], logger: silent });
    assert.equal(call(listener, '/dsh-pet-7340/state').body(), 'exact');
    assert.equal(call(listener, '/dsh-pet-7340/state/extra').status, 404);
  });

  test('/ 与 /health → 运维 JSON（自定义 status 提供者）', () => {
    const listener = createRequestListener({
      routes: [],
      logger: silent,
      status: () => ({ name: 'dsh-pet-standalone', port: 3080 }),
    });
    for (const path of ['/', '/health']) {
      const res = call(listener, path);
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body()), { name: 'dsh-pet-standalone', port: 3080 });
      assert.equal(res.headers['access-control-allow-origin'], '*');
    }
  });

  test('OPTIONS → 204 + 跨源头，且不落到插件 handler', () => {
    let calls = 0;
    const listener = createRequestListener({
      routes: [pluginLikeRoute(() => (calls += 1))],
      logger: silent,
    });
    const res = call(listener, '/dsh-pet-7340/config', 'OPTIONS');
    assert.equal(res.status, 204);
    assert.equal(calls, 0, '预检不该进插件路由');
    assert.equal(res.headers['access-control-allow-headers'], 'content-type');
  });

  test('/shutdown → 先回 200，再触发收尾回调（调用方要能拿到响应）', async () => {
    const reasons: string[] = [];
    const listener = createRequestListener({
      routes: [pluginLikeRoute()],
      logger: silent,
      onShutdown: () => reasons.push('shutdown'),
    });
    const res = call(listener, '/shutdown', 'POST');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body()), { ok: true, stopping: true });
    assert.deepEqual(reasons, [], '回调必须排在响应之后（否则调用方可能等不到 200）');
    await new Promise((accept) => setImmediate(accept));
    assert.deepEqual(reasons, ['shutdown']);
  });
});

describe('createRequestListener —— 异常收口', () => {
  test('handler 抛错且未写头 → 500 JSON（与插件自身的 500 口径一致）', () => {
    const exploding: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: () => {
        throw new Error('读盘失败');
      },
    };
    const res = call(createRequestListener({ routes: [exploding], logger: silent }), '/dsh-pet-7340/config');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body()), { error: '读盘失败' });
  });

  test('handler 异步拒绝同样收口为 500', async () => {
    const exploding: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: async () => {
        throw new Error('异步失败');
      },
    };
    const res = call(createRequestListener({ routes: [exploding], logger: silent }), '/dsh-pet-7340/config');
    await new Promise((accept) => setImmediate(accept));
    assert.equal(res.status, 500);
    assert.match(res.body(), /异步失败/);
  });

  test('头已发出的失败：断连而不是写坏响应（与插件 sendFile 的错误口径一致）', () => {
    const partial: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('前半段');
        throw new Error('写一半炸了');
      },
    };
    const res = call(createRequestListener({ routes: [partial], logger: silent }), '/dsh-pet-7340/x');
    assert.equal(res.status, 200, '已经写出的头不改写');
    assert.equal(res.destroyed, true, '已写头之后必须断连');
  });
});

describe('listenStandaloneServer —— 端口与关闭', () => {
  const closers: Array<() => Promise<void>> = [];

  after(async () => {
    for (const close of closers.splice(0)) await close().catch(() => {});
  });

  test('首选端口被占用时向后顺延，关闭后端口真正释放', async () => {
    const blocker = await occupyPort();
    closers.push(blocker.close);
    const server = await listenStandaloneServer({ routes: [pluginLikeRoute()], logger: silent, port: blocker.port });
    closers.push(server.close);
    assert.ok(server.port > blocker.port, `期望顺延，实际 ${server.port}（被占 ${blocker.port}）`);

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { name?: string };
    assert.equal(body.name, 'dsh-pet-standalone');

    const port = server.port;
    await server.close();
    // 关闭必须释放端口：再用同一个端口起一个服务应成功（keep-alive 连接没被断掉的话这里会 EADDRINUSE）
    const reuse = createServer((_req, res) => res.end('reused'));
    await new Promise<void>((accept, reject) => {
      reuse.once('error', reject);
      reuse.listen(port, '127.0.0.1', () => accept());
    });
    await new Promise<void>((accept) => reuse.close(() => accept()));
  });

  test('插件路由经真实 HTTP 可用（前缀下 200，前缀外 404）', async () => {
    const server = await listenStandaloneServer({ routes: [pluginLikeRoute()], logger: silent, port: 0 });
    closers.push(server.close);
    const inside = await fetch(`http://127.0.0.1:${server.port}/dsh-pet-7340/state`);
    assert.equal(inside.status, 200);
    const outside = await fetch(`http://127.0.0.1:${server.port}/whatever`);
    assert.equal(outside.status, 404);
  });
});
