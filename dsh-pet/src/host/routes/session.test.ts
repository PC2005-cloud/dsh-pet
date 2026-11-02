/**
 * 会话跳转端点（`POST /focus-session`）：出入参分档与叶子写入。
 *
 * 只测端点自己的判断和写入结果；页面怎么消费这条信号不在本文件范围。
 * 跑法：node --experimental-strip-types --test src/host/routes/session.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSessionRoutes } from './session.ts';
import { PollStateStore } from '../state.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps } from './types.ts';

/** 路由只用到 state，其余依赖本领域不读，测试里不构造。 */
function makeDeps(): { deps: PetRouteDeps; state: PollStateStore } {
  const state = new PollStateStore();
  return { deps: { state } as unknown as PetRouteDeps, state };
}

/** 调一次端点；`rest` 默认是干净的 `focus-session`。 */
function call(
  deps: PetRouteDeps,
  method: string,
  body?: string,
  rest = 'focus-session',
): Promise<RouteResult | undefined> {
  return handleSessionRoutes(deps, { url: new URL('http://localhost/focus-session'), rest, method, body });
}

/** 断言是 JSON 应答并取出状态码与响应体。 */
function asJson(result: RouteResult | undefined): { status: number; obj: Record<string, unknown> } {
  assert.ok(result !== undefined, '处理器应给出应答');
  assert.equal(result.kind, 'json');
  return { status: result.status, obj: result.obj as Record<string, unknown> };
}

describe('handleSessionRoutes —— 路径与方法', () => {
  test('非 focus-session 路径 → undefined（交给下一个处理器）', async () => {
    const { deps } = makeDeps();
    assert.equal(await call(deps, 'POST', '{}', 'other'), undefined);
  });

  test('非 POST → 405', async () => {
    const { deps } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'GET'));
    assert.equal(status, 405);
    assert.equal(obj.reason, 'method-not-allowed');
  });
});

describe('handleSessionRoutes —— 输入校验', () => {
  test('请求体不是 JSON → 400 invalid-json', async () => {
    const { deps } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'POST', 'not json'));
    assert.equal(status, 400);
    assert.equal(obj.reason, 'invalid-json');
  });

  test('缺 sessionId → bad-request，且不写叶子', async () => {
    const { deps, state } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'POST', '{}'));
    assert.equal(status, 200);
    assert.equal(obj.reason, 'bad-request');
    assert.equal(state.read().sections.focusSession.data, null, '校验失败不该留下半条信号');
  });

  test('sessionId 为空串 / 纯空白 / unknown → bad-request', async () => {
    const { deps } = makeDeps();
    for (const body of ['{"sessionId":""}', '{"sessionId":"   "}', '{"sessionId":"unknown"}']) {
      assert.equal(asJson(await call(deps, 'POST', body)).obj.reason, 'bad-request');
    }
  });

  test('sessionId 不是字符串 → bad-request', async () => {
    const { deps } = makeDeps();
    assert.equal(asJson(await call(deps, 'POST', '{"sessionId":42}')).obj.reason, 'bad-request');
  });

  test('sessionId 超过 128 字符 → bad-request', async () => {
    const { deps } = makeDeps();
    const body = JSON.stringify({ sessionId: 'x'.repeat(129) });
    assert.equal(asJson(await call(deps, 'POST', body)).obj.reason, 'bad-request');
  });
});

describe('handleSessionRoutes —— 写 sections.focusSession', () => {
  test('成功 → 200 ok，并把 sessionId 与 ts 写进快照', async () => {
    const { deps, state } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'POST', '{"sessionId":"session-abc"}'));
    assert.equal(status, 200);
    assert.equal(obj.ok, true);
    const leaf = state.read().sections.focusSession;
    assert.deepEqual(leaf.data, { sessionId: 'session-abc', ts: obj.ts });
    assert.ok(leaf.counter > 0, '写入必须推进 counter，否则页面拿不到变化');
  });

  test('首尾空白被裁掉后落库', async () => {
    const { deps, state } = makeDeps();
    await call(deps, 'POST', '{"sessionId":"  session-abc  "}');
    const data = state.read().sections.focusSession.data as { sessionId: string };
    assert.equal(data.sessionId, 'session-abc');
  });

  test('连续两次 → 后一次覆盖前一次，ts 不回退', async () => {
    const { deps, state } = makeDeps();
    await call(deps, 'POST', '{"sessionId":"session-one"}');
    const first = state.read().sections.focusSession.data as { ts: number };
    await call(deps, 'POST', '{"sessionId":"session-two"}');
    const second = state.read().sections.focusSession.data as { sessionId: string; ts: number };
    assert.equal(second.sessionId, 'session-two');
    assert.ok(second.ts >= first.ts, 'ts 用于消费端判重，不允许回退');
  });
});
