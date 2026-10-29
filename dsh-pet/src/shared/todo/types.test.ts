/**
 * 待办 wire 解析与排序的单元测试：脏数据不进渲染层，顺序以「未完成、到期近、无期限垫底」为准。
 *
 * 跑法：node --experimental-strip-types --test src/shared/todo/types.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTodoItem, parseTodoList, sortTodoItems } from './types.ts';

/** 造一条合法记录。 */
const valid = {
  id: 'todo-1',
  text: '交周报',
  dueAt: 1000,
  done: false,
  createdAt: 10,
  updatedAt: 20,
  completedAt: null,
};

describe('parseTodoItem —— 单条收窄', () => {
  test('合法记录逐字段读出', () => {
    const todo = parseTodoItem(valid);
    assert.deepEqual(todo, {
      id: 'todo-1',
      text: '交周报',
      dueAt: 1000,
      done: false,
      createdAt: 10,
      updatedAt: 20,
      completedAt: null,
    });
  });

  test('dueAt 可以缺省或 null；done 只认布尔', () => {
    assert.equal(parseTodoItem({ ...valid, dueAt: null })?.dueAt, null);
    assert.equal(parseTodoItem({ ...valid, dueAt: undefined })?.dueAt, null);
    assert.equal(parseTodoItem({ ...valid, done: 'yes' })?.done, false);
  });

  test('缺 id / 缺正文 / dueAt 非数字 → null', () => {
    assert.equal(parseTodoItem({ ...valid, id: '' }), null);
    assert.equal(parseTodoItem({ ...valid, text: 42 }), null);
    assert.equal(parseTodoItem({ ...valid, dueAt: '1000' }), null);
    assert.equal(parseTodoItem(null), null);
    assert.equal(parseTodoItem([valid]), null);
  });
});

describe('parseTodoList —— 整张清单', () => {
  test('不是数组 → 空清单；坏条目跳过，好条目保留', () => {
    assert.deepEqual(parseTodoList(null), []);
    assert.deepEqual(parseTodoList({ todos: [] }), []);
    const list = parseTodoList([valid, { id: '' }, { ...valid, id: 'todo-2' }]);
    assert.deepEqual(
      list.map((item) => item.id),
      ['todo-1', 'todo-2'],
    );
  });
});

describe('sortTodoItems —— 展示顺序', () => {
  test('未完成在前按到期先后，无期限垫底，已完成最后', () => {
    const base = { done: false, createdAt: 1, updatedAt: 1, completedAt: null as number | null };
    const list = sortTodoItems([
      { ...base, id: 'done', text: '已完成', dueAt: 1, done: true, completedAt: 9 },
      { ...base, id: 'undated', text: '无期限', dueAt: null },
      { ...base, id: 'late', text: '晚', dueAt: 300 },
      { ...base, id: 'early', text: '早', dueAt: 200 },
    ]);
    assert.deepEqual(
      list.map((item) => item.id),
      ['early', 'late', 'undated', 'done'],
    );
  });

  test('同一到期时刻按创建先后', () => {
    const list = sortTodoItems([
      { id: 'b', text: 'b', dueAt: 5, done: false, createdAt: 2, updatedAt: 2, completedAt: null },
      { id: 'a', text: 'a', dueAt: 5, done: false, createdAt: 1, updatedAt: 1, completedAt: null },
    ]);
    assert.deepEqual(
      list.map((item) => item.id),
      ['a', 'b'],
    );
  });
});
