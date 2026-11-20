import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatDialogBounds, chatDialogPosition } from './layout.ts';
import { CHAT_MESSAGE_LIMIT, isChatMessageTooLong } from './length.ts';

test('草稿到发送上限时可发，再多一个 UTF-16 单元才拒发', () => {
  const limit = '字'.repeat(CHAT_MESSAGE_LIMIT);
  assert.equal(isChatMessageTooLong(limit), false);
  assert.equal(isChatMessageTooLong(limit + '尾'), true);
  const emoji = '🐟'.repeat(CHAT_MESSAGE_LIMIT / 2);
  assert.equal(isChatMessageTooLong(' \n' + emoji + '\n '), false);
  assert.equal(isChatMessageTooLong(emoji + '尾'), true);
});

test('桌宠工作区交集比窗口小时，以交集限制弹窗尺寸', () => {
  assert.deepEqual(chatDialogBounds({ x: -80, y: 30, w: 400, h: 300 }, 280, 210), {
    x: 4,
    y: 34,
    w: 272,
    h: 172,
  });
  assert.deepEqual(chatDialogBounds({ x: 120, y: -20, w: 500, h: 120 }, 350, 160), {
    x: 124,
    y: 4,
    w: 222,
    h: 92,
  });
});

test('无有效工作区回到视口，极小视口也不使用负尺寸', () => {
  const viewport = { x: 4, y: 4, w: 272, h: 152 };
  assert.deepEqual(chatDialogBounds(null, 280, 160), viewport);
  assert.deepEqual(chatDialogBounds({ x: 1000, y: 0, w: 40, h: 40 }, 280, 160), viewport);
  assert.deepEqual(chatDialogBounds(null, 8, 4), { x: 1, y: 1, w: 6, h: 2 });
});

test('输入框增长后重新定位，右下角和左上角都保持在边界内', () => {
  const bounds = { x: 32, y: 27, w: 260, h: 150 };
  const anchor = { x: 220, y: 150 };
  assert.deepEqual(chatDialogPosition(bounds, anchor, 60, 25), anchor);
  assert.deepEqual(chatDialogPosition(bounds, anchor, 240, 130), { x: 52, y: 47 });
  assert.deepEqual(chatDialogPosition(bounds, { x: -40, y: -20 }, 240, 130), { x: 32, y: 27 });
});
