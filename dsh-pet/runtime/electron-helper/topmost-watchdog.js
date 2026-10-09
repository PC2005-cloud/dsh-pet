/**
 * dsh-pet desktop helper —— 置顶看门狗（纯判定部分）。
 *
 * 【现场】0.3.6 桌面模式，Windows + 双屏，DSH 主窗最大化：桌宠整只沉到 DSH 主窗下面，
 * 用户看到的就是「宠物不见了」——而进程活着、渲染也正常（PrintWindow 抓得到宠物和气泡）、
 * 动画照跑，就是屏幕上没有。实测 z 序：DSH 主窗（普通窗，非置顶）在桌宠窗之上，
 * 而桌宠窗的 `WS_EX_TOPMOST` 位**仍然是真**。
 *
 * 【为什么样式位为真也说明不了问题】`WS_EX_TOPMOST` 只是**样式位**，窗口在不在「置顶带」是
 * 另一回事：Win32 规定该位必须经 `SetWindowPos(HWND_TOPMOST | HWND_NOTOPMOST)` 才能真正落带，
 * 直接写 `GWL_EXSTYLE` 只会把位写上去、**不会**把窗口挪回置顶带——于是出现「位在、带不在」
 * 这个自相矛盾的状态（本机实测：对已沉底的窗口按 `GetWindowLong` 原值或回写该位，窗口依旧在
 * 普通带里）。而 Electron 在 Windows 上翻转点击穿透用的正是 `SetWindowLong(GWL_EXSTYLE)`
 * 读-改-写（native_window_views.cc 的 `SetIgnoreMouseEvents`）：桌宠每进出一次身体命中区、
 * 外加 60ms 兜底轮询，都会把它写一遍，所以这个位随时可能被写回，却与「谁在最上面」无关。
 *
 * 【为什么要复查】建窗时那一次 `setAlwaysOnTop(true, 'screen-saver')` 之后再没有任何地方检查过
 * 窗口是否还在置顶带；外部任何一次 z 序扰动（桌面上同时跑着多个置顶浮层：输入法候选、别的桌宠、
 * 桌面歌词、任务栏……）都可能让桌宠永久沉底，直到 helper 重启才恢复。
 *
 * 【为什么可以无脑复查】`setAlwaysOnTop(true, 'screen-saver')` 在 Electron / Chromium 里最终就是
 * 一次 `SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)`
 * （NativeWindowViews::SetAlwaysOnTop → DesktopWindowTreeHostWin::SetZOrderLevel →
 * HWNDMessageHandler::SetAlwaysOnTop，全链无早退、无状态比较）：不移动、不缩放、不重绘、不抢焦点。
 * 反过来，`moveTop()`（HWND_TOP）对已沉底的窗口**无效**（实测仍在普通带里），不能拿来当兜底。
 *
 * 本文件只放纯判定：不 require('electron')，可被 node:test 直接加载单测（同 pointer-target.js）。
 */

'use strict';

/** 看门狗节拍（ms）：多久做一次判定。判定本身不碰窗口，只是决定这一拍要不要重钉 */
const TOPMOST_WATCHDOG_TICK_MS = 1000;

/** 重新置顶的最小间隔（ms）：真正的 SetWindowPos 至多这么频繁（低频，避免和别的置顶窗抢带） */
const TOPMOST_REASSERT_MS = 5000;

/**
 * 这一拍要不要重新置顶。
 *
 * 只在「窗口还在、可见、没被冒烟自检挂起」且「距上次重钉已够久」时返回 true：
 * 隐藏期间钉了没意义（show 之后本来就会进带），冒烟自检期间钉了会干扰断言；
 * 而这些条件随时会变（渲染端首帧、自检结束），所以判定每秒跑一次、这一拍被拦就下一拍补上。
 *
 * @param {{nowMs:number,lastAssertMs:number,destroyed:boolean,visible:boolean,paused:boolean}} state
 * @returns {boolean}
 */
function shouldReassertTopmost(state) {
  const { nowMs, lastAssertMs, destroyed, visible, paused } = state || {};
  if (destroyed || !visible || paused) return false;
  const elapsed = nowMs - lastAssertMs;
  // 只有「时间正常流逝且还没到点」才不钉；时钟被回拨 / 时间戳异常一律按到点处理（重钉无副作用）
  return !(elapsed >= 0 && elapsed < TOPMOST_REASSERT_MS);
}

module.exports = { TOPMOST_WATCHDOG_TICK_MS, TOPMOST_REASSERT_MS, shouldReassertTopmost };
