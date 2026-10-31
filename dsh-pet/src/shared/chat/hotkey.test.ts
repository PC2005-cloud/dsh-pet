/**
 * 悬停快捷键判据的单测。
 *
 * 为什么值得钉：快捷键挂在 document 上，判据写松了会在输入框里抢走 `T`，
 * 表现为"打不出字母 t"；写紧了又一切无效。这里把几种边界钉死。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isChatHotkey, isTypingTarget, type HotkeyEvent } from './hotkey.ts';

/** 只造判据用到的字段，不需要真的 KeyboardEvent。 */
const ev = (over: Partial<HotkeyEvent> = {}): HotkeyEvent => ({
  key: 'l',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: null,
  ...over,
});

/** 造一个带 tagName 的假元素。 */
const tag = (tagName: string, editable = false): EventTarget =>
  ({ tagName, isContentEditable: editable }) as unknown as EventTarget;

describe('isChatHotkey', () => {
  test('小写与大写 L 都算', () => {
    assert.equal(isChatHotkey(ev({ key: 'l' })), true);
    assert.equal(isChatHotkey(ev({ key: 'L' })), true);
  });

  test('其它键不算（原来的 T 已经让位）', () => {
    for (const key of ['t', 'a', 'r', 'Enter', ' ', 'Escape']) {
      assert.equal(isChatHotkey(ev({ key })), false, key);
    }
  });

  test('带修饰键不算（Ctrl+L 等留给浏览器）', () => {
    assert.equal(isChatHotkey(ev({ ctrlKey: true })), false);
    assert.equal(isChatHotkey(ev({ metaKey: true })), false);
    assert.equal(isChatHotkey(ev({ altKey: true })), false);
  });

  test('焦点在可编辑元素上不算', () => {
    for (const target of [tag('INPUT'), tag('TEXTAREA'), tag('SELECT'), tag('DIV', true)]) {
      assert.equal(isChatHotkey(ev({ target })), false);
    }
  });

  test('焦点在普通元素或没有焦点时算', () => {
    assert.equal(isChatHotkey(ev({ target: tag('DIV') })), true);
    assert.equal(isChatHotkey(ev()), true);
  });
});

describe('isTypingTarget', () => {
  test('三类表单控件与 contenteditable 视为打字中', () => {
    assert.equal(isTypingTarget(tag('INPUT')), true);
    assert.equal(isTypingTarget(tag('TEXTAREA')), true);
    assert.equal(isTypingTarget(tag('SELECT')), true);
    assert.equal(isTypingTarget(tag('div', true)), true);
  });

  test('null 与非元素视为非打字', () => {
    assert.equal(isTypingTarget(null), false);
    assert.equal(isTypingTarget({} as unknown as EventTarget), false);
  });
});
