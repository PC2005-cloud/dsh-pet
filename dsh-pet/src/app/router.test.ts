import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import type { RegisteredRoute } from '../standalone/context.ts';
import { createRequestSecurity } from '../standalone/request-security.ts';
import { MAX_REQUEST_BYTES, MAX_SETTINGS_BYTES } from '../standalone/request-body.ts';
import { startRouter } from './router.ts';

async function start(
  routes: RegisteredRoute[] = [],
  log: (message: string) => void = () => {},
  chatPanelScript?: () => string | undefined,
) {
  const security = createRequestSecurity();
  const server = await startRouter(routes, {
    security,
    log,
    status: (port) => ({ audit: true, port }),
    landingPage: () => '<html>local app</html>',
    ...(chatPanelScript ? { chatPanelScript } : {}),
  });
  return { ...server, security, base: `http://127.0.0.1:${server.port}` };
}

test('app rejects untrusted file origins and hosts while authenticated desktop calls still work', async () => {
  let calls = 0;
  const server = await start([
    {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: async (req, res) => {
        calls++;
        let body = '';
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: Buffer) => {
            body += String(chunk);
          });
          req.on('end', () => resolve());
          req.on('error', reject);
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ body }));
      },
    },
  ]);
  try {
    const path = server.base + '/dsh-pet-7340/chat';
    const token = { 'X-DSH-Pet-Token': server.security.token };
    const blockedHeaders: Array<Record<string, string>> = [
      { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
      { ...token, Origin: 'https://evil.test' },
    ];
    for (const method of ['GET', 'POST']) {
      for (const headers of blockedHeaders) {
        const response = await fetch(path, { method, headers });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
        await response.text();
      }
    }
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(path, { headers: { ...token, Origin: 'null', Host: 'evil.test' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal(calls, 0);
    const response = await fetch(path, {
      method: 'POST',
      headers: { ...token, Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
      body: '{"dummy":true}',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { body: '{"dummy":true}' });
    assert.equal(calls, 1);
    const media = await fetch(server.base + '/dsh-pet-7340/thumb/main/test.webm', {
      headers: { ...token, 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(media.status, 200);
    await media.text();
    assert.equal(calls, 2);
    // 文件来源例外不适用于 AI 设置端点。
    assert.equal(
      (await fetch(server.base + '/standalone-ai/settings', { headers: { ...token, Origin: 'null' } })).status,
      403,
    );
    for (const encoded of ['%63hat', 'ch%61t']) {
      assert.equal((await fetch(server.base + '/dsh-pet-7340/' + encoded)).status, 403);
    }
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test('invalid URL and percent encodings return 400 and leave the app service available', async () => {
  const server = await start();
  try {
    const malformed = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.port, path: '//[' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(malformed, 400);
    assert.equal(
      (await fetch(server.base + '/dsh-pet-7340/%ZZ', { headers: { 'X-DSH-Pet-Token': server.security.token } }))
        .status,
      400,
    );
    const health = await fetch(server.base + '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { audit: true, port: server.port });
    assert.equal(await (await fetch(server.base)).text(), '<html>local app</html>');
    const shell = await fetch(server.base + '/standalone-ai/');
    assert.equal(shell.status, 200);
    assert.ok(!(await shell.text()).includes(server.security.token));
  } finally {
    await server.close();
  }
});

test('app caps request bodies before plugins/settings and catches synchronous and async handler failures', async () => {
  let calls = 0;
  const logs: string[] = [];
  const server = await start(
    [
      {
        kind: 'prefix',
        path: '/dsh-pet-7340',
        handler: (req) => {
          calls++;
          if (req.url?.endsWith('/async')) return Promise.reject(new Error('PRIVATE_SENTINEL'));
          throw new Error('PRIVATE_SENTINEL');
        },
      },
    ],
    (message) => logs.push(message),
  );
  try {
    const headers = { 'X-DSH-Pet-Token': server.security.token };
    for (const [path, bytes] of [
      ['/dsh-pet-7340/config', MAX_REQUEST_BYTES],
      ['/standalone-ai/settings', MAX_SETTINGS_BYTES],
    ] as const) {
      const response = await fetch(server.base + path, { method: 'POST', headers, body: 'x'.repeat(bytes + 1) });
      assert.equal(response.status, 413);
      await response.text();
    }
    assert.equal(calls, 0);
    for (const path of ['/sync', '/async']) {
      const response = await fetch(server.base + '/dsh-pet-7340' + path, { headers });
      assert.equal(response.status, 500);
      assert.ok(!(await response.text()).includes('PRIVATE_SENTINEL'));
    }
    assert.equal(calls, 2);
    assert.equal(logs.length, 2);
    assert.ok(!logs.join('').includes('PRIVATE_SENTINEL'));
    assert.equal((await fetch(server.base + '/health')).status, 200);
  } finally {
    await server.close();
  }
});

test('设置页对话面板脚本：有产物时由 app 路由提供 → 200 且类型与内容正确', async () => {
  const script = 'window.__CHAT_PANEL__ = 1;';
  const server = await start(
    [],
    () => {},
    () => script,
  );
  try {
    const response = await fetch(server.base + '/standalone-ai/chat-panel.js');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(await response.text(), script);
  } finally {
    await server.close();
  }
});

test('设置页对话面板脚本：产物缺失时 → 404 并提示重新构建，而不是静默回空脚本', async () => {
  const server = await start(
    [],
    () => {},
    () => undefined,
  );
  try {
    const response = await fetch(server.base + '/standalone-ai/chat-panel.js');
    assert.equal(response.status, 404);
    assert.match(await response.text(), /重新构建/);
  } finally {
    await server.close();
  }
});
