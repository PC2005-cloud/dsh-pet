/**
 * host 通知帧生成纯逻辑单元测试 —— 钉住「DSH 宿主事件 → shared/notify.ts 同契约帧」：
 *   turn/end（completed/error/max-tokens 弹，aborted 等不弹）、approval/asked、
 *   tool/call（ask_user_question 解析 questions）、agent/error（message 提取），
 *   以及会话门 shouldNotifySession（子代理不发、普通 fork 照发）
 *   与活动门（issue #114：只拦「对话完成」+ 判据 hasBlockingActivity 的取舍）。
 *
 * 跑法：node --experimental-strip-types --test src/host/notify-events.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentErrorFrame,
  hasBlockingActivity,
  type HostNotifyFrame,
  isCompletionTurnEnd,
  lastAssistantText,
  parseToolQuestions,
  reduceNotifyFrame,
  sessionIdOf,
  shouldNotifySession,
  turnEndNotifyKind,
} from './notify-events.ts';

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

describe('shouldNotifySession —— 会话门（issue #82）', () => {
  // 下面三条 header 都是本机实测真值（dsh-pet 仓库工作区、DSH 会话格式 v4）。
  const subagent = {
    id: '7590c092-5e81-4d0b-92de-4c85e65fef61',
    header: {
      id: '7590c092-5e81-4d0b-92de-4c85e65fef61',
      cwd: 'D:\\Source\\windows\\Downloads\\pet',
      parentSession: 'session-08286e28-0ad9-4076-9a2c-6f333645cbb1',
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
    },
  };
  const forkedMain = {
    id: 'session-08286e28-0ad9-4076-9a2c-6f333645cbb1',
    header: {
      id: 'session-08286e28-0ad9-4076-9a2c-6f333645cbb1',
      cwd: 'D:\\Source\\windows\\Downloads\\pet',
      parentSession: 'session-d600d115-f8ed-4ee3-a70e-48c0d792e285',
      isSeeded: true,
      delegationDepth: 0,
    },
  };
  const root = {
    id: 'session-d600d115-f8ed-4ee3-a70e-48c0d792e285',
    header: {
      id: 'session-d600d115-f8ed-4ee3-a70e-48c0d792e285',
      cwd: 'D:\\Source\\windows\\Downloads\\pet',
      isSeeded: false,
      delegationDepth: 0,
    },
  };

  test('子代理（origin=subagent）→ 不发', () => {
    assert.equal(shouldNotifySession(subagent), false);
  });

  test('origin 缺失但 delegationDepth>0（子代理被 fork 后）→ 不发', () => {
    assert.equal(shouldNotifySession({ header: { id: 'x', delegationDepth: 1 } }), false);
  });

  test('根会话（无 parentSession / 无 origin / depth=0）→ 发', () => {
    assert.equal(shouldNotifySession(root), true);
  });

  // 这条是整个判定的要害：普通 fork（换模型重建会话等）也带 parentSession，
  // 按 parentSession 过滤会把正在对话的主对话一起静音——本机实测就是这条会话。
  test('普通 fork（带 parentSession、origin 缺失、depth=0）→ 照发（不许用 parentSession 判子代理）', () => {
    assert.equal(shouldNotifySession(forkedMain), true);
    assert.equal(forkedMain.header.parentSession !== undefined, true, '前提：它确实带 parentSession');
    assert.equal('origin' in forkedMain.header, false, '前提：它确实没有 origin');
  });

  test('判据不可用 → 一律放行（绝不把通知整体打哑）', () => {
    assert.equal(shouldNotifySession(undefined), true);
    assert.equal(shouldNotifySession(null), true);
    assert.equal(shouldNotifySession({}), true);
    assert.equal(shouldNotifySession({ header: null }), true);
    assert.equal(shouldNotifySession({ header: 'not-an-object' }), true);
    assert.equal(shouldNotifySession({ header: {} }), true);
  });

  test('字段形状不对 → 放行（不把异常值当成子代理）', () => {
    assert.equal(shouldNotifySession({ header: { origin: 'main' } }), true);
    assert.equal(shouldNotifySession({ header: { delegationDepth: '1' } }), true);
    assert.equal(shouldNotifySession({ header: { delegationDepth: -1 } }), true);
    assert.equal(shouldNotifySession({ header: { delegationDepth: Number.NaN } }), true);
    assert.equal(shouldNotifySession({ header: { delegationDepth: 0 } }), true);
  });
});

describe('isCompletionTurnEnd —— 活动门只拦「对话完成」（issue #114）', () => {
  test('turn/end + completed → true（唯一需要先确认空闲的帧）', () => {
    assert.equal(isCompletionTurnEnd({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), true);
  });

  test('turn/end 的其它 kind → false（失败/截断是"真出事了"，照弹）', () => {
    assert.equal(isCompletionTurnEnd({ type: 'turn/end', data: { reason: { kind: 'error' } } }), false);
    assert.equal(isCompletionTurnEnd({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), false);
    assert.equal(isCompletionTurnEnd({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), false);
    assert.equal(isCompletionTurnEnd({ type: 'turn/end', data: {} }), false);
  });

  test('权限申请 / 用户选择 / 缺字段 → false（等人操作的通知绝不能被活动门静默）', () => {
    assert.equal(isCompletionTurnEnd({ type: 'approval/asked', data: { toolName: 'pwsh' } }), false);
    assert.equal(
      isCompletionTurnEnd({ type: 'tool/call', data: { name: 'ask_user_question', arguments: '{}' } }),
      false,
    );
    assert.equal(isCompletionTurnEnd(undefined), false);
    assert.equal(isCompletionTurnEnd(null), false);
    assert.equal(isCompletionTurnEnd({}), false);
  });
});

describe('sessionIdOf —— 活动门定时器的会话键', () => {
  test('header.id 优先 → 回落顶层 id → 兜底 unknown', () => {
    assert.equal(sessionIdOf({ id: 'top', header: { id: 'hdr' } }), 'hdr');
    assert.equal(sessionIdOf({ id: 'top', header: {} }), 'top');
    assert.equal(sessionIdOf({ id: 'top' }), 'top');
    assert.equal(sessionIdOf({}), 'unknown');
    assert.equal(sessionIdOf(null), 'unknown');
    assert.equal(sessionIdOf(undefined), 'unknown');
  });
});

describe('hasBlockingActivity —— 活动门判据（issue #114）', () => {
  test('只有 turn 族 → 放行（这条会话自己的回合刚结束，不许自己挡自己）', () => {
    assert.equal(hasBlockingActivity([{ kind: 'turn' }]), false);
  });

  test('在跑的团队成员 / 下属子代理（subagent）→ 拦（团队误报的主角）', () => {
    assert.equal(hasBlockingActivity([{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 'm1' }] }]), true);
  });

  test('后台任务（job）/ 活跃定时提醒（schedule）→ 拦', () => {
    assert.equal(hasBlockingActivity([{ kind: 'job', items: [{ id: 'j1', label: 'x' }] }]), true);
    assert.equal(hasBlockingActivity([{ kind: 'schedule' }]), true);
  });

  test('空 / 非数组 / 形状不对 → 放行（判据不可用绝不把通知打哑）', () => {
    assert.equal(hasBlockingActivity([]), false);
    assert.equal(hasBlockingActivity(undefined), false);
    assert.equal(hasBlockingActivity(null), false);
    assert.equal(hasBlockingActivity('nope'), false);
    assert.equal(hasBlockingActivity({ kind: 'subagent' }), false, '非数组＝形状不对，放行');
    assert.equal(hasBlockingActivity([null, 42, {}, { kind: 7 }]), false);
  });

  test('未知族 → 放行（宿主新增一族不能让通知整体失效）', () => {
    assert.equal(hasBlockingActivity([{ kind: 'something-new' }]), false);
  });
});

describe('lastAssistantText —— 从 assistant/message 里取最后一段正文', () => {
  test('取最后一个 text 块，压平空白', () => {
    assert.equal(
      lastAssistantText({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '  改了  三处\n并跑了测试  ' }] } },
      }),
      '改了 三处 并跑了测试',
    );
  });

  test('跳过 reasoning 块，只认 text', () => {
    assert.equal(
      lastAssistantText({
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'reasoning', text: '这条不该出现' },
              { type: 'text', text: '真正的回复' },
            ],
          },
        },
      }),
      '真正的回复',
    );
  });

  test('超长截断到 200 字，非 assistant/message 一律 null', () => {
    const long = lastAssistantText({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'x'.repeat(300) }] } },
    });
    assert.equal(long?.length, 200);
    assert.equal(lastAssistantText({ type: 'turn/end', data: {} }), null);
    assert.equal(lastAssistantText({ type: 'assistant/message', data: {} }), null);
  });
});

describe('reduceNotifyFrame —— 完成帧带上回复开头', () => {
  /** 取帧里的 turn/end 数据；帧本身是宽松形状，只有 shared 侧知道 `event`，这里借 unknown 转一次。 */
  const frameData = (frame: HostNotifyFrame | null): Record<string, unknown> =>
    (frame as unknown as { event: { data: Record<string, unknown> } }).event.data;

  test('completed + 有正文 → 帧里带 text', () => {
    const frame = reduceNotifyFrame({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, '改完了');
    assert.equal(frameData(frame).text, '改完了');
  });

  test('completed 但没有正文 → 不写 text 字段', () => {
    const frame = reduceNotifyFrame({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    assert.equal('text' in frameData(frame), false);
  });

  test('error 不挂正文（失败原因走 reason.error）', () => {
    const frame = reduceNotifyFrame(
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } },
      '这段不该出现',
    );
    assert.equal('text' in frameData(frame), false);
  });
});
