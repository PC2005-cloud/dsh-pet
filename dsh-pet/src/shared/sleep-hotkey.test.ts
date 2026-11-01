/**
 * 睡觉快捷键（Z）的判据测试：钉住「裸按才切换、输入框里不抢」与「文案与按键同一份事实」。
 * 跑法：node --experimental-strip-types --test src/shared/sleep-hotkey.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SLEEP_HOTKEY_HINT, isSleepHotkey } from './sleep-hotkey.ts';
import type { HotkeyEvent } from './hotkey.ts';

/** 只造判据用到的字段，不需要真的 KeyboardEvent。 */
const ev = (over: Partial<HotkeyEvent> = {}): HotkeyEvent => ({
  key: 'z',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: null,
  ...over,
});

/** 造一个可编辑焦点目标（tagName 足够判 typing）。 */
const input = (isContentEditable = false): EventTarget =>
  ({ tagName: 'INPUT', isContentEditable }) as unknown as EventTarget;

describe('isSleepHotkey —— 裸按 Z 才切换', () => {
  test('小写与大写都认（Caps Lock 不该让快捷键失效）', () => {
    assert.equal(isSleepHotkey(ev({ key: 'z' })), true);
    assert.equal(isSleepHotkey(ev({ key: 'Z' })), true);
  });

  test('带 Ctrl / Meta / Alt 的组合键不抢', () => {
    assert.equal(isSleepHotkey(ev({ ctrlKey: true })), false);
    assert.equal(isSleepHotkey(ev({ metaKey: true })), false);
    assert.equal(isSleepHotkey(ev({ altKey: true })), false);
  });

  test('焦点在输入框 / contenteditable 里时不抢（那是打字）', () => {
    assert.equal(isSleepHotkey(ev({ target: input() })), false);
    assert.equal(isSleepHotkey(ev({ target: input(true) })), false);
  });

  test('其它键不命中，S 已经让给截图', () => {
    assert.equal(isSleepHotkey(ev({ key: 'd' })), false);
    assert.equal(isSleepHotkey(ev({ key: 's' })), false);
  });

  test('菜单文案与按键同一份事实', () => {
    assert.equal(SLEEP_HOTKEY_HINT, 'Z 键');
  });
});
