/**
 * dsh-pet desktop helper —— 「不抢焦点」与「键盘租约」的纯判定。
 *
 * 【现场（issue #<待填>）】Windows + 全屏游戏（无边框/窗口化全屏，全屏独占时置顶窗根本不可见）：
 * 光标划过桌宠身体时窗口本来就翻成可交互（pointer-target.js 的两条通道），此时在游戏里开枪/
 * 点菜单的那一下**落在桌宠窗口上** → Windows 激活这个窗口（创建时 `focusable: true`）→ 前台易主 →
 * 游戏收到失活 → 很多游戏直接最小化回桌面。用户看到的就是「误触桌宠，游戏退回桌面」。
 *
 * 【为什么不是「别收点击」】桌上点击要是能被桌宠收到的：拖拽、右键菜单、"摸头"回应全靠它。
 * 问题从来不在"收不收"，而在"收点击要不要**连带激活窗口**"。
 * Windows 的答案是 `WS_EX_NOACTIVATE`（Electron 里就是 `focusable: false`）：窗口照收鼠标、
 * 照画、照拖动、照置顶，但点击**不激活、不抢前台**——覆盖层（Steam / RTSS / 输入法浮层）的通行做法。
 *
 * 【那输入框怎么办】桌宠的「对话」要打字，而非激活窗口收不到键盘。所以键盘是**按租约给**的：
 * 只有渲染端真的把焦点放进文本控件（input / textarea / contenteditable）时才临时
 * `setFocusable(true)` + `focus()`；控件失焦、弹窗关闭、窗口失活任意一件事发生就立刻收回。
 * 结果：双击打开对话照样能打字，而任何一次误触宠物身体都不会把前台从游戏手里抢走。
 *
 * 【为什么收回要挂在 blur 上】窗口一旦失活，用户此刻无论如何都打不了字；趁机收回可激活态，
 * 让「游戏重新拿到前台之后的一次乱点」不可能再把焦点拽走——租约因此是自愈的，不靠定时器。
 *
 * 本文件只放纯判定：不 require('electron')，可被 node:test 直接加载单测（同 pointer-target.js）。
 */

'use strict';

/**
 * 需要键盘的 `<input type>` 白名单：只有「敲字」类才算。
 * 明确排除 checkbox / radio / button / submit / range / color / file —— 它们点一下就有结果，
 * 不需要窗口被激活，为它们抢前台正好是最冤的一次抢焦点。
 */
const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'password',
  'search',
  'email',
  'number',
  'tel',
  'url',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/**
 * 这个 DOM 元素被聚焦时，是否需要「窗口可激活 + 真前台」才能用？
 *
 * 只读 `tagName` / `type` / `isContentEditable` / `disabled` / `readOnly` 五个字段，
 * 所以单测可以直接喂普通对象，不必造 DOM（preload 里喂真实节点时字段天然一致）。
 *
 * `SELECT` 故意**不算**：下拉面板不需要窗口被激活（原生弹出窗口自己处理键盘），
 * 为一次下拉把前台从游戏手里抢走，属于同一类误伤的变体。
 *
 * @param {{tagName?:string,type?:string,isContentEditable?:boolean,disabled?:boolean,readOnly?:boolean}|null} target
 * @returns {boolean}
 */
function needsKeyboardFocus(target) {
  if (!target || typeof target !== 'object') return false;
  // 只读/禁用控件拿不到输入，抢前台没有意义
  if (target.disabled === true || target.readOnly === true) return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (target.isContentEditable === true) return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(target.type || '').toLowerCase());
  return false;
}

/**
 * 这一拍该对窗口做什么（= 键盘租约的唯一下发判决）。
 *
 * 调用方把自己知道的三个事实喂进来，本函数只交出「要不要改可激活态 / 要不要要前台」：
 *   - `want`      渲染端是否正把焦点放在文本控件上（键盘租约的诉求方）
 *   - `focusable` 窗口当前是否可激活（`win.isFocusable()`）
 *   - `focused`   窗口当前是否真的拿到了前台（`win.isFocused()`）
 *
 * 四种组合都要有明确去处，尤其是 `want && focusable && !focused`：解锁了却没拿到前台
 * （Windows 前台锁、或其他置顶窗抢走）时必须**再要一次**，否则用户点开对话却打不了字。
 *
 * 收回方向只有一条：只要还处于可激活态就收回去。**绝不能**在收回时动焦点或显隐
 * （那会打断用户正在做的事，也不是本函数的职责）。
 *
 * @param {{want?:boolean,focusable?:boolean,focused?:boolean}} state
 * @returns {{setFocusable?:boolean,focus?:boolean}}
 */
function activationPlan(state) {
  const want = !!(state && state.want);
  const focusable = !!(state && state.focusable);
  const focused = !!(state && state.focused);
  if (!want) {
    // 没有诉求：只要还解锁着就锁回去（已在非激活态 = 无事可做，绝不重复 setFocusable）
    return focusable ? { setFocusable: false } : {};
  }
  // 有诉求：先保证可激活，再要前台；两步一起下发，避免"解锁了但没人要前台"的中间态
  if (!focusable) return { setFocusable: true, focus: true };
  // 已可激活但没拿到前台（前台锁 / 被别的置顶窗抢走）：只要前台
  if (!focused) return { focus: true };
  return {};
}

module.exports = { TEXT_INPUT_TYPES, needsKeyboardFocus, activationPlan };
