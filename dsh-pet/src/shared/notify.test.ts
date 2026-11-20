/**
 * 通知文案的单元测试 —— 钉住文案规则：
 *   标题是会话名（超 30 字截断；取不到回落 DeepSeek Harness），不再缀事件类型；
 *   正文是去 Markdown 的纯文本，最多 80 字（含省略号），完成通知只留第一句（首句太短就顺延）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, frameToToast, MAX_BODY } from './notify.ts';

/** 审批帧：工具名与理由都要进正文（沿用原来的写法）。 */
const approvalFrame = { type: 'approval/requested', sessionId: 's1', toolName: 'bash', reason: '要写 /tmp' };

/** 完成帧。 */
const done = (text?: string) => ({
  type: 'session/event',
  sessionId: 's1',
  event: { type: 'turn/end', data: { reason: { kind: 'completed' }, text } },
});

/** 生成失败帧。 */
const errorFrame = {
  type: 'session/event',
  sessionId: 's1',
  event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '连接超时' } } } },
};

/** 输出截断帧。 */
const maxTokensFrame = {
  type: 'session/event',
  sessionId: 's1',
  event: { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } },
};

/** 提问帧。 */
const questionFrame = { type: 'question/requested', sessionId: 's1', questions: [{ question: '选哪个？' }] };

describe('frameToToast：标题只留会话名', () => {
  test('五类事件都用会话名，不缀事件类型', () => {
    assert.equal(frameToToast(done('改完了'), '修复通知标题')?.title, '修复通知标题');
    assert.equal(frameToToast(errorFrame, '修复通知标题')?.title, '修复通知标题');
    assert.equal(frameToToast(maxTokensFrame, '修复通知标题')?.title, '修复通知标题');
    assert.equal(frameToToast(approvalFrame, '修复通知标题')?.title, '修复通知标题');
    assert.equal(frameToToast(questionFrame, '修复通知标题')?.title, '修复通知标题');
  });

  test('没有会话名（缺省 / 空串 / 纯空白）回落 DeepSeek Harness', () => {
    for (const title of [undefined, '', '   ']) {
      assert.equal(frameToToast(approvalFrame, title)?.title, 'DeepSeek Harness');
    }
  });

  test('长会话名截到 30 字加省略号，恰好 30 字保留', () => {
    const thirty = '会'.repeat(30);
    assert.equal(frameToToast(approvalFrame, thirty)?.title, thirty);
    assert.equal(frameToToast(approvalFrame, thirty + '多')?.title, thirty + '…');
    assert.equal(frameToToast(approvalFrame, '会'.repeat(80))?.title, thirty + '…');
  });

  test('host/agent-error 没有会话维度，标题仍是生成失败', () => {
    const t = frameToToast({ type: 'host/agent-error', message: '进程崩了' }, '任何名字');
    assert.equal(t?.title, '生成失败');
  });
});

describe('frameToToast：完成通知正文', () => {
  test('只留第一句', () => {
    assert.equal(
      frameToToast(done('改完了通知正文并且通过了测试。还有下文。'), '会话')?.body,
      '改完了通知正文并且通过了测试。',
    );
  });

  test('首句太短时顺延到后面，避免空横幅', () => {
    assert.equal(frameToToast(done('已修复。测试全过，已提交。'), '会话')?.body, '已修复。测试全过，已提交。');
  });

  test('开头的「好的，」先去掉', () => {
    assert.equal(frameToToast(done('好的，已经改好了。测试全过。'), '会话')?.body, '已经改好了。测试全过。');
  });

  test('首句够长时仍只留第一句', () => {
    const text = '这次改动把通知正文从原始 Markdown 换成了纯文本。后面还有一句。';
    assert.equal(frameToToast(done(text), '会话')?.body, '这次改动把通知正文从原始 Markdown 换成了纯文本。');
  });

  test('缩写与小数后的句点不算句尾', () => {
    assert.equal(frameToToast(done('Dr. Smith is here. Next.'), '会话')?.body, 'Dr. Smith is here.');
    assert.equal(frameToToast(done('Bumped to v1.2. 已发版。'), '会话')?.body, 'Bumped to v1.2.');
  });

  test('问号不是句尾时整句保留', () => {
    assert.equal(frameToToast(done('打开 https://x.test/a?b=1 看看'), '会话')?.body, '打开 https://x.test/a?b=1 看看');
  });

  test('去掉标题、强调、行内代码、列表与代码块标记', () => {
    const text = '# 标题\n**粗体** 与 `code_x`\n\n- 列表项\n\n```js\nconst a = 1\n```\n收尾。';
    assert.equal(frameToToast(done(text), '会话')?.body, '标题 粗体 与 code_x 列表项 收尾。');
  });

  test('去掉表格的表头、分隔行与数据行', () => {
    const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n结果在这。';
    assert.equal(frameToToast(done(text), '会话')?.body, '结果在这。');
  });

  test('正文为空时回落「回合已完成」', () => {
    for (const text of [undefined, '', '   \n ']) {
      assert.equal(frameToToast(done(text), '会话')?.body, '回合已完成');
    }
  });

  test('超长正文按码点截到 80，含省略号', () => {
    const body = frameToToast(done('x'.repeat(MAX_BODY + 20)), '会话')?.body ?? '';
    assert.equal(Array.from(body).length, MAX_BODY);
    assert.equal(body.endsWith('…'), true);
  });
});

describe('frameToToast：提问与审批正文', () => {
  test('提问保留多句，只去 Markdown', () => {
    const frame = { type: 'question/requested', questions: [{ question: '**要改哪里**？顺便说下。' }] };
    assert.equal(frameToToast(frame, '会话')?.body, '要改哪里？顺便说下。');
  });

  test('问题正文为空时回落「需要你回答」', () => {
    assert.equal(
      frameToToast({ type: 'question/requested', questions: [{ question: '  ' }] }, '会话')?.body,
      '需要你回答',
    );
  });

  test('审批正文是工具名加理由', () => {
    assert.equal(frameToToast(approvalFrame, '会话')?.body, '工具「bash」：要写 /tmp');
    assert.equal(frameToToast({ type: 'approval/requested', toolName: 'bash' }, '会话')?.body, '工具「bash」');
    assert.equal(frameToToast({ type: 'approval/requested', reason: '要写 /tmp' }, '会话')?.body, '要写 /tmp');
    assert.equal(frameToToast({ type: 'approval/requested' }, '会话')?.body, '需要你批准');
    assert.equal(frameToToast({ type: 'approval/requested', toolName: '  ' }, '会话')?.body, '需要你批准');
  });
});

describe('frameToToast：失败类正文', () => {
  test('生成失败与输出截断', () => {
    assert.equal(frameToToast(errorFrame, '会话')?.body, '生成失败：连接超时');
    assert.equal(
      frameToToast({ ...errorFrame, event: { type: 'turn/end', data: { reason: { kind: 'error' } } } })?.body,
      '生成失败',
    );
    assert.equal(frameToToast(maxTokensFrame, '会话')?.body, '已达到输出 token 上限');
  });

  test('host/agent-error 正文是错误信息', () => {
    assert.equal(frameToToast({ type: 'host/agent-error', message: '进程崩了' })?.body, '进程崩了');
  });
});

describe('clip：压平空白并按码点截断', () => {
  test('空白压成一个空格', () => {
    assert.equal(clip('  a\n\t b  '), 'a b');
  });
  test('长英文从最近的空格或标点断开，不劈单词', () => {
    assert.equal(clip('a'.repeat(70) + ' ' + 'b'.repeat(20)), 'a'.repeat(70) + '…');
    assert.equal(clip('x'.repeat(MAX_BODY + 20)), 'x'.repeat(MAX_BODY - 1) + '…');
  });
  test('80 个字符以内原样返回', () => {
    assert.equal(clip('x'.repeat(MAX_BODY)), 'x'.repeat(MAX_BODY));
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
