/**
 * 会话名注入（`sessionTitleFrom`）的单元测试：通知标题能不能认出「是哪条会话回来了」全靠它。
 * 四种取不到的情形都必须退成 undefined，交给 shared 侧回落固定文案；
 * 抛错也要在这里收住，否则一条取名失败会把弹窗本身带下水。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTitleFrom, type SessionNavigator } from './notify.ts';

/** 只实现命名能力的替身；跳转不参与本测试。 */
const namedBy = (title: string): SessionNavigator => ({ openSession: () => {}, sessionTitle: () => title });

describe('sessionTitleFrom', () => {
  test('服务给出了名字时原样返回', () => {
    assert.equal(sessionTitleFrom(namedBy('修复通知标题'), 's1'), '修复通知标题');
  });

  test('帧没带 sessionId 时返回 undefined，不拿空 id 去查', () => {
    assert.equal(sessionTitleFrom(namedBy('任何名字'), undefined), undefined);
  });

  test('没有注入器（旧版宿主）时返回 undefined', () => {
    assert.equal(sessionTitleFrom(undefined, 's1'), undefined);
  });

  test('服务没有命名能力时返回 undefined', () => {
    assert.equal(sessionTitleFrom({ openSession: () => {} }, 's1'), undefined);
  });

  test('服务抛错时收住，不波及弹窗', () => {
    const navigator: SessionNavigator = {
      openSession: () => {},
      sessionTitle: () => {
        throw new Error('会话列表还没加载');
      },
    };
    assert.equal(sessionTitleFrom(navigator, 's1'), undefined);
  });
});
