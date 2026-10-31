/**
 * 「按住说话」状态机的单测：按下只开录一次、按住期间的自动重复必须被吃掉、松开才收尾。
 *
 * 为什么值得钉：这几条错了都不是抛错，而是静默走偏——重复事件漏拦会往输入框里灌一串 v，
 * 松开漏判会让录音一直开到 24 秒上限。两种都只能在真机上「感觉不对」，测试才看得见。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createHearHold, isHearHotkey } from './hear-hold.ts';
import type { HotkeyEvent } from '../hotkey.ts';

/** 只造判据用到的字段，不需要真的 KeyboardEvent。 */
const ev = (over: Partial<HotkeyEvent & { repeat: boolean }> = {}): HotkeyEvent & { repeat?: boolean } => ({
  key: 'm',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: null,
  repeat: false,
  ...over,
});

/** 造一个带 tagName 的假元素。 */
const tag = (tagName: string, editable = false): EventTarget =>
  ({ tagName, isContentEditable: editable }) as unknown as EventTarget;

/** 一个记了次数的状态机；armed 可以中途改，模拟光标离开宠物。 */
function harness(): {
  hold: ReturnType<typeof createHearHold>;
  counts: { press: number; release: number };
  arm: (next: boolean) => void;
} {
  const counts = { press: 0, release: 0 };
  let armed = true;
  const hold = createHearHold({
    isArmed: () => armed,
    onPress: () => {
      counts.press += 1;
    },
    onRelease: () => {
      counts.release += 1;
    },
  });
  return { hold, counts, arm: (next) => (armed = next) };
}

describe('isHearHotkey', () => {
  test('小写与大写 M 都算', () => {
    assert.equal(isHearHotkey(ev({ key: 'm' })), true);
    assert.equal(isHearHotkey(ev({ key: 'M' })), true);
  });

  test('其它键不算（原来的 V 已经让位）', () => {
    for (const key of ['v', 't', 'd', 's', 'a', 'Enter', ' ', 'Escape']) {
      assert.equal(isHearHotkey(ev({ key })), false, key);
    }
  });

  test('带修饰键不算（Ctrl+M 等留给浏览器）', () => {
    assert.equal(isHearHotkey(ev({ ctrlKey: true })), false);
    assert.equal(isHearHotkey(ev({ metaKey: true })), false);
    assert.equal(isHearHotkey(ev({ altKey: true })), false);
  });

  test('焦点在输入框里也算（弹窗一开焦点就在那儿，那才是说话的时候）', () => {
    for (const target of [tag('INPUT'), tag('TEXTAREA'), tag('SELECT'), tag('DIV', true)]) {
      assert.equal(isHearHotkey(ev({ target })), true);
    }
  });
});

describe('createHearHold', () => {
  test('悬停时按下：吃掉事件并开录一次', () => {
    const { hold, counts } = harness();
    assert.equal(hold.onKeyDown(ev()), true, '按下的 V 必须被吃掉，否则会打出一个 v');
    assert.equal(counts.press, 1);
  });

  test('光标不在宠物上：不触发，也不吃事件', () => {
    const { hold, counts, arm } = harness();
    arm(false);
    assert.equal(hold.onKeyDown(ev()), false);
    assert.equal(counts.press, 0);
  });

  test('别的键与带修饰键都不吃', () => {
    const { hold, counts } = harness();
    assert.equal(hold.onKeyDown(ev({ key: 'a' })), false);
    assert.equal(hold.onKeyDown(ev({ ctrlKey: true })), false);
    assert.equal(counts.press, 0);
  });

  test('光标在输入框里按下：照样开录（焦点不再是闸门）', () => {
    const { hold, counts } = harness();
    assert.equal(hold.onKeyDown(ev({ target: tag('TEXTAREA') })), true);
    assert.equal(counts.press, 1);
  });

  test('按住期间的自动重复全部吃掉，但不重复开录', () => {
    const { hold, counts } = harness();
    hold.onKeyDown(ev());
    for (let i = 0; i < 5; i++) assert.equal(hold.onKeyDown(ev({ repeat: true })), true, `第 ${i} 次重复`);
    assert.equal(counts.press, 1);
  });

  test('按住期间焦点已进输入框：重复事件照样吃掉（否则会往框里灌 v）', () => {
    const { hold } = harness();
    hold.onKeyDown(ev());
    assert.equal(hold.onKeyDown(ev({ repeat: true, target: tag('TEXTAREA') })), true);
    assert.equal(hold.onKeyDown(ev({ target: tag('TEXTAREA') })), true);
  });

  test('按住期间按到别的键：不管它', () => {
    const { hold, counts } = harness();
    hold.onKeyDown(ev());
    assert.equal(hold.onKeyDown(ev({ key: 'a', repeat: true })), false);
    assert.equal(counts.release, 0);
  });

  test('松开同一个键才收尾，且只收一次', () => {
    const { hold, counts } = harness();
    hold.onKeyDown(ev());
    hold.onKeyUp(ev({ key: 'M' }));
    assert.equal(counts.release, 1);
    hold.onKeyUp(ev({ key: 'm' }));
    assert.equal(counts.release, 1, '多出来的 keyup 不该再收一次尾');
  });

  test('松开别的键不收尾', () => {
    const { hold, counts } = harness();
    hold.onKeyDown(ev());
    hold.onKeyUp(ev({ key: 'a' }));
    assert.equal(counts.release, 0);
  });

  test('没按住时松开：什么都不做', () => {
    const { hold, counts } = harness();
    hold.onKeyUp(ev());
    assert.equal(counts.release, 0);
  });

  test('release() 强制收尾（窗口失焦收不到 keyup 时走这条）', () => {
    const { hold, counts } = harness();
    hold.onKeyDown(ev());
    hold.release();
    assert.equal(counts.release, 1);
    hold.release();
    assert.equal(counts.release, 1, 'release 必须幂等');
  });

  test('松开之后还能再按住一次', () => {
    const { hold, counts } = harness();
    hold.onKeyDown(ev());
    hold.onKeyUp(ev());
    hold.onKeyDown(ev());
    assert.equal(counts.press, 2);
    assert.equal(counts.release, 1);
  });

  test('第一次就是自动重复（没有真正的按下）：不启动', () => {
    const { hold, counts } = harness();
    assert.equal(hold.onKeyDown(ev({ repeat: true })), false);
    assert.equal(counts.press, 0);
  });
});
