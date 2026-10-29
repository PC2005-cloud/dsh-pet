/**
 * 待办持久化的单元测试 —— 钉住四件事：
 *   ① 建 / 改 / 删 / 记提醒 的语义，尤其是「改期限与重新打开会重置提醒排期」；
 *   ② 磁盘是唯一真相：换一个新实例仍能读回同一条待办，且文件带版本号；
 *   ③ 所有操作串行：并发创建不丢记录、id 不重复；
 *   ④ 坏文件不炸：解析失败按空清单继续并留告警，下一次写入自然覆盖。
 *
 * 跑法：node --experimental-strip-types --test src/host/todo/store.test.ts
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TodoStore, type TodoStoreOptions } from './store.ts';
import { TODO_FILE_VERSION } from './types.ts';

/** 告警出口：收集起来断言「坏文件有留痕」，不真的写日志。 */
const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) };

let dir = '';
/** 固定时钟：测试自己推进，避免依赖真实时间。 */
let clock = 1_000_000;
/** 每个用例一个独立文件，互不串数据。 */
let file = '';
let caseSeq = 0;

/** 造一个用固定时钟与当前用例临时文件的 store。 */
function makeStore(overrides: Partial<TodoStoreOptions> = {}): TodoStore {
  return new TodoStore({ file, log, now: () => clock, ...overrides });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-todo-'));
});

beforeEach(() => {
  clock = 1_000_000;
  caseSeq += 1;
  file = join(dir, `todos-${caseSeq}.json`);
  warnings.length = 0;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TodoStore —— 增删改查', () => {
  test('新建后可读回：未完成、未提醒、带创建时间', async () => {
    const store = makeStore();
    const created = await store.create({ text: '交周报', dueAt: 2_000_000 });
    assert.equal(created.text, '交周报');
    assert.equal(created.dueAt, 2_000_000);
    assert.equal(created.done, false);
    assert.equal(created.createdAt, clock);
    assert.equal(created.lastRemindedAt, null);
    const list = await store.list();
    assert.deepEqual(
      list.map((item) => item.id),
      [created.id],
    );
  });

  test('落盘文件带版本号，新实例能读回同一条', async () => {
    const store = makeStore();
    const created = await store.create({ text: '买菜', dueAt: null });
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; todos: Array<{ id: string }> };
    assert.equal(raw.version, TODO_FILE_VERSION);
    assert.equal(raw.todos[0]?.id, created.id);
    const reloaded = await makeStore().list();
    assert.deepEqual(
      reloaded.map((item) => item.id),
      [created.id],
    );
  });

  test('完成 → 记 completedAt；重新打开 → 清完成时刻并重置提醒', async () => {
    const store = makeStore();
    const created = await store.create({ text: '回邮件', dueAt: null });
    await store.markReminded(created.id, clock);
    clock += 1000;
    const done = await store.update(created.id, { done: true });
    assert.equal(done?.done, true);
    assert.equal(done?.completedAt, clock);
    clock += 1000;
    const reopened = await store.update(created.id, { done: false });
    assert.equal(reopened?.done, false);
    assert.equal(reopened?.completedAt, null);
    assert.equal(reopened?.lastRemindedAt, null);
  });

  test('改期限会清掉上次提醒时刻，按新期限重新排期', async () => {
    const store = makeStore();
    const created = await store.create({ text: '体检', dueAt: 9_000_000 });
    await store.markReminded(created.id, clock);
    const moved = await store.update(created.id, { dueAt: 8_000_000, text: '体检（改约）' });
    assert.equal(moved?.dueAt, 8_000_000);
    assert.equal(moved?.text, '体检（改约）');
    assert.equal(moved?.lastRemindedAt, null);
  });

  test('更新不存在的 id → null；删除幂等', async () => {
    const store = makeStore();
    assert.equal(await store.update('todo-missing', { done: true }), null);
    assert.equal(await store.remove('todo-missing'), 0);
    const created = await store.create({ text: '倒垃圾', dueAt: null });
    assert.equal(await store.remove(created.id), 1);
    assert.equal(await store.remove(created.id), 0);
    assert.equal((await store.list()).length, 0);
  });

  test('markReminded 只动提醒时刻，不推进 updatedAt', async () => {
    const store = makeStore();
    const created = await store.create({ text: '浇水', dueAt: 5_000_000 });
    const at = created.updatedAt + 500;
    await store.markReminded(created.id, at);
    const list = await store.list();
    assert.equal(list[0]?.lastRemindedAt, at);
    assert.equal(list[0]?.updatedAt, created.updatedAt);
  });
});

describe('TodoStore —— 排序与并发', () => {
  test('未完成在前按到期先后，无期限垫底，已完成最后', async () => {
    const store = makeStore();
    const undated = await store.create({ text: '无期限', dueAt: null });
    const late = await store.create({ text: '晚点', dueAt: 3_000_000 });
    const early = await store.create({ text: '早点', dueAt: 2_000_000 });
    await store.update(late.id, { done: true });
    const list = await store.list();
    assert.deepEqual(
      list.map((item) => item.text),
      ['早点', '无期限', '晚点'],
    );
    assert.equal(list[0]?.id, early.id);
    assert.equal(list[1]?.id, undated.id);
    assert.equal(list[2]?.done, true);
  });

  test('并发创建不丢记录且 id 唯一', async () => {
    const store = makeStore();
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.create({ text: `事项${index}`, dueAt: null })),
    );
    assert.equal(new Set(created.map((item) => item.id)).size, 20);
    assert.equal((await makeStore().list()).length, 20);
  });
});

describe('TodoStore —— 坏文件', () => {
  test('JSON 坏掉时按空清单继续，并留一条告警', async () => {
    writeFileSync(file, '{ not json', 'utf8');
    const store = makeStore();
    assert.deepEqual(await store.list(), []);
    assert.ok(warnings.some((line) => line.includes('解析失败')));
    // 下一次写入自然覆盖：不再有坏文件
    await store.create({ text: '恢复', dueAt: null });
    assert.equal((await store.list()).length, 1);
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
  });

  test('字段非法的条目被整条丢弃，合法条目保留', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        todos: [
          { id: 'ok-1', text: '保留', dueAt: null, done: false, createdAt: 1, updatedAt: 1 },
          { id: 'bad id', text: '非法 id', dueAt: null },
          { id: 'ok-2', text: '   ', dueAt: null },
        ],
      }),
      'utf8',
    );
    const list = await makeStore().list();
    assert.deepEqual(
      list.map((item) => item.id),
      ['ok-1'],
    );
  });
});
