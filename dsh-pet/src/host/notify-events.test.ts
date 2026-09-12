/**
 * host 通知帧生成纯逻辑单元测试 —— 钉住「DSH 宿主事件 → shared/notify.ts 同契约帧」：
 *   turn/end（completed/error/max-tokens 弹，aborted 等不弹）、approval/asked、
 *   tool/call（ask_user_question 解析 questions）、agent/error（message 提取）。
 *
 * 跑法：node --experimental-strip-types --test src/host/notify-events.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { agentErrorFrame, parseToolQuestions, reduceNotifyFrame, turnEndNotifyKind } from './notify-events.ts';

describe('turnEndNotifyKind —— turn/end reason.kind → 通知类别', () => {
  test('completed / error / max-tokens 弹', () => {
    assert.equal(turnEndNotifyKind('completed'), 'completed');
    assert.equal(turnEndNotifyKind('error'), 'error');
    assert.equal(turnEndNotifyKind('max-tokens'), 'max-tokens');
  });

  test('aborted / interrupted / blocked / 未知 → 不弹', () => {
    assert.equal(turnEndNotifyKind('aborted'), null);
    assert.equal(turnEndNotifyKind('interrupted'), null);
    assert.equal(turnEndNotifyKind('blocked'), null);
    assert.equal(turnEndNotifyKind(undefined), null);
  });
});

describe('reduceNotifyFrame —— session/event 子事件 → 帧', () => {
  test('turn/end completed → session/event 帧（reason 原样透传）', () => {
    const frame = reduceNotifyFrame({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    });
    assert.deepEqual(frame, {
      type: 'session/event',
      event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    });
  });

  test('turn/end error → 帧，error.message 透传', () => {
    const frame = reduceNotifyFrame({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'boom' } } },
    });
    assert.deepEqual(frame, {
      type: 'session/event',
      event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } },
    });
  });

  test('turn/end aborted → null（不弹）', () => {
    assert.equal(reduceNotifyFrame({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), null);
  });

  test('approval/asked → approval/requested 帧（toolName/reason 带上）', () => {
    const frame = reduceNotifyFrame({
      type: 'approval/asked',
      data: { id: 'a1', toolName: 'pwsh', reason: '需要权限', callId: 'c1' },
    });
    assert.deepEqual(frame, { type: 'approval/requested', toolName: 'pwsh', reason: '需要权限' });
  });

  test('approval/asked 无 reason → 帧不带 reason 字段', () => {
    assert.deepEqual(reduceNotifyFrame({ type: 'approval/asked', data: { toolName: 'pwsh' } }), {
      type: 'approval/requested',
      toolName: 'pwsh',
    });
  });

  test('tool/call ask_user_question → question/requested 帧（解析 arguments）', () => {
    const frame = reduceNotifyFrame({
      type: 'tool/call',
      data: { name: 'ask_user_question', arguments: '{"questions":[{"id":"q1","question":"选哪个？"}]}' },
    });
    assert.deepEqual(frame, {
      type: 'question/requested',
      questions: [{ id: 'q1', question: '选哪个？' }],
    });
  });

  test('tool/call 非提问工具 / 无 questions / 非法 arguments → null', () => {
    assert.equal(reduceNotifyFrame({ type: 'tool/call', data: { name: 'pwsh' } }), null);
    assert.equal(
      reduceNotifyFrame({ type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[]}' } }),
      null,
    );
    assert.equal(
      reduceNotifyFrame({ type: 'tool/call', data: { name: 'ask_user_question', arguments: 'not json' } }),
      null,
    );
  });

  test('未知事件 / 无 type → null', () => {
    assert.equal(reduceNotifyFrame({ type: 'todo/write' }), null);
    assert.equal(reduceNotifyFrame({}), null);
  });
});

describe('parseToolQuestions —— arguments JSON 解析', () => {
  test('合法 questions 数组', () => {
    assert.deepEqual(parseToolQuestions('{"questions":[{"question":"A"}]}'), [{ question: 'A' }]);
  });
  test('非法 JSON / 非数组 / 非字符串 → null', () => {
    assert.equal(parseToolQuestions('nope'), null);
    assert.equal(parseToolQuestions('{"questions":"x"}'), null);
    assert.equal(parseToolQuestions(undefined), null);
  });
});

describe('agentErrorFrame —— agent/error → host/agent-error 帧', () => {
  test('Error 对象提取 message', () => {
    assert.deepEqual(agentErrorFrame(new Error('boom')), { type: 'host/agent-error', message: 'boom' });
  });
  test('字符串透传', () => {
    assert.deepEqual(agentErrorFrame('直接失败'), { type: 'host/agent-error', message: '直接失败' });
  });
  test('无 message → 空串兜底', () => {
    assert.deepEqual(agentErrorFrame(undefined), { type: 'host/agent-error', message: '' });
  });
});
