/**
 * 通知标题的单元测试 —— 钉住「会话名进标题」这条约定：
 *   completed 的标题就是会话名（没有名字才回落「对话完成」）；
 *   error / max-tokens / 审批 / 提问 用「会话名 · 事件」，事件类型不被会话名吞掉；
 *   没有会话名（宿主没带 sessionId、会话不在列表、空白会话）一律回落固定文案；
 *   超长会话名按 30 字符截断，标题只占一行。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { frameToToast, MAX_BODY } from './notify.ts';

/** 审批帧：标题固定是「正在申请权限」，用它观察会话名怎么拼进标题。 */
const approvalFrame = { type: 'approval/requested', sessionId: 's1', toolName: 'bash', reason: '要写 /tmp' };

describe('frameToToast：会话名进标题', () => {
  test('有会话名时是「会话名 · 事件」', () => {
    assert.equal(frameToToast(approvalFrame, '修复通知标题')?.title, '修复通知标题 · 正在申请权限');
  });

  test('没有会话名、空串、纯空白时只留事件类型', () => {
    assert.equal(frameToToast(approvalFrame)?.title, '正在申请权限');
    assert.equal(frameToToast(approvalFrame, '')?.title, '正在申请权限');
    assert.equal(frameToToast(approvalFrame, '   ')?.title, '正在申请权限');
  });

  test('会话名超长按 30 字符截断，事件类型不被截掉', () => {
    assert.equal(frameToToast(approvalFrame, '会话'.repeat(30))?.title, '会话'.repeat(15) + '… · 正在申请权限');
  });
});

describe('frameToToast：完成通知', () => {
  const done = (text?: string) => ({
    type: 'session/event',
    sessionId: 's1',
    event: { type: 'turn/end', data: { reason: { kind: 'completed' }, text } },
  });

  test('标题是会话名本身，不再缀「对话完成」', () => {
    const t = frameToToast(done('改完了'), '修复通知标题');
    assert.equal(t?.title, '修复通知标题');
    assert.equal(t?.body, '改完了');
  });

  test('没有会话名时回落「对话完成」', () => {
    assert.equal(frameToToast(done('改完了'))?.title, '对话完成');
    assert.equal(frameToToast(done('改完了'), '   ')?.title, '对话完成');
  });

  test('正文仍按 80 字符截断，标题与正文互不影响', () => {
    const long = 'x'.repeat(MAX_BODY + 10);
    const t = frameToToast(done(long), 'a'.repeat(100));
    assert.equal(t?.body, 'x'.repeat(MAX_BODY) + '…');
    assert.equal(t?.title, 'a'.repeat(30) + '…');
  });
});

describe('frameToToast：其他事件带上会话名', () => {
  test('error 是「会话名 · 生成失败」，正文仍是错误信息', () => {
    const frame = {
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '连接超时' } } } },
    };
    const t = frameToToast(frame, '跑测试');
    assert.equal(t?.title, '跑测试 · 生成失败');
    assert.equal(t?.body, '连接超时');
    assert.equal(frameToToast(frame)?.title, '生成失败');
  });

  test('max-tokens / 审批 / 提问同样前缀会话名', () => {
    const maxTokens = { type: 'session/event', event: { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } } };
    assert.equal(frameToToast(maxTokens, '长文档')?.title, '长文档 · 输出被截断');
    assert.equal(frameToToast(approvalFrame, '部署')?.title, '部署 · 正在申请权限');

    const question = { type: 'question/requested', sessionId: 's1', questions: [{ question: '选哪个？' }] };
    assert.equal(frameToToast(question, '选型')?.title, '选型 · 模型在等你回答');
    assert.equal(frameToToast(question)?.title, '模型在等你回答');
  });

  test('host/agent-error 没有会话维度，标题保持「生成失败」', () => {
    const t = frameToToast({ type: 'host/agent-error', message: '进程崩了' }, '任何名字');
    assert.equal(t?.title, '生成失败');
    assert.equal(t?.body, '进程崩了');
  });
});

describe('frameToToast：不弹的分支', () => {
  test('aborted / interrupted / 未知类型返回 null', () => {
    for (const kind of ['aborted', 'interrupted']) {
      const frame = { type: 'session/event', event: { type: 'turn/end', data: { reason: { kind } } } };
      assert.equal(frameToToast(frame, '这条也不该弹'), null);
    }
    assert.equal(frameToToast({ type: 'unknown/frame' }, '同样'), null);
  });
});
