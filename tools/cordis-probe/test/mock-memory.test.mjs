/**
 * mock 记忆的行为测试：钉住“存轮、只对问记忆的话召回、召回可区分、按宠物隔离、只留 5 轮、坏输入不写”。
 *
 * 跑法：node --test tools/cordis-probe/test/mock-memory.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MOCK_RECALL_MARKER, createMockMemoryProvider } from '../lib/mock-memory.js';

test('普通对话不召回；存过一轮后，问“记得”才注入最近一轮并要求复读标记', () => {
  const memory = createMockMemoryProvider();
  assert.equal(memory.recall({ petId: 'main', userText: '你好' }), undefined);

  memory.capture({ petId: 'main', userText: '我喜欢咖啡', replyText: '记住啦', ts: 1 });
  assert.equal(memory.recall({ petId: 'main', userText: '你好' }), undefined, '不问记忆就不注入');

  const patch = memory.recall({ petId: 'main', userText: '你记得我说过什么吗' });
  assert.ok(patch, '问记忆时必须有补丁');
  assert.ok(patch.userText.includes('我喜欢咖啡'));
  assert.ok(patch.userText.includes(MOCK_RECALL_MARKER), '必须要求模型复读标记，原生历史产生不了它');
  assert.match(patch.userText, /你记得我说过什么吗$/);
});

test('stats 记录 capture 次数：坏输入不计', () => {
  const memory = createMockMemoryProvider();
  assert.deepEqual(memory.stats(), { captured: 0 });

  memory.capture({ petId: 'main', userText: 'a', replyText: 'b', ts: 1 });
  memory.capture({ petId: 'main', userText: 1, replyText: 'b' });
  memory.capture({ petId: 'main', userText: 'q', replyText: null });
  assert.deepEqual(memory.stats(), { captured: 1 });
});

test('按宠物隔离：一只宠物的记忆不会进另一只', () => {
  const memory = createMockMemoryProvider();
  memory.capture({ petId: 'main', userText: 'A', replyText: 'a', ts: 1 });
  assert.equal(memory.recall({ petId: 'second', userText: '记得吗' }), undefined);
});

test('只保留最近 5 轮：最旧的被淘汰，最新的还在', () => {
  const memory = createMockMemoryProvider();
  for (let i = 0; i < 7; i += 1) {
    memory.capture({ petId: 'main', userText: 'q' + i, replyText: 'a' + i, ts: i });
  }
  const patch = memory.recall({ petId: 'main', userText: '上次说什么' });
  assert.ok(patch);
  assert.match(patch.userText, /q6/);
  assert.doesNotMatch(patch.userText, /q1/);
});

test('坏输入不写：userText 或 replyText 不是字符串时跳过', () => {
  const memory = createMockMemoryProvider();
  memory.capture({ petId: 'main', userText: 1, replyText: 'a' });
  memory.capture({ petId: 'main', userText: 'q', replyText: null });
  assert.equal(memory.recall({ petId: 'main', userText: '记得吗' }), undefined);
});
