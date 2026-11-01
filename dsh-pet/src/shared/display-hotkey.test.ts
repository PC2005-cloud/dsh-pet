/**
 * 显示位置数字键的判据：`1`-`4` 与右键菜单同序、输入框里不抢、带修饰键不抢。
 *
 * 顺序值得钉：数字键与菜单项共用 {@link DISPLAY_ORDER}，谁改了顺序都会让「按 3 变成仅桌面」这类
 * 静默错位发生，而现场只会被当成"键绑错了"。
 *
 * 跑法：node --experimental-strip-types --test src/shared/display-hotkey.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DISPLAY_HOTKEY_HINTS, DISPLAY_ORDER, displayOfHotkey } from './display-hotkey.ts';
import type { HotkeyEvent } from './hotkey.ts';

/** 只造判据用到的字段，不需要真的 KeyboardEvent。 */
const ev = (over: Partial<HotkeyEvent> = {}): HotkeyEvent => ({
  key: '1',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: null,
  ...over,
});

/** 造一个带 tagName 的假元素。 */
const tag = (tagName: string, editable = false): EventTarget =>
  ({ tagName, isContentEditable: editable }) as unknown as EventTarget;

describe('displayOfHotkey —— 数字键到显示位置', () => {
  test('1-4 依次对应 web / desktop / both / none', () => {
    assert.deepEqual(
      ['1', '2', '3', '4'].map((key) => displayOfHotkey(ev({ key }))),
      ['web', 'desktop', 'both', 'none'],
    );
  });

  test('其它键一律不认', () => {
    for (const key of ['5', '0', 'l', 's', 'd', 'm', 'z', 'Enter', ' ']) {
      assert.equal(displayOfHotkey(ev({ key })), undefined, key);
    }
  });

  test('带 Ctrl / Meta / Alt 的组合键不抢', () => {
    assert.equal(displayOfHotkey(ev({ ctrlKey: true })), undefined);
    assert.equal(displayOfHotkey(ev({ metaKey: true })), undefined);
    assert.equal(displayOfHotkey(ev({ altKey: true })), undefined);
  });

  test('焦点在输入框 / contenteditable 里时不抢（那是打字）', () => {
    for (const target of [tag('INPUT'), tag('TEXTAREA'), tag('SELECT'), tag('DIV', true)]) {
      assert.equal(displayOfHotkey(ev({ target })), undefined);
    }
  });

  test('键帽文案与顺序同源', () => {
    assert.deepEqual(DISPLAY_ORDER, ['web', 'desktop', 'both', 'none']);
    assert.deepEqual(DISPLAY_HOTKEY_HINTS, ['1 键', '2 键', '3 键', '4 键']);
  });
});
