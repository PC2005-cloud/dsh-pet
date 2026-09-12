// 系统通知引擎（client 半侧，浏览器专属）：轮询 host 通知帧队列，按「聚焦不弹」规则
// 发出系统级 toast（Web Notification API，Windows 为右下角原生通知）。
// 这是**独立于宠物**的能力（监测 DSH 事件 → 弹 toast），天然只随 DSH 网页端走；
// 桌面模式是宠物本体，不做宠物无关的功能——「两端一致」只约束宠物行为。
// 行为（帧 → 文案）来自 src/shared/notify.ts（单一来源）。
// 单一总开关：读成品配置（GET /dsh-pet-7340/config）main 条目的 notificationsEnabled；纯副作用模块，
// 无 react 依赖，由 app.ts 装配层启动。
//
// 事件路径（与 0.1.1 版的差异）：旧实现经浏览器 connection 事件流（api.events.mux / events.host）
// 订阅 DSH 事件；DSH 0.1.5 已删除这两个 API。现改为 host 侧监听 DSH 宿主事件
// （session/event 的 turn/end、approval/asked、tool/call-ask_user_question + agent/error），
// 生成与 shared/notify.ts 同契约的帧入队，本引擎 1s 轮询 /dsh-pet-7340/notify 增量拉取——
// 与 work-status/broadcast 轮询同族，帧→文案映射零改动。
// 触发清单（与 DSH 事件契约一一对应，见 shared/notify.ts）：
//   - 对话完成 / 生成失败 / 输出截断（turn/end reason.kind）
//   - 生成失败（agent/error，无回合位置）
//   - 权限申请（approval/asked）
//   - 用户选择（tool/call ask_user_question）
// 过滤：aborted / interrupted 不弹（host 侧 reduceNotifyFrame 已滤）；重连不重放历史帧
//（首拉记基线 seq，与 broadcast/work-status 首次记基线同语义）。

import { frameToToast, truncate, NOTIFY_ICONS as ICON_NAMES, type NotifyFrame } from '../shared/notify';

// ---------- 聚焦门：仅在页面不可见/失焦时弹 ----------

let pageVisible = typeof document !== 'undefined' && !document.hidden;
let pageFocused = typeof document !== 'undefined' && document.hasFocus();

function refreshVisible(): void {
  pageVisible = !document.hidden;
}
function refreshFocused(): void {
  pageFocused = document.hasFocus();
}

/** 注册聚焦/可见性监听，返回解绑函数 */
function initFocusTracking(): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', refreshVisible);
  window.addEventListener('focus', refreshFocused);
  window.addEventListener('blur', refreshFocused);
  return () => {
    document.removeEventListener('visibilitychange', refreshVisible);
    window.removeEventListener('focus', refreshFocused);
    window.removeEventListener('blur', refreshFocused);
  };
}

/** 用户是否在看本页（页面可见且持有焦点）——是则跳过通知 */
function isPageActive(): boolean {
  return pageVisible && pageFocused;
}

// ---------- 发送 ----------

/** 图标 URL（pic 路由由宿主提供：assets/pic → /dsh-pet-7340/pic/<file>） */
const PIC = (name: string): string => '/dsh-pet-7340/pic/' + name + '.png';

/** 图标 URL 表（设置页「获取权限」成功确认的测试通知也用）——文件名单一来源在 shared */
export const NOTIFY_ICONS = {
  done: PIC(ICON_NAMES.done),
  error: PIC(ICON_NAMES.error),
  truncated: PIC(ICON_NAMES.truncated),
  approval: PIC(ICON_NAMES.approval),
  question: PIC(ICON_NAMES.question),
  test: PIC(ICON_NAMES.test),
} as const;

/** 当前生效的总开关（运行中可被 reloadNotifications 更新——设置页保存后即时生效，无需刷新） */
let notifyEnabled = true;

/** 发一条系统通知；总开关关闭 / 环境不支持 / 未授权 / 聚焦本页 时静默跳过。
 * 日志（【弹窗】类型：内容）在门之后记录——只有真正发出通知时才记，被门拦下的触发不产生日志。 */
function toast(title: string, body?: string, icon?: string): void {
  if (!notifyEnabled) return;
  if (isPageActive()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  console.log('【弹窗】' + title + (body ? '：' + body : ''));
  try {
    const opts: NotificationOptions = {};
    if (body) opts.body = truncate(body);
    if (icon) opts.icon = icon;
    // 点击通知：聚焦回 DSH 页面并关闭该通知（图标加载失败只降级为无图标，绝不关闭弹窗）
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* 个别环境（e.g. 部分桌面壳）可能在构造时抛错：忽略，不打断业务 */
  }
}

/** 帧 → toast 并发出（映射来自 shared；未知帧静默跳过） */
function toastFrame(frame: NotifyFrame): void {
  const t = frameToToast(frame);
  if (!t) return;
  toast(t.title, t.body, PIC(t.icon));
}

/** 申请浏览器通知权限的结果：ok=true 已授予；ok=false 带失败原因（供设置页红字展示） */
export type PermissionResult =
  { ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'rejected' | 'error'; message?: string };

/** 申请浏览器通知权限。务必在用户手势（点击）下调用——无手势的自动申请可能被浏览器静默压制；
 * 失败时区分原因：unsupported=环境无 Notification、denied=浏览器已标记阻止、
 * rejected=用户在询问弹窗里选了阻止、error=申请过程异常/弹窗被跳过。 */
export async function requestNotificationPermission(): Promise<PermissionResult> {
  if (typeof Notification === 'undefined') return { ok: false, reason: 'unsupported' };
  if (Notification.permission === 'granted') return { ok: true };
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  try {
    const p = await Notification.requestPermission();
    if (p === 'granted') return { ok: true };
    if (p === 'denied') return { ok: false, reason: 'rejected' };
    // 弹窗被直接关掉/未选择：浏览器仍是 default
    return { ok: false, reason: 'error', message: '权限未授予（' + p + '）' };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- 总开关：成品配置 main 条目的 notificationsEnabled（合并器已按用户层/默认填好） ----------

/** 读取系统通知总开关：读成品聚合 main 条目（用户层优先、缺省回落默认，host 已合并好）；
 * 拉取/解析失败时不阻塞（默认开启）。 */
async function readNotificationsEnabled(): Promise<boolean> {
  try {
    const r = await fetch('/dsh-pet-7340/config');
    if (!r.ok) return true;
    const d = (await r.json().catch(() => null)) as { main?: { notificationsEnabled?: unknown } } | null;
    return typeof d?.main?.notificationsEnabled === 'boolean' ? d.main.notificationsEnabled : true;
  } catch {
    return true;
  }
}

/** 重读总开关（设置页保存开关后调用）；之后新触发的通知按新值执行，无需刷新页面 */
export async function reloadNotifications(): Promise<void> {
  notifyEnabled = await readNotificationsEnabled();
}

// ---------- host 通知帧轮询：1s 轻量拉取增量帧（与 work-status/broadcast 同族） ----------

/** 拉一轮 /notify（since=已消费 seq）；失败返回 null（静默，下轮再试）。 */
async function fetchNotify(seq: number): Promise<{ seq: number; frames: NotifyFrame[] } | null> {
  try {
    const r = await fetch('/dsh-pet-7340/notify?since=' + seq);
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { seq?: unknown; frames?: unknown } | null;
    if (typeof d?.seq !== 'number') return null;
    return { seq: d.seq, frames: Array.isArray(d.frames) ? (d.frames as NotifyFrame[]) : [] };
  } catch {
    return null; // 轻量轮询失败静默：下一周期再试
  }
}

/** 等一拍（1s），支持中途取消 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 启动系统通知引擎。常驻（开关在触发时按实时值判断，不用重启）；
 * 总开关开启且权限未决定时兜底申请一次权限。
 * 1s 轮询 /dsh-pet-7340/notify 拉增量帧：首拉只记基线 seq 不弹历史（页面加载不重放旧通知），
 * 之后每次递增拉新帧并逐条 toast；轮询失败静默，下轮重试；信号中止即退出。
 */
export async function startNotify(signal: AbortSignal): Promise<void> {
  notifyEnabled = await readNotificationsEnabled();
  if (typeof Notification !== 'undefined' && notifyEnabled && Notification.permission === 'default') {
    void requestNotificationPermission(); // 兜底申请（无手势时浏览器可能压制；真正的申请在设置页开关/按钮点击处）
  }
  const disposeFocus = initFocusTracking();
  let seq = 0;
  try {
    // 首拉：只记基线 seq，不弹历史帧
    const baseline = await fetchNotify(0);
    if (baseline) seq = baseline.seq;
    while (!signal.aborted) {
      await sleep(1000, signal);
      if (signal.aborted) break;
      const batch = await fetchNotify(seq);
      if (!batch || batch.seq <= seq) continue; // 无新帧：保持基线继续等
      for (const frame of batch.frames) toastFrame(frame);
      seq = batch.seq;
    }
  } finally {
    disposeFocus();
  }
}
