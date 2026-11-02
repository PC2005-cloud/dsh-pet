/**
 * 工作状态叶子解析：`sessionId` 是新增的可选字段，老宿主不写、外部槽写 null。
 *
 * 只测解析边界——聚合与优先级归 host/work-status.test.ts。
 * 跑法：node --experimental-strip-types --test src/shared/work-status.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { toWorkStatus } from './work-status.ts';

describe('toWorkStatus —— sessionId 解析', () => {
  test('带 sessionId → 原样保留，供点气泡跳会话', () => {
    const snap = toWorkStatus({ state: 'working', task: '改文件', sessionId: 'session-abc' });
    assert.equal(snap?.sessionId, 'session-abc');
  });

  test('缺字段 / null（老宿主或外部槽）→ null，气泡因此不可点', () => {
    assert.equal(toWorkStatus({ state: 'working', task: null })?.sessionId, null);
    assert.equal(toWorkStatus({ state: 'working', task: null, sessionId: null })?.sessionId, null);
  });

  test('空串 / 哨兵 unknown / 非字符串 → null（不让气泡跳到不存在的地方）', () => {
    for (const sessionId of ['', 'unknown', 42, {}, true]) {
      assert.equal(toWorkStatus({ state: 'working', task: null, sessionId })?.sessionId, null);
    }
  });

  test('空闲快照也带 sessionId: null', () => {
    assert.deepEqual(toWorkStatus({ state: null, task: null }), { state: null, task: null, sessionId: null });
  });
});
