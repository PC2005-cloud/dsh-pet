/**
 * host 工作状态纯逻辑单元测试 —— 钉住「goal 自动续跑轮的中间轮 turn/end completed 不判成功」：
 *   中间轮 → result（不庆祝）；收尾轮 complete → success / blocked → error；非 goal 轮原行为不变。
 *
 * 跑法：node --experimental-strip-types --test src/host/work-status.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { completedState, goalUpdateAction, reduceWorkStatus } from './work-status.ts';

describe('goalUpdateAction —— update_goal arguments 解析', () => {
  test('complete / blocked 识别', () => {
    assert.equal(goalUpdateAction('{"action":"complete","goal_id":"g1"}'), 'complete');
    assert.equal(goalUpdateAction('{"action":"blocked","blocked_reason":"x"}'), 'blocked');
  });

  test('其它动作 / 缺省 / 非法 JSON → null（按未收尾处理）', () => {
    assert.equal(goalUpdateAction('{"action":"edit"}'), null);
    assert.equal(goalUpdateAction('{"action":"pause"}'), null);
    assert.equal(goalUpdateAction(''), null);
    assert.equal(goalUpdateAction('not json'), null);
    assert.equal(goalUpdateAction('null'), null);
  });
});

describe('completedState —— turn/end completed 终局判定', () => {
  test('非 goal 轮 / 无上下文 → success（原行为，向后兼容）', () => {
    assert.equal(completedState(undefined), 'success');
    assert.equal(completedState({}), 'success');
    assert.equal(completedState({ goalRound: false, closing: null }), 'success');
  });

  test('自动续跑轮中间轮（goalRound && 未收尾）→ result（本轮完成≠任务完成，不庆祝）', () => {
    assert.equal(completedState({ goalRound: true }), 'result');
    assert.equal(completedState({ goalRound: true, closing: null }), 'result');
  });

  test('收尾轮 complete → success；blocked → error', () => {
    assert.equal(completedState({ goalRound: true, closing: 'complete' }), 'success');
    assert.equal(completedState({ goalRound: true, closing: 'blocked' }), 'error');
  });
});

describe('reduceWorkStatus —— 带 turn 上下文的事件压缩', () => {
  const endCompleted = {
    type: 'turn/end',
    data: { turn: 5, reason: { kind: 'completed' } },
  };

  test('中间轮 completed → result', () => {
    assert.equal(reduceWorkStatus(endCompleted, { goalRound: true, closing: null }), 'result');
  });

  test('收尾轮 completed → success / blocked → error', () => {
    assert.equal(reduceWorkStatus(endCompleted, { goalRound: true, closing: 'complete' }), 'success');
    assert.equal(reduceWorkStatus(endCompleted, { goalRound: true, closing: 'blocked' }), 'error');
  });

  test('普通轮（不传上下文）→ success（向后兼容）', () => {
    assert.equal(reduceWorkStatus(endCompleted), 'success');
    assert.equal(reduceWorkStatus(endCompleted, {}), 'success');
  });

  test('其它 turn/end reason 不受影响：error / blocked / aborted', () => {
    assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'error' } } }), 'error');
    assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), 'error');
    assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }), 'waiting');
    // aborted → null：调用方清理会话回空闲（既有语义不回退）
    assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), null);
  });

  test('非 turn/end 事件不受 turn 上下文影响', () => {
    assert.equal(reduceWorkStatus({ type: 'turn/start', data: { turn: 6 } }, { goalRound: true }), 'thinking');
    assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'read' } }, { goalRound: true }), 'working');
    assert.equal(reduceWorkStatus({ type: 'tool/result', data: {} }), 'result');
  });
});