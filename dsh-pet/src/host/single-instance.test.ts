/**
 * 单实例唤回 —— 宿主侧纯逻辑（ticket 05）。
 *
 * 第二个启动请求到达时，宿主已有一个跑着的桌面壳；唤回必须复用壳的 bridge 回调通道：
 *   1. `callbackControlUrl`：从 helper 每条协议行携带的 `cb`（`.../respond`）推导控制端点；
 *   2. `waitForControlUrl`：helper 的首条请求可能晚于 `second-instance` 到达，
 *      在有限时间内轮询等待（时钟与 sleep 可注入，测试不依赖真实等待）；
 *   3. `createFocusGate`：自启实例延迟启动期间收到的唤回请求记为 pending，
 *      启动完成（`markReady`）后只执行一次——延迟不能被手动双击提前打断。
 *
 * 这里不碰 Electron、不发真实请求；接线契约由 single-instance-wiring.test.ts 与安装版实测覆盖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HelperProcess, focusDesktopWindows } from './helper-process.ts';
import { callbackControlUrl, createFocusGate, waitForControlUrl } from './single-instance.ts';

describe('callbackControlUrl —— cb → 控制端点', () => {
  test('保留 origin，把 /respond 换成 /control', () => {
    assert.equal(callbackControlUrl('http://127.0.0.1:54321/respond'), 'http://127.0.0.1:54321/control');
  });

  test('cb 带查询串/其它路径时仍只取 origin', () => {
    assert.equal(callbackControlUrl('http://127.0.0.1:54321/respond?x=1'), 'http://127.0.0.1:54321/control');
  });

  test('缺失或非 http(s) 的 cb 一律忽略（旧版 helper 不参与唤回）', () => {
    for (const cb of [undefined, '', 'not a url', 'file:///tmp/respond', '/respond']) {
      assert.equal(callbackControlUrl(cb), undefined, `cb=${JSON.stringify(cb)} 不应产出控制端点`);
    }
  });
});

describe('waitForControlUrl —— cb 未就绪时的有限等待', () => {
  /** 可注入的假时钟：sleep 推进时间并记录每次等待 */
  function fakeClock() {
    const state = { time: 0, sleeps: [] as number[] };
    return {
      ...state,
      options: {
        waitMs: 200,
        intervalMs: 50,
        now: () => state.time,
        sleep: async (ms: number) => {
          state.sleeps.push(ms);
          state.time += ms;
        },
      },
      sleeps: () => state.sleeps,
    };
  }

  test('cb 已就绪：立即返回，不等待', async () => {
    const clock = fakeClock();
    const url = await waitForControlUrl(() => 'http://127.0.0.1:1/control', clock.options);
    assert.equal(url, 'http://127.0.0.1:1/control');
    assert.deepEqual(clock.sleeps(), []);
  });

  test('cb 在等待期内出现：返回它（第 3 次轮询）', async () => {
    const clock = fakeClock();
    let polls = 0;
    const url = await waitForControlUrl(() => (++polls >= 3 ? 'http://127.0.0.1:2/control' : undefined), clock.options);
    assert.equal(url, 'http://127.0.0.1:2/control');
    assert.deepEqual(clock.sleeps(), [50, 50], '前两次未就绪只需要等两个间隔');
  });

  test('等待期内始终没有 cb：到点返回 undefined，绝无限挂起', async () => {
    const clock = fakeClock();
    const url = await waitForControlUrl(() => undefined, clock.options);
    assert.equal(url, undefined);
    assert.deepEqual(clock.sleeps(), [50, 50, 50, 50], '200ms / 50ms = 4 次等待后到点');
  });

  test('waitMs = 0：只查一次，不 sleep', async () => {
    const clock = fakeClock();
    const url = await waitForControlUrl(() => undefined, { ...clock.options, waitMs: 0 });
    assert.equal(url, undefined);
    assert.deepEqual(clock.sleeps(), []);
  });
});

describe('createFocusGate —— 启动完成前后的唤回时序', () => {
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  test('启动完成前的请求记为 pending：不提前唤回，完成后只执行一次', async () => {
    const calls: string[] = [];
    const gate = createFocusGate({ focus: async () => calls.push('focus') });
    gate.request();
    gate.request();
    await settle();
    assert.deepEqual(calls, [], '启动未完成时不得唤回（自启延迟期间手动双击不能提前弹窗）');

    gate.markReady();
    await settle();
    assert.deepEqual(calls, ['focus'], 'pending 请求合并成一次唤回');
  });

  test('启动完成后的请求立即执行（每次二次启动都唤回）', async () => {
    const calls: number[] = [];
    const gate = createFocusGate({ focus: async () => calls.push(calls.length + 1) });
    gate.markReady();
    gate.request();
    gate.request();
    await settle();
    assert.deepEqual(calls, [1, 2]);
  });

  test('markReady 幂等：重复标记不会重复执行 pending', async () => {
    const calls: string[] = [];
    const gate = createFocusGate({ focus: async () => calls.push('focus') });
    gate.request();
    gate.markReady();
    gate.markReady();
    await settle();
    assert.deepEqual(calls, ['focus']);
  });

  test('唤回失败走 onError，不产生未处理拒绝', async () => {
    const errors: unknown[] = [];
    const gate = createFocusGate({
      focus: async () => {
        throw new Error('helper not ready');
      },
      onError: (error) => errors.push(error),
    });
    gate.markReady();
    gate.request();
    await settle();
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /helper not ready/);
  });
});

describe('HelperProcess.focusWindows —— 记录 cb 并反向 POST /control', () => {
  test('helper 首条协议行带来 cb，唤回请求打到同一端口的 /control', { timeout: 15_000 }, async (t) => {
    const received: Array<{ method?: string; url?: string; body?: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body: raw });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
        res.end('{"ok":true,"focused":2}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-focus-'));
    const line = {
      id: 1,
      method: 'GET',
      url: '/dsh-pet-7340/config',
      cb: `http://127.0.0.1:${port}/respond`,
    };
    const script =
      `process.stdout.write(${JSON.stringify('dsh-pet-bridge:' + JSON.stringify(line) + '\n')});` +
      'setInterval(() => {}, 1000);';
    const helper = new HelperProcess(
      {
        command: process.execPath,
        args: ['-e', script],
        cwd: dir,
        bridgeHandler: async (req) => ({ id: req.id, status: 200, contentType: 'text/plain', body: 'ok' }),
      },
      { debug: () => {}, warn: () => {} },
    );
    const child = helper.start()!;
    // 单一清理钩子：先停子进程（否则 Windows 不会允许删除它作为 cwd 的目录），再收服务
    t.after(async () => {
      await helper.stopAndWait('test-cleanup', 100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await once(child, 'spawn');

    // 立即调用：此刻 cb 可能还没被 stdout 解析，focusWindows 必须等它出现而不是直接失败
    assert.equal(await focusDesktopWindows({ waitMs: 2000 }), true);
    assert.deepEqual(
      received.filter((entry) => entry.url === '/control'),
      [{ method: 'POST', url: '/control', body: '{"action":"focus"}' }],
    );
  });

  test('等不到 cb 时有限等待后返回 false（不挂住宿主）', async (t) => {
    const warnings: string[] = [];
    const helper = new HelperProcess({}, { warn: (message) => warnings.push(String(message)) });
    t.after(() => helper.stop('test-cleanup'));
    const startedAt = Date.now();
    assert.equal(await helper.focusWindows({ waitMs: 30, intervalMs: 10 }), false);
    assert.ok(Date.now() - startedAt < 1000, '必须在 waitMs 附近返回');
    assert.ok(
      warnings.some((line) => line.includes('唤回')),
      '失败要留下可排查的告警',
    );
  });
});
