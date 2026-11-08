/**
 * 「吃白饭」菜单控制器的契约测试 —— 钉住三个判定：读点击的三种输入、注册菜单的前置条件、
 * 点播归属条目的查找。这三个判定不碰 DOM，是这段逻辑里唯一能脱离浏览器断言的部分。
 *
 * 假传输层与假演出只实现被调用的成员；`retryMs` 传负数，让首拍必定进入补注册分支。
 *
 * 跑法：node --experimental-strip-types --test src/client/baifan/menu.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { ActivityAssets } from './assets.ts';
import { createMenu } from './menu.ts';
import type { Show } from './show.ts';
import type { Transport } from './transport.ts';

/** 记录一次接口调用。 */
interface CallRecord {
  /** HTTP 方法。 */
  method: string;
  /** 路径（不含前缀）。 */
  path: string;
  /** 请求体（有则记录）。 */
  body?: unknown;
}

/** 假传输层：只实现 `call`，其余成员给空实现。 */
function fakeTransport(reply: (rec: CallRecord) => Record<string, unknown>): {
  transport: Transport;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const transport: Transport = {
    attach: () => {},
    call: async (method, path, body) => {
      const rec: CallRecord = { method, path };
      if (body !== undefined) rec.body = body;
      calls.push(rec);
      return reply(rec);
    },
    pose: () => null,
    progress: () => null,
    waitPlayback: async () => ({ status: 'gone' }),
  };
  return { transport, calls };
}

/** 假演出：只记录开演请求。 */
function fakeShow(): { show: Show; starts: Array<{ petId: string; assets: ActivityAssets }> } {
  const starts: Array<{ petId: string; assets: ActivityAssets }> = [];
  const show: Show = {
    start: (petId, assets) => {
      starts.push({ petId, assets });
    },
    halt: async () => {},
    isRunning: () => false,
  };
  return { show, starts };
}

/** 等异步链跑完：`launch` 里只有一次 await，两轮 setImmediate 足够。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 造一份默认依赖；`get` 的返回值按用例覆盖。 */
function makeMenu(get: (name: string) => unknown, transport: Transport, show: Show): ReturnType<typeof createMenu> {
  return createMenu({
    get,
    transport,
    show,
    signal: new AbortController().signal,
    // 负数：`performance.now() - 0` 恒大于它，首拍必定进入补注册分支。
    retryMs: -1,
  });
}

describe('createMenu', () => {
  test('读点击：页面内服务缺失 → 补注册菜单，不点播', async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true }));
    const { show, starts } = fakeShow();
    const menu = makeMenu(() => undefined, transport, show);

    menu.tick();
    await flush();

    assert.deepEqual(
      calls.map((rec) => rec.method + ' ' + rec.path),
      ['GET /config'],
      '服务缺失时应只补注册，不应发生点播',
    );
    assert.equal(starts.length, 0, '没有点击就不该开演');
  });

  test('读点击：owner 还没进快照（ok:false）→ 补注册菜单', async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true }));
    const { show } = fakeShow();
    const menu = makeMenu(() => ({ menuEvents: () => ({ ok: false }) }), transport, show);

    menu.tick();
    await flush();

    assert.deepEqual(
      calls.map((rec) => rec.method + ' ' + rec.path),
      ['GET /config'],
      'owner 不在快照里时按间隔重试注册',
    );
  });

  test('读点击：命中「吃白饭」→ 按 petId 找归属条目并开演', async () => {
    const { transport, calls } = fakeTransport(() => ({
      main: { pets: [{ id: 'pet-1' }], animations: { baifan: ['a', 'b'] } },
    }));
    const { show, starts } = fakeShow();
    const menu = makeMenu(() => ({ menuEvents: () => ({ ok: true, events: { 吃白饭: 'pet-1' } }) }), transport, show);

    menu.tick();
    await flush();

    assert.deepEqual(
      calls.map((rec) => rec.method + ' ' + rec.path),
      ['GET /config'],
      '命中后只读一次配置，不再补注册',
    );
    assert.equal(starts.length, 1, '找到归属条目应开演一次');
    assert.equal(starts[0].petId, 'pet-1', '开演的是被点的那只宠物');
  });

  test('注册菜单：main 没配 animations.baifan → 不发 POST', async () => {
    const { transport, calls } = fakeTransport(() => ({ main: { animations: {} } }));
    const { show } = fakeShow();
    const menu = makeMenu(() => undefined, transport, show);

    await menu.ensureMenu();

    assert.deepEqual(
      calls.map((rec) => rec.method + ' ' + rec.path),
      ['GET /config'],
      '没有这个玩法就不该往宿主注册菜单项',
    );
  });

  test('注册菜单：配了 animations.baifan → POST 带上 owner', async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, main: { animations: { baifan: ['a'] } } }));
    const { show } = fakeShow();
    const menu = makeMenu(() => undefined, transport, show);

    await menu.ensureMenu();

    const post = calls.find((rec) => rec.method === 'POST');
    assert.ok(post !== undefined, '配了玩法应发 POST /menu/item');
    assert.equal(post.path, '/menu/item');
    assert.deepEqual((post.body as Record<string, unknown>).owner, 'dsh-pet-baifan', '菜单项 owner 固定为吃白饭');
  });

  test('点播：被点的宠物不属于任何条目 → 不开演', async () => {
    const { transport } = fakeTransport(() => ({ main: { pets: [{ id: 'other' }], animations: { baifan: ['a'] } } }));
    const { show, starts } = fakeShow();
    const menu = makeMenu(() => ({ menuEvents: () => ({ ok: true, events: { 吃白饭: 'pet-1' } }) }), transport, show);

    menu.tick();
    await flush();

    assert.equal(starts.length, 0, '找不到归属条目就不演');
  });

  test('dispose 后：不再读点击', async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true }));
    const { show } = fakeShow();
    const menu = makeMenu(() => ({ menuEvents: () => ({ ok: true, events: { 吃白饭: 'pet-1' } }) }), transport, show);

    menu.dispose();
    menu.tick();
    await flush();

    assert.equal(calls.length, 0, '卸载后不应再发请求');
  });
});
