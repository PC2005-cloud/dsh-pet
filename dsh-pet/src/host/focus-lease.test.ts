/**
 * 桌面 helper「不抢焦点 + 键盘租约」的判定 + 源码守卫。
 *
 * 背景（issue #139）：全屏游戏里光标划过桌宠身体，窗口被 pointer-target 的两条通道翻成可交互；
 * 开枪/点菜单那一下落在桌宠上，Windows 就激活了这个 `focusable:true` 的置顶窗 → 前台易主 →
 * 游戏随即最小化回桌面。修法两层：
 *   ① 窗口默认**不可激活**（`focusable:false` = Windows `WS_EX_NOACTIVATE`）：点击照收、拖拽照走、
 *      右键菜单照弹，但不激活、不抢前台；
 *   ② 「对话」要打字，而键盘只能由前台窗口收：按**租约**临时解锁（手指落到文本控件才给，
 *      失焦/弹窗关闭/窗口失活立刻收回）。
 *
 * 本文钉三件事：
 *   ① 判定规则：哪些 DOM 元素才算"要键盘"；want × focusable × focused 四种状态各自该做什么；
 *   ② 收回方向只许动可激活态，绝不顺手改焦点/显隐（那会打断用户正在做的事）；
 *   ③ 源码守卫：main.js / preload.js 必须真的按这套规则接线（Electron 在这里起不来，只能读源码断言），
 *      且 `setIgnoreMouseEvents` 仍必须是**唯一出口**（否则又会出现两条通道抢着翻同一个窗口）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { TEXT_INPUT_TYPES, needsKeyboardFocus, activationPlan } = require(helper + 'focus-lease.js');

/** 包内文件源码（守卫用） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** 去掉注释再断言：注释里讨论 `setIgnoreMouseEvents` / `require('electron')` 是正常的，不能当成调用点 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const mainSrc = readSource(helper + 'main.js');
const mainCode = stripComments(mainSrc);
const preloadCode = stripComments(readSource(helper + 'preload.js'));
const policyCode = stripComments(readSource(helper + 'focus-lease.js'));

describe('needsKeyboardFocus —— 只有"要敲字"的控件才算要键盘', () => {
  test('文本输入类 input 全部算', () => {
    for (const type of ['', 'text', 'password', 'search', 'email', 'number', 'tel', 'url', 'date', 'time']) {
      assert.equal(needsKeyboardFocus({ tagName: 'INPUT', type }), true, `input[type=${type}]`);
    }
    assert.equal(needsKeyboardFocus({ tagName: 'INPUT' }), true, 'input 不给 type 时按 text');
  });

  test('textarea 与 contenteditable 算', () => {
    assert.equal(needsKeyboardFocus({ tagName: 'TEXTAREA' }), true);
    assert.equal(needsKeyboardFocus({ tagName: 'DIV', isContentEditable: true }), true);
  });

  test('点一下就有结果、不需要被激活的控件不算', () => {
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']) {
      assert.equal(needsKeyboardFocus({ tagName: 'INPUT', type }), false, `input[type=${type}]`);
    }
  });

  test('select 不算：下拉面板自己处理键盘，为一次下拉抢前台是同一类误伤', () => {
    assert.equal(needsKeyboardFocus({ tagName: 'SELECT' }), false);
  });

  test('禁用 / 只读 / 非元素 / null 一律不算', () => {
    assert.equal(needsKeyboardFocus({ tagName: 'INPUT', disabled: true }), false);
    assert.equal(needsKeyboardFocus({ tagName: 'TEXTAREA', readOnly: true }), false);
    assert.equal(needsKeyboardFocus({ tagName: 'DIV' }), false);
    assert.equal(needsKeyboardFocus({}), false);
    assert.equal(needsKeyboardFocus(null), false);
    assert.equal(needsKeyboardFocus(undefined), false);
  });

  test('tagName 大小写不敏感（真实 DOM 给的是大写，别把兼容写法钉死）', () => {
    assert.equal(needsKeyboardFocus({ tagName: 'input', type: 'text' }), true);
    assert.equal(needsKeyboardFocus({ tagName: 'TextArea' }), true);
  });

  test('TEXT_INPUT_TYPES 是白名单本体：空串必须在内（type 缺省即文本）', () => {
    assert.equal(TEXT_INPUT_TYPES.has(''), true);
    assert.equal(TEXT_INPUT_TYPES.has('checkbox'), false);
  });
});

describe('activationPlan —— 这一拍该不该解锁 / 该不该要前台', () => {
  test('没有诉求且已经是非激活态：什么都不做（绝不重复 setFocusable）', () => {
    assert.deepEqual(activationPlan({ want: false, focusable: false, focused: false }), {});
    assert.deepEqual(activationPlan({}), {});
  });

  test('没有诉求但还解锁着：收回去，**只要** setFocusable', () => {
    const plan = activationPlan({ want: false, focusable: true, focused: true });
    assert.deepEqual(plan, { setFocusable: false });
    assert.equal('focus' in plan, false, '收回方向不得动焦点');
    assert.equal('show' in plan, false, '收回方向不得动显隐');
  });

  test('有诉求且还锁着：解锁 + 要前台，两步一起下发', () => {
    assert.deepEqual(activationPlan({ want: true, focusable: false, focused: false }), {
      setFocusable: true,
      focus: true,
    });
    // 已解锁但没拿到前台（前台锁 / 被别的置顶窗抢走）时同样要一次，否则用户点开对话打不了字
    assert.deepEqual(activationPlan({ want: true, focusable: false, focused: true }), {
      setFocusable: true,
      focus: true,
    });
  });

  test('有诉求、已解锁但没前台：只补一次前台', () => {
    assert.deepEqual(activationPlan({ want: true, focusable: true, focused: false }), { focus: true });
  });

  test('有诉求且已在前台：无事可做（不抖动）', () => {
    assert.deepEqual(activationPlan({ want: true, focusable: true, focused: true }), {});
  });

  test('纯函数：同一状态反复求判决结果一致', () => {
    const state = { want: true, focusable: false, focused: false };
    assert.deepEqual(activationPlan(state), activationPlan({ ...state }));
  });
});

describe('源码守卫 —— 接线必须真的按这套规则走', () => {
  test('建窗默认不可激活，且不再留 focusable:true', () => {
    assert.match(mainSrc, /focusable: false,/);
    assert.equal(/focusable: true,/.test(mainSrc), false, 'main.js 里不得再有可激活建的建窗选项');
  });

  test('main.js 有租约落地函数与 IPC 入口', () => {
    assert.match(mainSrc, /function applyKeyboardLease\(win, want\)/);
    assert.match(mainSrc, /ipcMain\.on\('pet:keyboard-focus'/);
    assert.match(mainSrc, /activationPlan\(\{ want, focusable: win\.isFocusable\(\), focused: win\.isFocused\(\) \}\)/);
  });

  test('失活即收回（自愈，不靠定时器）', () => {
    assert.match(mainSrc, /win\.on\('blur', \(\) => applyKeyboardLease\(win, false\)\)/);
  });

  test('拿到前台后必须回执，让 preload 把光标还给输入框', () => {
    assert.match(mainSrc, /webContents\.send\('pet:keyboard-granted'\)/);
  });

  test('preload 的租约触发必须挂在 pointerdown 上（非激活窗里 focusin 不发声）', () => {
    assert.match(preloadCode, /needsKeyboardFocus/);
    assert.match(preloadCode, /addEventListener\(\s*'pointerdown'/);
    assert.match(preloadCode, /addEventListener\(\s*'focusin'/);
    assert.match(preloadCode, /document\.hasFocus\(\)/, '收回前必须判窗口是否还活着，否则会把租约又抢回来');
    assert.match(preloadCode, /'pet:keyboard-granted'/);
  });

  test('setIgnoreMouseEvents 在 main.js 里仍然只有唯一出口', () => {
    const hits = mainCode.split('.setIgnoreMouseEvents(').length - 1;
    assert.equal(hits, 1, `.setIgnoreMouseEvents 出现 ${hits} 次（应恰好 1 次，全部经 setWindowIgnore）`);
    assert.match(
      mainCode,
      /function setWindowIgnore\(win, ignore\) \{\s*win\.setIgnoreMouseEvents\(ignore, \{ forward: true \}\);/,
    );
  });

  test('判定模块自己不碰 Electron，才能被 node:test 直接加载', () => {
    assert.equal(/require\(\s*['"]electron['"]\s*\)/.test(policyCode), false);
    assert.match(policyCode, /module\.exports = \{ TEXT_INPUT_TYPES, needsKeyboardFocus, activationPlan \}/);
  });
});
