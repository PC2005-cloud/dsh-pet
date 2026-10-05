/**
 * 桌面窗口前置（host 半侧）：把 DSH 主窗口从最小化还原并提到前台。
 *
 * 调用方：浏览器半侧点击系统通知后（notify.ts 的 bindNotificationClick）POST `/dsh-pet-7340/raise`。
 *
 * 为什么要绕这一圈：Electron **渲染端** `window.focus()` 只聚焦、不还原最小化窗口（还原只能由主进程
 * `win.restore()/show()` 做），而 DSH 页面拿不到任何"前置窗口"的 IPC（`window.dshDesktop` 只有
 * browser/deviceInfo/keyboard/shortcuts/updates），页面里也打不开 `dsh://`（主窗口 will-navigate 只放行
 * http/https）。所以这里借 DSH 自己注册的 `dsh://` 协议**再启动一次**：第二个实例抢单实例锁失败后
 * 立刻退出，已有实例收到 `second-instance` → `focusPrimaryWindow()` → restore + show + focus。
 * 该协议随 DSH Desktop 安装注册（`HKCU\Software\Classes\dsh`）；实测热态约 0.2s 完成前置
 * （冷启动第一次约 1.4s：协议解析 + 加载 244MB 的 exe）。
 *
 * 平台：只有 Windows 桌面壳有 `dsh://` 与单实例前置语义，其余平台直接返回 false（浏览器里本就不该调）。
 */
import { spawn } from 'node:child_process';

/** 连点节流：进程已在起的路上就不再起第二个（避免连点刷出一串第二实例） */
export const RAISE_THROTTLE_MS = 1000;

/** 上一次发起前置的时间戳（0 = 本进程还没发起过） */
let lastRaiseAt = 0;

/**
 * spawn 子进程用的环境变量：**必须删除 `ELECTRON_RUN_AS_NODE`**（与 issue #63 同一类坑）。
 *
 * 宿主（DSH Desktop 的 dsh-desktop-host）自己的 `process.env` 里带着这个键（外壳 fork 宿主时就设了），
 * 原样透传 → `cmd /c start` 拉起的 `DeepSeek Harness.exe` 会以**纯 Node 模式**启动：它把 `dsh://open`
 * 当成模块名去 require，几十毫秒后 `MODULE_NOT_FOUND` 崩掉（实测 exit code 1 / 38ms）——于是既没有
 * 第二实例、也没人去抢单实例锁、更不会还原窗口（用户看到的就是"点了通知没反应"）。
 * 删掉该键后同一条命令实测 130~220ms 完成窗口前置。
 *
 * 为什么是"删除"而不是设成空串：Electron 只看该键**存不存在**（设 `''` 会直接 abort）。
 */
export function desktopSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 发起一次窗口前置。
 * @param now - 当前时间戳；测试可注入，默认 `Date.now()`
 * @returns 是否成功发起（真正的还原由已有实例完成；节流命中 / 非 Windows / spawn 失败都返回 false，静默）
 */
export function raiseDesktopWindow(now: number = Date.now()): boolean {
  if (process.platform !== 'win32') return false;
  if (now - lastRaiseAt < RAISE_THROTTLE_MS) return false;
  lastRaiseAt = now;
  try {
    // windowsHide：不闪控制台窗；detached + stdio ignore：第二实例与宿主脱钩，宿主退出不受其影响。
    // env 必须走 desktopSpawnEnv：否则子进程继承 ELECTRON_RUN_AS_NODE，拉起的 exe 以 Node 模式当场崩掉。
    spawn('cmd.exe', ['/c', 'start', '', 'dsh://open'], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: desktopSpawnEnv(),
    }).unref();
    return true;
  } catch {
    return false;
  }
}
