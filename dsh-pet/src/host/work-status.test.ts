/**
 * host 工作状态纯逻辑单元测试 —— 钉住两件事：
 *   ① 「goal 自动续跑轮的中间轮 turn/end completed 不判成功」：
 *      中间轮 → result（不庆祝）；收尾轮 complete → success / blocked → error；非 goal 轮原行为不变。
 *   ② 任务详情文案与按会话聚合（issue #59）：多个 in_progress 取**最后**一个、清单全完成 → null、
 *      超长按码点截断；WorkStatusStore 的 task 挂在会话条目上，展示时与 state 同源同会话，
 *      条目一清文案就消失（"任务结束后永久残留"的根治点）。
 *
 * 跑法：node --experimental-strip-types --test src/host/work-status.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  completedState,
  currentTaskFromTodo,
  goalUpdateAction,
  reduceWorkStatus,
  TASK_TEXT_MAX,
  WorkStatusStore,
  type HostWorkStatusState,
} from './work-status.ts';

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

describe('currentTaskFromTodo —— 任务详情文案（issue #59）', () => {
  const todo = (...items: Array<[string, string]>) => ({
    data: { todos: items.map(([status, content]) => ({ status, content })) },
  });

  test('单个 in_progress → 它的文案', () => {
    assert.equal(
      currentTaskFromTodo(todo(['completed', '第一步'], ['in_progress', '正在执行 phase1'])),
      '正在执行 phase1',
    );
  });

  test('多个 in_progress → 取**最后一个**（最近开始的那步）', () => {
    // 成因：agent 把新步骤标 in_progress 却忘了收上一步；取第一个就会永远停在最早那步
    const event = todo(['in_progress', '正在执行 phase1'], ['in_progress', '正在执行 phase2']);
    assert.equal(currentTaskFromTodo(event), '正在执行 phase2');
  });

  test('无 in_progress → 回落到第一个 pending；都没有 → null', () => {
    assert.equal(currentTaskFromTodo(todo(['completed', 'a'], ['pending', 'b'], ['pending', 'c'])), 'b');
    assert.equal(currentTaskFromTodo(todo(['completed', 'a'], ['completed', 'b'])), null);
    assert.equal(currentTaskFromTodo(todo()), null);
  });

  test('空清单 / 缺字段 / 非数组 / 空白内容 → null（绝不产出空串气泡）', () => {
    assert.equal(currentTaskFromTodo({}), null);
    assert.equal(currentTaskFromTodo({ data: {} }), null);
    assert.equal(currentTaskFromTodo({ data: { todos: 'x' as unknown as [] } }), null);
    assert.equal(currentTaskFromTodo(todo(['in_progress', '   '])), null);
    assert.equal(currentTaskFromTodo(todo(['in_progress', ''])), null);
  });

  test('超长文案按码点截断加省略号，恰好到上限不截断', () => {
    const long = '甲'.repeat(TASK_TEXT_MAX + 1);
    const cut = currentTaskFromTodo(todo(['in_progress', long]));
    assert.equal(cut, `${'甲'.repeat(TASK_TEXT_MAX)}…`);
    assert.equal(Array.from(cut ?? '').length, TASK_TEXT_MAX + 1); // 40 字 + 省略号
    assert.equal(currentTaskFromTodo(todo(['in_progress', '乙'.repeat(TASK_TEXT_MAX)])), '乙'.repeat(TASK_TEXT_MAX));
  });

  test('截断不劈开代理对（emoji 不会被截成半个字符）', () => {
    const text = '🐟'.repeat(TASK_TEXT_MAX + 5);
    const cut = currentTaskFromTodo(todo(['in_progress', text])) ?? '';
    assert.equal(Array.from(cut).length, TASK_TEXT_MAX + 1); // 40 个 emoji + 省略号
    assert.equal(cut.includes('\uFFFD'), false);
    assert.equal(/[\uD800-\uDBFF]$/.test(cut), false, '不得以孤立高位代理结尾');
  });
});

describe('WorkStatusStore —— 按会话聚合与展示（issue #59）', () => {
  test('state 变化才更新 ts；同状态同 seq 不重复更新（防刷屏）', () => {
    const s = new WorkStatusStore();
    assert.equal(s.setState('a', 'thinking', 1), true);
    const ts1 = s.snapshot().ts;
    assert.equal(s.setState('a', 'thinking', 1), false, '同状态同 seq → 无变化');
    assert.equal(s.snapshot().ts, ts1);
    assert.equal(s.setState('a', 'working', 2), true);
    assert.equal(s.snapshot().state, 'working');
  });

  test('task 随会话条目存取，且与 state 同源取同一个会话', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    assert.equal(s.has('a'), true);
    assert.equal(s.setTask('a', '正在执行 phase1'), true);
    assert.deepEqual(
      { state: s.snapshot().state, task: s.snapshot().task },
      { state: 'working', task: '正在执行 phase1' },
    );
  });

  test('无活动条目的会话写 task 不生效（不会制造幽灵文案）', () => {
    const s = new WorkStatusStore();
    assert.equal(s.has('ghost'), false);
    assert.equal(s.setTask('ghost', '不该出现'), false);
    assert.equal(s.snapshot().task, null);
  });

  test('多会话：展示取优先级最高者，task 跟着它走（不串会话）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'thinking', 1);
    s.setTask('a', 'A 的任务');
    s.setState('b', 'working', 2); // working(40) > thinking(30) → 展示 b
    assert.equal(s.snapshot().state, 'working');
    assert.equal(s.snapshot().task, null, 'b 没有任务详情 → 不显示 a 的文案');
    s.setTask('b', 'B 的任务');
    assert.equal(s.snapshot().task, 'B 的任务');
    // a 仍在活动：b 掉出去后展示回 a 的 state 与 a 的文案
    s.clear('b');
    assert.equal(s.snapshot().state, 'thinking');
    assert.equal(s.snapshot().task, 'A 的任务');
  });

  test('同档位取 seq 更大者（最近事件优先）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    s.setTask('a', 'A');
    s.setState('b', 'working', 2);
    s.setTask('b', 'B');
    assert.equal(s.snapshot().task, 'B');
  });

  test('条目被清 → 文案一并消失（这是"任务结束后永久残留"的根治点）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'success', 1);
    s.setTask('a', '已经做完的旧任务');
    assert.equal(s.clear('a'), true);
    assert.equal(s.snapshot().state, null);
    assert.equal(s.snapshot().task, null, '旧文案不得残留到后续活动');
    assert.equal(s.has('a'), false);
  });

  test('setTask(null) 清空文案：回落档位文案的那条路（清单已无 in_progress/pending）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    s.setTask('a', 'phase1');
    s.setTask('a', null);
    assert.equal(s.snapshot().task, null);
  });

  test('展示优先级表：waiting > error > working > thinking > result > success', () => {
    const order: HostWorkStatusState[] = ['waiting', 'error', 'working', 'thinking', 'result', 'success'];
    for (let i = 0; i < order.length - 1; i += 1) {
      const s = new WorkStatusStore();
      s.setState('low', order[i + 1], 10); // 序号更大：只有优先级能决定胜负
      s.setState('high', order[i], 1);
      assert.equal(s.snapshot().state, order[i], `${order[i]} 应压过 ${order[i + 1]}`);
    }
  });
});
