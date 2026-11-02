/**
 * 消息头像与消息节点的渲染契约：头像地址必须按素材根与版本号生成。
 *
 * 只钉节点属性，不引 jsdom；用假的 `h` 记录树。
 * 跑法：node --experimental-strip-types --test src/client/chat/view-message.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { avatarNode, messageNode } from './view-message.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { ChatMessageView } from './api.ts';
import type { ChatPanelRuntime } from './runtime.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as ChatPanelRuntime['h'];

const message: ChatMessageView = { role: 'assistant', text: '在的', ts: 1 };

describe('avatarNode', () => {
  test('宠物侧按素材根与版本号拼地址', () => {
    const node = avatarNode(h, false, 'baimao', 7) as unknown as Node;
    assert.equal(node.tag, 'img');
    assert.equal(node.props.className, 'pet-chat-avatar');
    assert.equal(node.props.src, ROUTE_PATH + '/logo?root=baimao&v=7');
  });

  test('没有素材根时只带版本号（宿主回默认 logo）', () => {
    const node = avatarNode(h, false, '', 7) as unknown as Node;
    assert.equal(node.props.src, ROUTE_PATH + '/logo?v=7');
  });

  test('用户侧是内联 SVG，不吃头像地址', () => {
    const node = avatarNode(h, true, 'baimao', 7) as unknown as Node;
    assert.equal(node.tag, 'svg');
    assert.equal(node.props.src, undefined);
  });

  test('版本号变化 → 头像 URL 变化（破缓存靠这一点）', () => {
    const first = avatarNode(h, false, 'baimao', 1) as unknown as Node;
    const second = avatarNode(h, false, 'baimao', 2) as unknown as Node;
    assert.notEqual(first.props.src, second.props.src);
  });
});

describe('messageNode', () => {
  test('宠物消息的头像跟随传入的素材根与版本号', () => {
    const node = messageNode(h, {
      message,
      isMe: false,
      assetRoot: 'baimao',
      avatarVersion: 3,
      onOpenImage: () => {},
    }) as unknown as Node;
    const avatar = (node.props.children as unknown[])[0] as Node;
    assert.equal(avatar.props.src, ROUTE_PATH + '/logo?root=baimao&v=3');
  });

  test('用户消息的头像仍是 SVG', () => {
    const node = messageNode(h, {
      message: { ...message, role: 'user' },
      isMe: true,
      assetRoot: 'baimao',
      avatarVersion: 3,
      onOpenImage: () => {},
    }) as unknown as Node;
    const avatar = (node.props.children as unknown[])[0] as Node;
    assert.equal(avatar.tag, 'svg');
  });
});
