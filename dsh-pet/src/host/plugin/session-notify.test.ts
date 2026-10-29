/**
 * 完成通知正文来源（src/host/plugin/session-notify.ts）的契约测试。
 *
 * 钉住两件事：回复正文跟着完成帧走；缓存「排定时器即出队」——活动门判定还有活的那一支
 * 会提前 return，若把删除放在定时器里，这里就会留下一条永不清理的会话文本。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionNotify } from './session-notify.ts';

/** 一条「对话完成」收尾事件。 */
const COMPLETED = { type: 'turn/end', data: { reason: { kind: 'completed' } } };

/** 等异步那一拍跑完（定时器是假时钟，microtask 仍是真的）。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * 造一个最小实例。
 *
 * @param activity - 活动门返回的活跃族；缺省表示「没有在跑的活」（查询失败与无 waterfall 同此）。
 * @returns 实例与已推的通知帧。
 */
function make(activity?: () => Promise<unknown[]>) {
  const frames: unknown[] = [];
  const notify = createSessionNotify({
    ctx: activity ? { waterfall: activity } : {},
    publishWorkStatus: () => {},
    state: { writeSection: (_name: string, value: unknown) => frames.push(value) },
    workStatus: { clear: () => {}, stateOf: () => null },
  } as never);
  return { notify, frames };
}

describe('scheduleCompletionNotify —— 回复正文的生命周期', () => {
  test('完成：帧里带上正文，且排定时器时就已出队', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { notify, frames } = make();
    notify.lastReplyText.set('s1', '改完了');
    notify.scheduleCompletionNotify('s1', COMPLETED);
    assert.equal(notify.lastReplyText.has('s1'), false, '取用即出队，不能等定时器到点再删');

    t.mock.timers.tick(1500);
    await settle();

    assert.equal(frames.length, 1);
    const data = (frames[0] as { event: { data: { text?: string } } }).event.data;
    assert.equal(data.text, '改完了');
  });

  test('活动门判定还有活：不推帧，但缓存同样不残留', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { notify, frames } = make(async () => [{ kind: 'job' }]);
    notify.lastReplyText.set('s2', '这一轮先不用');
    notify.scheduleCompletionNotify('s2', COMPLETED);
    t.mock.timers.tick(1500);
    await settle();

    assert.equal(frames.length, 0, '还有活在跑时不弹完成通知');
    assert.equal(notify.lastReplyText.size, 0, '提前返回的那一支也不能留下残留');
  });

  test('没有正文：照常推帧，只是不带 text', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { notify, frames } = make();
    notify.scheduleCompletionNotify('s3', COMPLETED);
    t.mock.timers.tick(1500);
    await settle();

    const data = (frames[0] as { event: { data: Record<string, unknown> } }).event.data;
    assert.equal('text' in data, false);
  });

  test('缓存按会话隔离：另一个会话的正文不会串进来', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { notify, frames } = make();
    notify.lastReplyText.set('a', 'A 的回复');
    notify.lastReplyText.set('b', 'B 的回复');
    notify.scheduleCompletionNotify('b', COMPLETED);
    t.mock.timers.tick(1500);
    await settle();

    const data = (frames[0] as { event: { data: { text?: string } } }).event.data;
    assert.equal(data.text, 'B 的回复');
    assert.equal(notify.lastReplyText.get('a'), 'A 的回复', '别的会话那条不该被顺手删掉');
  });
});
