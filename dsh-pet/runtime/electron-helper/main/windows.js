'use strict';
/**
 * 桌面宠物窗口：建窗、整窗穿透镜像、宠物状态广播、任务栏保持、两条实时泵。
 *
 * 窗口表与按窗口索引的几张表都由本模块独占（`state` 只给同进程的装配根与 ipc 用，不是对外接口）。
 * 两条泵的生命周期跟着窗口：建窗起跑，`closed` 时停止并清句柄——泵自己不清，因为同一窗口上还有别的清理。
 * @module dsh-pet/runtime/electron-helper/main/windows
 */
const path = require('node:path');
const { pointerZone, decideWindowIgnore } = require('../pointer-target.js');
const { TOPMOST_WATCHDOG_ENABLED, TOPMOST_WATCHDOG_TICK_MS } = require('../topmost-watchdog.js');
const { TASKBAR_WATCHDOG_TICK_MS, shouldRunTaskbarWatchdog } = require('../taskbar-watchdog.js');

/** 兜底通道的光标轮询间隔（ms）。 */
const POINTER_POLL_MS = 60;

/**
 * 输入模型。
 *
 * `ignore` = 历史实现：`setIgnoreMouseEvents` 翻转 + 主进程光标轮询（Windows/macOS 默认，行为不变）。
 * `shape`  = Linux 默认：永不调用 `setIgnoreMouseEvents`，改用 `win.setShape(rects)`——形状之外
 *            **既不绘制也不接收鼠标**，事件落到下层应用。渲染端上报"宠物主体盒 + 覆盖层矩形"，
 *            主进程只负责应用，不需要任何光标轮询。
 * `always` = 整窗永远可交互（不穿透）。`setShape` 在某些合成器上不可用时的兜底。
 *
 * 为什么 Linux 不能用 `ignore`：X11 分支里 ignore=true 把窗口 ShapeInput 设成 1×1
 * （`x11::Shape::Rectangles`），ignore=false 才用 `Mask(source_bitmap: None)` 清掉；而 Xwayland 的
 * 输入区域取自 ShapeInput（`xwl_window_set_input_region(..., wInputShape(toplevel))`），清不干净
 * 就永久停在 1×1 穿透态——宠物看得见、钉得稳，鼠标却全部落到下层应用，点不中、拖不动。
 * @type {'ignore' | 'shape' | 'always'}
 */
const INPUT_MODE = (() => {
  const raw = String(process.env.DSH_PET_INPUT || '')
    .trim()
    .toLowerCase();
  if (raw === 'shape' || raw === 'ignore' || raw === 'always') return raw;
  return process.platform === 'linux' ? 'shape' : 'ignore';
})();

/** 空列表会被忽略：`setShape([])` 的语义是"恢复矩形窗口"，那会让整窗可交互、挡住下层应用。 */
function sanitizeShapeRects(rects) {
  const clean = [];
  for (const r of Array.isArray(rects) ? rects : []) {
    if (!r) continue;
    const x = Math.round(Number(r.x));
    const y = Math.round(Number(r.y));
    const width = Math.round(Number(r.width));
    const height = Math.round(Number(r.height));
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    clean.push({ x, y, width, height });
  }
  return clean;
}

/**
 * 造窗口能力。
 *
 * @param deps.BrowserWindow - Electron BrowserWindow 构造器。
 * @param deps.screen - Electron screen（逐屏几何）。
 * @param deps.buildDeskGeometry - desktop-geometry.js 的纯函数（屏幕列表 → 几何）。
 * @param deps.dpi - DPI/指针能力（petScale 与 currentPointer）。
 * @param deps.helperDir - runtime/electron-helper 的绝对目录（index.html、preload.js、图标都在里面）。
 * @param deps.isBridge - 是否 bridge 模式（渲染端据此切换协议地址）。
 * @param deps.openTarget - 「打开网站」的去向（desktop / site）。
 * @param deps.platform - 托盘与置顶的平台差异（tray-platform.js 的判定）。
 * @param deps.shouldReassertTopmost - 看门狗的纯判定。
 * @param deps.topmostLevel - 平台对应的置顶层级。
 * @param deps.taskbarWatchdogEnabled - 任务栏看门狗总开关（main.js 按 DSH_PET_TASKBAR_WATCHDOG 传入）。
 */
function createWindows({
  BrowserWindow,
  screen,
  buildDeskGeometry,
  dpi,
  helperDir,
  isBridge,
  openTarget,
  platform,
  shouldReassertTopmost,
  topmostLevel,
  taskbarWatchdogEnabled,
}) {
  /** 窗口表：petId -> BrowserWindow */
  const windows = new Map();
  /** win.id -> 上一次请求的内容区矩形（"x,y,w,h"）：pet:set-bounds 的去重基准 */
  const lastRequestedBounds = new Map();
  /** win.id -> 渲染端上报的窗口余量 `{ l, t }`：上边距按气泡加高后余量不再四边相等，命中区不能按宽反推 */
  const winMargins = new Map();
  /** 每窗口当前穿透状态的镜像（Electron 没有取值 API）：所有翻转都经 setWindowIgnore */
  const windowIgnore = new Map();
  /** 每窗口「渲染端正拿着鼠标输入」标记，由渲染端经 pet:input-busy 上报 */
  const inputBusy = new Map();
  /** 新渲染端把菜单/聊天框局部矩形单独上报，避免忙碌态下整窗透明余量吞点击 */
  const inputRegions = new Map();
  /** 每窗口「光标停在余量区且非 busy」的连续时长（ms）：到点由兜底通道强制恢复穿透 */
  const offBodyMs = new Map();
  /** 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad } */
  const petStates = new Map();
  /** 冒烟期间暂停兜底泵：它按真实光标翻转，会干扰冒烟对渲染端通道的断言 */
  let pointerFallbackPaused = false;

  /** 把当前全量宠物状态广播给所有窗口（碰撞检测的共享站场）。 */
  function broadcastPetStates() {
    const states = {};
    for (const [pid, s] of petStates) {
      states[pid] = { x: s.x, y: s.y, vx: s.vx, vy: s.vy, size: s.size, bottomPad: s.bottomPad };
    }
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:flight-states', states);
    }
  }

  /** 记录/更新一只宠物的状态并广播。 */
  function updatePetState(petId, partial) {
    const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
    petStates.set(petId, Object.assign({}, prev, partial));
    broadcastPetStates();
  }

  /** win.id -> 上一次应用过的形状（JSON）：形状逐帧算也没关系，重复值不发系统调用。 */
  const windowShapeKey = new Map();

  /** 翻转整窗穿透的唯一出口：状态与镜像永远一起更新（穿透期间保留 forward）。 */
  function setWindowIgnore(win, ignore) {
    // 先记镜像（兜底轮询 / 冒烟断言都读它），再决定要不要真的调系统 API。
    windowIgnore.set(win.id, ignore);
    // `shape` / `always` 模式下**绝不调用 setIgnoreMouseEvents**：X11 上 ignore=true 会把窗口
    // ShapeInput 设成 1×1，而 ignore=false 那步在 KDE/KWin + XWayland 实测清不回来 → 窗口永久穿透。
    if (INPUT_MODE !== 'ignore') return;
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }

  /**
   * 应用窗口形状（仅 `shape` 模式）。`rects` 是**窗口内容区坐标**。
   * @param win 目标窗口。
   * @param rects 形状矩形列表。
   */
  function applyWindowShape(win, rects) {
    if (INPUT_MODE !== 'shape') return;
    const clean = sanitizeShapeRects(rects);
    if (clean.length === 0) return;
    const key = JSON.stringify(clean);
    if (windowShapeKey.get(win.id) === key) return;
    windowShapeKey.set(win.id, key);
    try {
      if (typeof win.setShape === 'function') win.setShape(clean);
    } catch (error) {
      console.error(
        '[dsh-pet-desktop-helper] setShape failed:',
        String(error && error.message ? error.message : error),
      );
    }
  }

  /**
   * 建窗时的临时形状：渲染端首帧上报前，别让整窗（含四周透明余量）一直挡点击。
   * @param sizePx 宠物包围盒边长（物理像素）。
   * @param winW 窗口内容区宽。
   * @param winH 窗口内容区高。
   */
  function initialShapeFor(sizePx, winW, winH) {
    const w = Math.max(8, Math.min(winW, sizePx));
    const h = Math.max(8, Math.min(winH, (sizePx * 360) / 640));
    return [
      {
        x: Math.round((winW - w) / 2),
        y: Math.round(Math.max(0, (winH - h) / 2)),
        width: Math.round(w),
        height: Math.round(h),
      },
    ];
  }

  /** 桌面几何：逐屏工作区、外接矩形、主屏下标；边界判定必须走 areas 的并集而不是 hull。 */
  function deskGeometry() {
    return buildDeskGeometry(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.platform);
  }

  /** 桌面宠物列表（[{id,size,index}]）：宿主经 DSH_PET_PETS 透传；空数组表示明确不建窗。 */
  function petsFromEnv() {
    try {
      const arr = JSON.parse(process.env.DSH_PET_PETS || '');
      if (Array.isArray(arr)) {
        return arr.map((pet, index) => ({
          id: String(pet?.id ?? `pet-${index}`),
          size: Number(pet?.size) > 0 ? Number(pet.size) : 462,
          index,
        }));
      }
    } catch {
      /* fallthrough */
    }
    return [{ id: 'main', size: 462, index: 0 }];
  }

  /** 窗口初始尺寸 = 宠物包围盒 + 四周外扩余量；渲染端首帧会按真实配置精确覆盖。 */
  function petWindowSize(size) {
    const height = (size * 9) / 16;
    const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
    const m = Math.round(size * 0.5);
    return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
  }

  /** 单次重申（幂等）：show 的异步重建路径与看门狗共用。 */
  function reassertTaskbar(win) {
    if (!win || win.isDestroyed()) return;
    win.setSkipTaskbar(true);
  }

  /** 把窗口从任务栏摘掉：show 后 Shell 会异步重建按钮，紧跟一次 0ms 的第二次调用才算数。 */
  function keepOffTaskbar(win) {
    reassertTaskbar(win);
    setTimeout(() => reassertTaskbar(win), 0);
  }

  /** 看门狗定时器句柄；null 表示未启动。 */
  let taskbarWatchdogTimer = null;

  /** 启动任务栏看门狗：仅 Windows 且总开关开启；重复调用无副作用。 */
  function startTaskbarWatchdog() {
    if (taskbarWatchdogTimer || !shouldRunTaskbarWatchdog(process.platform, taskbarWatchdogEnabled)) return;
    taskbarWatchdogTimer = setInterval(() => {
      for (const win of windows.values()) reassertTaskbar(win);
    }, TASKBAR_WATCHDOG_TICK_MS);
    taskbarWatchdogTimer.unref?.();
  }

  /** 停止看门狗：进程退出前调用，避免定时器拖住退出。 */
  function stopTaskbarWatchdog() {
    if (!taskbarWatchdogTimer) return;
    clearInterval(taskbarWatchdogTimer);
    taskbarWatchdogTimer = null;
  }

  /** 穿透兜底泵：正规翻转链路只有 forward 鼠标钩子，它在 Windows 上可能静默失效。 */
  function startPointerFallback(win) {
    const pointerTimer = setInterval(() => {
      // `shape` 模式不用光标轮询：窗口形状已经决定了哪里接收鼠标；`always` 模式整窗可交互。
      if (INPUT_MODE !== 'ignore') return;
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const bounds = win.getBounds();
      if (bounds.width < 8 || bounds.height < 8) return; // 尺寸还没落定（首帧上报前）
      const ignoring = windowIgnore.get(win.id) !== false;
      const busy = inputBusy.get(win.id) === true;
      const point = dpi.currentPointer();
      const margin = winMargins.get(win.id);
      const zone = pointerZone(bounds, point, margin);
      const nextMs = !busy && zone === 'margin' ? (offBodyMs.get(win.id) ?? 0) + POINTER_POLL_MS : 0;
      offBodyMs.set(win.id, nextMs);
      const next = decideWindowIgnore(bounds, point, ignoring, busy, nextMs, inputRegions.get(win.id), margin);
      if (next !== ignoring) setWindowIgnore(win, next);
    }, POINTER_POLL_MS);
    return () => clearInterval(pointerTimer);
  }

  /** 置顶看门狗：WS_EX_TOPMOST 位还在不代表真的在置顶带，低频重钉一次（总开关见 TOPMOST_WATCHDOG_ENABLED）。 */
  function startTopmostWatchdog(win) {
    let lastTopmostAssertMs = Date.now();
    const topmostTimer = setInterval(() => {
      const nowMs = Date.now();
      const due = shouldReassertTopmost(
        {
          nowMs,
          lastAssertMs: lastTopmostAssertMs,
          destroyed: win.isDestroyed(),
          visible: win.isVisible(),
          paused: pointerFallbackPaused,
        },
        TOPMOST_WATCHDOG_ENABLED,
      );
      if (!due) return;
      lastTopmostAssertMs = nowMs;
      win.setAlwaysOnTop(true, topmostLevel(process.platform));
    }, TOPMOST_WATCHDOG_TICK_MS);
    return () => clearInterval(topmostTimer);
  }

  /** 建窗口时的固定参数（与渲染端约定的透明置顶小窗）。 */
  function windowOptions(size, area) {
    return {
      ...size,
      x: area.x, // 初始左上角；renderer 首帧按配置角落/位置校正
      y: area.y,
      show: false,
      useContentSize: true,
      // macOS 默认会把已显示窗口的 y 钳到菜单栏下沿；局部画布的透明余量必须允许伸出屏幕
      enableLargerThanScreen: true,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // 任务栏按钮万一还是冒出来（唤醒后重建），至少显示宠物图标而不是 Electron 默认原子图
      icon: path.join(helperDir, '..', '..', 'assets', 'logo.png'),
      resizable: false,
      hasShadow: false,
      // 可聚焦：对话输入框/菜单需要焦点才能打字；显示用 showInactive()，不打断其它应用
      focusable: true,
      webPreferences: {
        preload: path.join(helperDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        paintWhenInitiallyHidden: false,
        spellcheck: false,
      },
    };
  }

  /** 一只宠物一个窗口；返回窗口，泵与清理都在这里装好。 */
  function createPetWindow(pet, geo, scale) {
    const initialSize = petWindowSize(pet.size * scale);
    const win = new BrowserWindow(windowOptions(initialSize, geo.hull));
    win.setAlwaysOnTop(true, topmostLevel(process.platform));
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 被遮挡的窗口默认暂停渲染，表现成「消失」；关掉后台节流让它持续渲染
    win.webContents.setBackgroundThrottling(false);
    // 屏蔽 Electron 默认右键菜单：右键菜单由渲染端统一自绘，绝无双菜单
    win.webContents.on('context-menu', (event) => event.preventDefault());
    // 页面级缩放与渲染端 CONFIG.scale 同源；show:false 的窗口 zoomFactor 不生效，须加载后设置
    win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(scale));
    setWindowIgnore(win, true);
    // `shape` 模式：先给一个"宠物包围盒"量级的形状，渲染端首帧上报后再换成精确值
    // （否则从建窗到首帧之间，整窗矩形会把下方应用的点击吞掉）
    applyWindowShape(win, initialShapeFor(pet.size * scale, initialSize.width, initialSize.height));
    win.on('show', () => keepOffTaskbar(win));
    win.once('ready-to-show', () => {
      keepOffTaskbar(win);
      win.showInactive();
    });
    // 兜底显示：paintWhenInitiallyHidden:false 时可能不产出首帧，ready-to-show 永不触发
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
      }, 400);
    });
    const stopPointerFallback = startPointerFallback(win);
    const stopTopmostWatchdog = startTopmostWatchdog(win);
    win.on('closed', () => {
      stopPointerFallback();
      stopTopmostWatchdog();
      windows.delete(pet.id);
      lastRequestedBounds.delete(win.id);
      winMargins.delete(win.id);
      windowIgnore.delete(win.id);
      inputBusy.delete(win.id);
      inputRegions.delete(win.id);
      offBodyMs.delete(win.id);
      windowShapeKey.delete(win.id);
    });
    win.loadFile(path.join(helperDir, 'index.html'), { query: windowQuery(pet, geo, scale) }).catch((error) => {
      console.error(`[dsh-pet-desktop-helper] page load failed (${pet.id}):`, error);
      win.destroy();
    });
    return win;
  }

  /** 渲染端首帧需要的全部参数：几何逐屏注入，运行期变化再经 pet:displays 推送。 */
  function windowQuery(pet, geo, scale) {
    return {
      configUrl: process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config',
      bridge: isBridge ? '1' : '0',
      openTarget,
      scale: String(scale),
      petIndex: String(pet.index),
      workAreaW: String(geo.hull.width),
      workAreaH: String(geo.hull.height),
      workAreaX: String(geo.hull.x),
      workAreaY: String(geo.hull.y),
      areas: JSON.stringify(geo.areas),
      workAreas: JSON.stringify(geo.workAreas),
      topInsetRatio: String(geo.topInsetRatio),
      panels: JSON.stringify(geo.panels),
      primaryIndex: String(geo.primaryIndex),
    };
  }

  /** 按 DSH_PET_PETS 建齐所有窗口。 */
  function createPetWindows() {
    const geo = deskGeometry();
    const scale = dpi.petScale();
    for (const pet of petsFromEnv()) windows.set(pet.id, createPetWindow(pet, geo, scale));
    startTaskbarWatchdog();
  }

  return {
    state: { windows, lastRequestedBounds, winMargins, windowIgnore, inputBusy, inputRegions, offBodyMs, petStates },
    create: createPetWindows,
    geometry: deskGeometry,
    setWindowIgnore,
    applyWindowShape,
    updatePetState,
    broadcastPetStates,
    keepOffTaskbar,
    stopTaskbarWatchdog,
    setPointerFallbackPaused: (paused) => {
      pointerFallbackPaused = paused;
    },
  };
}

module.exports = { createWindows };
