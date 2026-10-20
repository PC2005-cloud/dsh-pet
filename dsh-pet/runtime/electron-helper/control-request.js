/**
 * dsh-pet desktop helper —— 单实例唤回的控制端点（纯逻辑）。
 *
 * 宿主与桌面壳之间只有一条既有通道：壳在 127.0.0.1 随机端口开的 bridge 回调服务器
 * （壳把 cb 地址随每条 stdout 协议行带给宿主，宿主把应答 POST 回 `/respond`）。
 * 宿主收到第二个启动请求（Electron 的 second-instance）时，反向使用同一个地址 POST `/control`，
 * 壳在这里解析动作并把**全部**宠物窗口唤回前台——不新开端口、不依赖 stderr。
 *
 * 本文件不 require('electron')、不碰 fs/env，可被 node:test 直接加载单测
 * （同 pointer-target.js / probe-command.js）。
 */

'use strict';

/**
 * 解析一次控制请求。
 *
 * 只有「POST /control + {"action":"focus"}」是合法控制请求；其它路径返回 404，
 * 这样 `/respond`（宿主应答）与 `/control`（宿主控制）不会互相串线。
 *
 * @param {{method?: string, url?: string, body?: string}} input
 * @returns {{ok: true, action: 'focus'} | {ok: false, status: number, error: string}}
 */
function parseControlRequest(input) {
  const method = String((input && input.method) || '').toUpperCase();
  const url = String((input && input.url) || '');
  if (url !== '/control') return { ok: false, status: 404, error: 'dsh-pet: not found' };
  if (method !== 'POST') return { ok: false, status: 405, error: 'dsh-pet: method not allowed' };
  let payload;
  try {
    payload = JSON.parse(String((input && input.body) || ''));
  } catch {
    return { ok: false, status: 400, error: 'dsh-pet: bad payload' };
  }
  if (!payload || typeof payload !== 'object' || payload.action !== 'focus') {
    return { ok: false, status: 400, error: 'dsh-pet: unknown action' };
  }
  return { ok: true, action: 'focus' };
}

/**
 * 把全部宠物窗口唤回前台。
 *
 * - `showInactive()`：显示窗口但不抢焦点（自启/二次启动都不该打断用户正在做的事）；
 * - `setAlwaysOnTop(true, 'screen-saver')`：重钉置顶带——外部 z 序扰动可能让窗口沉底，
 *   样式位还在但窗口不在置顶带（见 topmost-watchdog.js）；
 * - `moveTop()`：提到最前。注意它只在置顶带内有效，所以顺序必须是先重钉再 moveTop。
 *
 * 单窗抛错（窗口恰好在两次调用之间销毁）不影响其它宠物；返回真正唤回的窗口数。
 *
 * @param {Iterable<{isDestroyed(): boolean, showInactive(): void, setAlwaysOnTop(flag: boolean, level: string): void, moveTop(): void}>} windows
 * @returns {number}
 */
function focusAllWindows(windows) {
  let focused = 0;
  for (const win of windows) {
    if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed()) continue;
    try {
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
      focused += 1;
    } catch {
      /* 单窗失败（销毁竞态等）不阻塞其它宠物 */
    }
  }
  return focused;
}

module.exports = { parseControlRequest, focusAllWindows };
