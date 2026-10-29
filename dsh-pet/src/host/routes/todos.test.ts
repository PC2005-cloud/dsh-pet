/**
 * /todos 路由处理器的单元测试 —— 钉住协议边界：
 *   ① 增删改查的响应形状与 HTTP 语义（业务失败 200、协议失败保留 4xx）；
 *   ② 输入校验（空正文、超长正文、非法到期时刻、PATCH 没有任何字段、体超限）；
 *   ③ 只接管 todos 前缀，其它路径返回 undefined 让下一个处理器接手。
 *
 * 不覆盖真实 HTTP 管道（读体、写响应）：那是 /state 与本测试共同的宿主层，见 src/host/routes.test.ts。
 * 跑法：node --experimental-strip-types --test src/host/routes/todos.test.ts
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleTodoRoutes } from './todos.ts';
import { TodoStore } from '../todo/store.ts';
import { TODO_BODY_MAX_BYTES } from '../todo/types.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps } from './types.ts';

let dir = '';
let file = '';
let caseSeq = 0;
let clock = 1_000_000;
let store: TodoStore;

/** 路由只读 deps.todos 与 deps.log：其余字段不参与本领域，测试里不构造。 */
const deps = (): PetRouteDeps => ({ todos: store, log: { warn: () => undefined } }) as unknown as PetRouteDeps;

/** 调一次处理器；rest 已去掉前缀。 */
function call(method: string, rest: string, body?: string): Promise<RouteResult | undefined> {
  return handleTodoRoutes(deps(), { url: new URL('http://localhost/'), rest, method, body });
}

/** 断言是 JSON 应答并取出状态码与响应体。 */
function asJson(result: RouteResult | undefined): { status: number; obj: Record<string, unknown> } {
  assert.ok(result !== undefined, '处理器应给出应答');
  assert.equal(result.kind, 'json');
  return { status: result.status, obj: result.obj as Record<string, unknown> };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-todo-route-'));
});

beforeEach(() => {
  clock = 1_000_000;
  caseSeq += 1;
  file = join(dir, `todos-${caseSeq}.json`);
  store = new TodoStore({ file, log: { warn: () => undefined }, now: () => clock });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleTodoRoutes —— 路径归属', () => {
  test('非 todos 前缀 → undefined（交给下一个处理器）', async () => {
    assert.equal(await call('GET', 'state'), undefined);
    assert.equal(await call('GET', 'todosomething'), undefined);
  });
});

describe('handleTodoRoutes —— 读与建', () => {
  test('GET 空清单 → 200 + 空数组', async () => {
    const { status, obj } = asJson(await call('GET', 'todos'));
    assert.equal(status, 200);
    assert.deepEqual(obj, { ok: true, todos: [] });
  });

  test('POST 建一条：正文已 trim，到期时刻原样带回', async () => {
    const { status, obj } = asJson(await call('POST', 'todos', JSON.stringify({ text: '  交周报  ', dueAt: 5_000 })));
    assert.equal(status, 200);
    const todo = obj.todo as Record<string, unknown>;
    assert.equal(todo.text, '交周报');
    assert.equal(todo.dueAt, 5_000);
    assert.equal(todo.done, false);
    const listed = asJson(await call('GET', 'todos')).obj.todos as unknown[];
    assert.equal(listed.length, 1);
  });

  test('POST 不带 dueAt → 无期限', async () => {
    const todo = asJson(await call('POST', 'todos', JSON.stringify({ text: '记一下' }))).obj.todo as Record<
      string,
      unknown
    >;
    assert.equal(todo.dueAt, null);
  });

  test('POST 空正文 / 超长正文 / 非法 dueAt → 200 + bad-request', async () => {
    for (const body of [
      JSON.stringify({ text: '   ' }),
      JSON.stringify({ text: 'x'.repeat(201) }),
      JSON.stringify({ text: '正常', dueAt: 'soon' }),
      JSON.stringify({ text: '正常', dueAt: {} }),
    ]) {
      const { status, obj } = asJson(await call('POST', 'todos', body));
      assert.equal(status, 200);
      assert.equal(obj.ok, false);
      assert.equal(obj.reason, 'bad-request');
    }
  });

  test('POST 非法 JSON / 数组体 → 400 invalid-json', async () => {
    for (const body of ['not json', '[1,2]']) {
      const { status, obj } = asJson(await call('POST', 'todos', body));
      assert.equal(status, 400);
      assert.equal(obj.reason, 'invalid-json');
    }
  });

  test('请求体超限 → 413 payload-too-large', async () => {
    const body = JSON.stringify({ text: 'x'.repeat(TODO_BODY_MAX_BYTES) });
    const result = await call('POST', 'todos', body);
    const { status, obj } = asJson(result);
    assert.equal(status, 413);
    assert.equal(obj.reason, 'payload-too-large');
  });
});

describe('handleTodoRoutes —— 改与删', () => {
  test('PATCH 勾选完成 → done 与 completedAt 一起返回', async () => {
    const created = asJson(await call('POST', 'todos', JSON.stringify({ text: '回邮件' }))).obj.todo as Record<
      string,
      unknown
    >;
    clock += 1000;
    const { status, obj } = asJson(await call('PATCH', `todos/${String(created.id)}`, JSON.stringify({ done: true })));
    assert.equal(status, 200);
    const todo = obj.todo as Record<string, unknown>;
    assert.equal(todo.done, true);
    assert.equal(todo.completedAt, clock);
  });

  test('PATCH 未知名 → 200 + todo-not-found', async () => {
    const { obj } = asJson(await call('PATCH', 'todos/todo-missing', JSON.stringify({ done: true })));
    assert.equal(obj.ok, false);
    assert.equal(obj.reason, 'todo-not-found');
  });

  test('PATCH 没有任何字段 / 字段非法 → bad-request', async () => {
    const created = asJson(await call('POST', 'todos', JSON.stringify({ text: '散步' }))).obj.todo as Record<
      string,
      unknown
    >;
    const id = String(created.id);
    for (const body of ['{}', JSON.stringify({ done: 'yes' }), JSON.stringify({ text: '' })]) {
      const { obj } = asJson(await call('PATCH', `todos/${id}`, body));
      assert.equal(obj.ok, false);
      assert.equal(obj.reason, 'bad-request');
    }
  });

  test('DELETE 幂等：第一次 removed=1，第二次 removed=0', async () => {
    const created = asJson(await call('POST', 'todos', JSON.stringify({ text: '倒垃圾' }))).obj.todo as Record<
      string,
      unknown
    >;
    const id = String(created.id);
    assert.equal(asJson(await call('DELETE', `todos/${id}`)).obj.removed, 1);
    assert.equal(asJson(await call('DELETE', `todos/${id}`)).obj.removed, 0);
  });

  test('不合法 id 与方法 → 业务/协议失败各有其形状', async () => {
    assert.equal(asJson(await call('DELETE', 'todos/a/b')).obj.reason, 'bad-request');
    const { status, obj } = asJson(await call('GET', 'todos/todo-1'));
    assert.equal(status, 405);
    assert.equal(obj.reason, 'method-not-allowed');
  });
});
