/**
 * dsh-pet desktop helper —— 「宿主没了就自己退」的纯判定（issue #56）。
 *
 * 背景：helper 的 stdout/stderr 是宿主给的管道（helper-process.ts: stdio ['pipe','pipe','pipe']）。
 * 宿主进程一退出，这两根管道的读端随之关闭，而 helper 下一次写（bridge 协议行 —— 渲染端每秒至少
 * 一条 /state 轮询）就会拿到 EPIPE。在 Node 里那是 process.stdout 上的 'error' 事件：
 * **没挂监听就是未捕获异常**，而 Electron 主进程自带的处理器只会弹一个模态框、且**不退出**
 * （lib/browser/init.ts 原文注释：Don't quit on fatal error）。
 *
 * 真机实测（Windows + 复现脚本，宿主保持存活、只切断 stdout 管道）：那次写之后 helper 的主线程
 * 彻底停住，14 秒里一次心跳都没有、进程也一直没退出 —— 正是报告里的"崩溃弹窗 + 赖着不走"。
 *
 * 这里只放**纯逻辑**（不 require('electron')）：helper 是随包发行的手写 JS，而开发机上又跑不起
 * Electron（受限环境里 Chromium 连自己的 Mojo 命名管道都建不了），所以判定规则必须能脱离
 * Electron 单测；主进程侧只负责"挂监听 / 起轮询 / 调用判定 / 退出"。
 */

'use strict';

/** 宿主存活探测间隔（ms）：宿主没了最多 2s 收敛；代价只是每 2s 一次 kill(pid, 0) */
const HOST_POLL_MS = 2000;

/**
 * 解析宿主 PID（DSH_PET_HOST_PID，宿主 spawn 时注入）。
 * 非法/未设 → 0：调用方据此**不做探测**。宁可留着一个桌宠等人来关，也绝不因为一个读不懂的
 * 环境变量把用户正开着的桌宠退掉。
 */
function parseHostPid(raw) {
  const pid = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

/**
 * 宿主进程是否**确定**已经不在了。
 *
 * `kill(pid, 0)` 是"只做存在性检查、不发信号"的约定（signal 0 不投递任何东西）：
 *   - 进程在 → 正常返回；没权限动它 → EPERM（**进程在**，只是不该由我们去动）；
 *   - 进程不在 → ESRCH。
 *
 * 所以**只有 ESRCH 判"没了"**：其余一律当存活。宁可多留两秒，也绝不误退用户正开着的桌宠；
 * pid <= 0（未注入/非法）同样返回 false —— 这条判定必须"宁可不退"。
 *
 * @param {number} hostPid 宿主 PID（parseHostPid 的产物）
 * @param {(pid:number, signal:number)=>void} kill 可注入，便于单测（生产用 process.kill 的包装）
 */
function hostIsGone(hostPid, kill = (pid, signal) => process.kill(pid, signal)) {
  if (!(hostPid > 0)) return false;
  try {
    kill(hostPid, 0);
    return false;
  } catch (error) {
    return Boolean(error) && error.code === 'ESRCH';
  }
}

/**
 * 这次流错误是不是"管道对端没了"。
 *
 * - EPIPE：Windows 的 ERROR_BROKEN_PIPE 与 POSIX 的 EPIPE，Node 统一给 code='EPIPE'
 *   （真机实测：宿主那侧读端关闭后，`process.stdout.write` 报 `EPIPE: broken pipe, write`，栈在
 *   `Socket._write` → `writeOrBuffer` → `Writable.write`）；
 * - ERR_STREAM_DESTROYED：同一条流首次出错后会被销毁，之后的写都是这个 —— 同样是"管道已死"。
 *
 * 两者都等于**读端不存在了 = 宿主已死**，可以据此退出；其余流错误不参与这个判定。
 */
function isBrokenPipeError(error) {
  const code = error && error.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

module.exports = { HOST_POLL_MS, parseHostPid, hostIsGone, isBrokenPipeError };
