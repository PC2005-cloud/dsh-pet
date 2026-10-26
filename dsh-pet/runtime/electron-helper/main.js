/**
 * dsh-pet 桌面 Helper 主进程：每只桌面宠物一个透明置顶小窗，窗口跟随渲染端上报的包围盒移动，进程内
 * 还负责托盘、bridge 数据转发与宿主存活判定；不负责渲染与命中判定（renderer.js / sprite.js）。
 * 必须保持局部小窗：Windows DWM 视频黑屏需四项同时成立——透明置顶、非点击穿透、可聚焦且已聚焦、
 * 完整盖住视频窗；本进程恰好凑齐前三项，小窗则几乎不可能满足第四项，且默认整窗点击穿透。
 * 依赖宿主注入的环境变量与同目录的纯判定模块。
 * @module dsh-pet/runtime/electron-helper/main
 */
let electronApi;
// 被以「纯 Node 模式」拉起（宿主透传 ELECTRON_RUN_AS_NODE）时内置 electron 模块不会注册：
// 报一句能定位原因的话再退出，别只留 MODULE_NOT_FOUND。
try {
  electronApi = require('electron');
} catch (error) {
  process.stderr.write(
    '[dsh-pet helper] 启动失败：本进程被以「纯 Node 模式」拉起（ELECTRON_RUN_AS_NODE=' +
      JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
      '）。该变量必须在 spawn 前删除（见 src/host/helper-process.ts 的 helperSpawnEnv），' +
      '运行期再删无效，设成空串会让 Electron 直接 abort。原始错误：' +
      (error instanceof Error ? error.message.split('\n')[0] : String(error)) +
      '\n',
  );
  process.exit(3);
}
const { app, BrowserWindow, ipcMain, screen, shell, protocol, Tray, Menu, nativeImage, powerMonitor } = electronApi;
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头）
const { decideWindowIgnore, pointerZone } = require('./pointer-target.js');
// Linux 专用：X11 指针实时查询。穿透窗收不到鼠标事件，Chromium 的 screen.getCursorScreenPoint()
// 在 X11 上会冻结在旧坐标，兜底轮询必须直接问 X server（见 x11-pointer.js）。
const { createLinuxPointer } = require('./x11-pointer.js');
// 置顶看门狗：WS_EX_TOPMOST 只是样式位，不等于窗口真的在置顶带（见 topmost-watchdog.js 头部）
const {
  TOPMOST_WATCHDOG_TICK_MS,
  TOPMOST_WATCHDOG_ENABLED,
  shouldReassertTopmost,
  topmostLevel,
} = require('./topmost-watchdog.js');
// 宿主存活判定：宿主退出 → 管道断开 → 自己退，绝不弹框、绝不留僵尸
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');
// 全局 DPI 线性化的纯判定与换算（平台例外见该文件头）
const { shouldLinearize, resolveForcedScale, resolvePetScale } = require('./dpi-linearization.js');
// 托盘的平台差异（模板图 / 左键是否自动弹菜单 / Dock）：规则住在模块里，main.js 只接线
const { trayPlatform } = require('./tray-platform.js');
const { buildDeskGeometry } = require('./desktop-geometry.js');

/** Linux 指针提供者：仅在 Linux 创建；查询失败时 get() 返回 null（调用方回退 Electron 原生 API） */
const linuxPointer = process.platform === 'linux' ? createLinuxPointer() : null;

/**
 * 当前光标位置（DIP）。
 * Linux：X11 QueryPointer 的实时值（物理像素 ÷ 缩放）；其余平台或查询尚未就绪：Electron 原生 API。
 */
function currentPointer() {
  const raw = linuxPointer && linuxPointer.get();
  if (!raw) return screen.getCursorScreenPoint();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  return scale === 1 ? raw : { x: Math.round(raw.x / scale), y: Math.round(raw.y / scale) };
}

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 显式定名：Helper 被 `electron.exe <main.js>` 直接拉起时取不到 app 名，会回落成 "Electron"，
// userData 便落到 %APPDATA%\Electron 这个公共目录，DPI 缓存与 Chromium profile 会和别人混在一起。
// 必须赶在任何 getPath('userData') 之前设；名字必须与 src/host/storage-paths.ts 的 DESKTOP_APP_NAME
// 逐字一致（测试直接读本文件比对，改名不同步就红）。
// 应用模式（本文件被 src/app/main.ts 同进程 require）：双击启动的用户没有终端，托盘必须有「退出」；
// 手动 start-desktop 流同理，BRIDGE 模式则由宿主决定能否退（见 startTray 的 quitApp）。
const APP_MODE = process.env.DSH_PET_APP_MODE === '1';
// 只供同进程应用自己的请求使用，绝不出现在渲染端地址或日志里。
const APP_TOKEN = APP_MODE ? process.env.DSH_PET_APP_TOKEN : undefined;
app.setName('dsh-pet-electron-helper');
// Windows 任务栏分组：不设 AppUserModelID 时窗口归到 electron.exe 名下，任务栏按钮意外出现就显示
// Electron 默认图标。必须在 ready 之前调用；独立应用与 DSH 内 helper 用不同 ID，避免被合成一组。
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_MODE ? 'com.dsh.pet.app' : 'com.dsh.pet.helper');
}
// 应用模式只改数据目录、不改应用名：共用同一个 userData 时两个 Chromium 进程会抢同一份 profile 互踢。
if (APP_MODE) app.setPath('userData', path.join(app.getPath('appData'), 'dsh-pet'));

/** DPI 探测子进程模式：不建窗口，只把主屏 scaleFactor 打到 stdout 就退出（见 probePrimaryScale） */
const DPI_PROBE = process.env.DSH_PET_DPI_PROBE === '1';
/** 探测进程的输出标记（父进程按它抓值） */
const DPI_MARK = 'dsh-pet-primary-scale:';

// 宿主存活：宿主退出后 stdout/stderr 的读端一起消失，helper 下一次写（每秒至少一条 /state 轮询）
// 拿到 EPIPE；未处理的流错误会成为未捕获异常，而 Electron 的默认处理器只弹框、不退出——桌宠就此
// 卡死、进程赖着不走。两条路缺一不可：① 管道守卫，任何一次写失败都不许变成异常，断开即退（只在
// 上层真的写时触发）；② 宿主探测，每 HOST_POLL_MS 用 kill(pid, 0) 问一次，ESRCH 即退（渲染端
// 崩了或根本没起来时一次写都不会发生，只有它能收敛）。两条路都只经 exitForDeadHost()，且只退一次。
let hostGone = false;
/** 宿主没了 → 立刻退出。这里不能再打日志：管道已断，写只会再踩同一个错误。 */
function exitForDeadHost() {
  if (hostGone) return;
  hostGone = true;
  app.exit(0); // 宿主消失是"环境要求我退"，不是自身崩溃，退出码 0
}

// ① 管道守卫必须赶在任何一次写之前装上（probePrimaryScale 失败就会往 stderr 写）
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) exitForDeadHost();
    // 其余流错误同样吞掉：Electron 的默认处理是弹模态框，不值得拿桌宠去换一个框
  });
}

// ② 宿主探测：DSH_PET_HOST_PID 由宿主 spawn 时注入；未注入或非法 → 0 → 不探测（不误退）。
// DPI 探测实例是一次性短命进程（父进程是 helper 而不是宿主），不参与这套机制。
const HOST_PID = parseHostPid(process.env.DSH_PET_HOST_PID);
if (!DPI_PROBE && HOST_PID > 0) {
  setInterval(() => {
    if (hostIsGone(HOST_PID)) exitForDeadHost();
  }, HOST_POLL_MS).unref?.();
}

// Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下有缺陷：拖拽移动时窗口四周出现黑边、
// 大透明窗移动覆盖小透明窗时后者内容丢失。本进程只渲染轻量宠物动画（640×360），改走软件合成；
// 非 Windows 合成路径不同，保留硬件加速。
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  // 它只关硬件 GL、不会去掉 Chromium 的 GPU 进程：装了虚拟显示器（ToDesk / 远程桌面 IDD 之类）时，
  // GPU 进程沙箱会在初始化阶段以 STATUS_BREAKPOINT 反复崩掉，浏览器进程随即以 0x80000003 退出，
  // helper 每起必崩而宿主只看到一行无信息量的退出码。关掉 GPU 沙箱即可恢复（单测过：
  // --disable-gpu 与 --use-angle 无效，--disable-gpu-sandbox 有效）。本进程只渲染本地素材、
  // 不加载不可信内容；需要保留沙箱的环境设 DSH_PET_GPU_SANDBOX=1。
  if (process.env.DSH_PET_GPU_SANDBOX !== '1') {
    app.commandLine.appendSwitch('disable-gpu-sandbox');
  }
}

// 全局 DPI 线性化：所有显示器强制同一 scale factor——逐屏仿射变换会在拖过屏缝时反复翻转
// （「分身闪烁」）。取值必须锁死 1，不能用主屏 scaleFactor（实测 forced=1.5 会让 bounds 与
// workArea 自相矛盾）；代价是尺寸单位变成物理像素，靠探测到的 scaleFactor 乘进 CONFIG.scale 抵掉，
// 探测失败就不启用。平台规则见 dpi-linearization.js，本文件只接线。

/** 主屏缩放缓存文件（userData 在 ready 前即可用） */
function dpiCacheFile() {
  return path.join(app.getPath('userData'), 'primary-scale.json');
}

function readCachedPrimaryScale() {
  try {
    const v = Number(JSON.parse(readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // 首次启动/文件损坏：当作无缓存，重新探测
  }
}

function writeCachedPrimaryScale(value) {
  try {
    writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: value }), 'utf8');
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] write dpi cache failed:', String(e && e.message ? e.message : e));
  }
}

/** 从探测子进程的输出里抓 scaleFactor（0 = 没抓到） */
function parseProbeOutput(text) {
  const m = new RegExp(DPI_MARK + '([0-9.]+)').exec(String(text || ''));
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 拉起探测子进程读主屏 scaleFactor（同一个 electron + 同一个 main.js，走 DPI_PROBE 分支） */
function probePrimaryScale() {
  const opts = {
    env: { ...process.env, DSH_PET_DPI_PROBE: '1', DSH_PET_BRIDGE: '0', DSH_PET_SMOKE: '0' },
    timeout: 20000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let out = '';
  try {
    out = execFileSync(process.execPath, [__filename, '--dsh-pet-dpi-probe'], opts);
  } catch (e) {
    // 只认 stdout，不认退出码：不开窗口的 Electron 进程调 app.exit() 在 Windows 上偶发
    // 0xC0000005（退出期访问违例），但那时值早就写出来了，丢掉它纯属浪费一次冷启动。
    out = e && e.stdout ? String(e.stdout) : '';
    if (!parseProbeOutput(out)) {
      const detail = [
        e && e.status !== undefined ? 'status=' + e.status : '',
        e && e.stderr ? 'stderr=' + String(e.stderr).trim().slice(0, 300) : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.error(
        '[dsh-pet-desktop-helper] dpi probe failed:',
        String(e && e.message ? e.message : e).split('\n')[0],
        detail,
      );
      return 0; // 探测失败：不加 switch，退回逐屏 DIP 行为
    }
  }
  const v = parseProbeOutput(out);
  if (v > 0) writeCachedPrimaryScale(v);
  return v;
}

/** 真实主屏 scaleFactor（探测所得；0 = 未知）。开启线性化后 screen API 只会报 1，只能靠它。 */
let PRIMARY_SCALE = 0;
/** 实际生效的强制缩放（0 = 未启用，坐标系维持修复前的逐屏 DIP） */
let FORCED_SCALE = 0;
const FORCE_DSF = process.env.DSH_PET_FORCE_DSF;
if (shouldLinearize({ platform: process.platform, dpiProbe: DPI_PROBE, forceDsf: FORCE_DSF })) {
  PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
  const forced = resolveForcedScale({ forceDsf: FORCE_DSF, primaryScale: PRIMARY_SCALE });
  if (forced > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
    FORCED_SCALE = forced;
  }
}

/**
 * 渲染端的 CONFIG.scale：宿主给的基准 × 物理像素补偿。
 * 线性化开启后 1 逻辑像素 = 1 物理像素，宠物按主屏缩放放大回原来的观感。
 */
function petScale() {
  return resolvePetScale({
    baseScale: process.env.DSH_PET_SCALE,
    primaryScale: PRIMARY_SCALE,
    forcedScale: FORCED_SCALE,
  });
}

/** bridge 模式：DSH_PET_BRIDGE=1（宿主注入）。开启时注册 dsh-pet-bridge scheme + 管道转发 */
const BRIDGE = process.env.DSH_PET_BRIDGE === '1';

/** 「打开网站」这一项的去向（宿主按自身形态注入）：
 *  'desktop' = 宿主是 DSH 桌面应用 → 唤起桌面应用主窗口；
 *  'site'    = dsh web / 独立模式 / 手写 start-desktop（无该变量）→ 原行为：默认浏览器打开站点。 */
const OPEN_TARGET = process.env.DSH_PET_OPEN_TARGET === 'desktop' ? 'desktop' : 'site';
/** 协议行前缀（与 helper-process.ts 的 BRIDGE_PREFIX 一致） */
const BRIDGE_PREFIX = 'dsh-pet-bridge:';

if (BRIDGE) {
  // 自定义 scheme：standard（可解析 URL）+ secure（按 https 对待）+ supportFetchAPI（fetch 可用）
  // + stream（视频流）+ corsEnabled（让 CORS 规则生效，配合响应里的 ACAO 头放行 file:// 源页面）
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'dsh-pet-bridge',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** 窗口表：petId -> BrowserWindow */
const windows = new Map();

/** win.id -> 上一次请求的内容区矩形（"x,y,w,h"）：pet:set-bounds 的去重基准 */
const lastRequestedBounds = new Map();

/** win.id -> 渲染端上报的窗口余量 `{ l, t }`（DIP）：上边距按气泡最大高度加高后余量不再四边相等，
 *  命中区不能按「窗口宽/4」反推，所以存下来交给 pointer-target 的 spriteHitRect */
const winMargins = new Map();

/**
 * 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad }。
 * 来源是 pet:set-bounds（每帧全量）与 pet:report-flight（飞行中每 ~30ms 补速度）；
 * 任何更新都广播全量给所有窗口，飞行方据此做跨窗碰撞检测（滞后 ≤ 1 帧，可接受）。
 */
const petStates = new Map();

/** 把当前全量宠物状态广播给所有窗口（碰撞检测的共享站场） */
function broadcastPetStates() {
  const states = {};
  for (const [pid, s] of petStates) {
    states[pid] = { x: s.x, y: s.y, vx: s.vx, vy: s.vy, size: s.size, bottomPad: s.bottomPad };
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send('pet:flight-states', states);
  }
}

/** 记录/更新一只宠物的状态并广播 */
function updatePetState(petId, partial) {
  const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
  petStates.set(petId, Object.assign({}, prev, partial));
  broadcastPetStates();
}

/** 每窗口当前穿透状态的镜像（Electron 没有取值 API）：所有翻转都经 setWindowIgnore，供冒烟断言/排查 */
const windowIgnore = new Map();

/**
 * 输入模型。
 *
 * `ignore` = 历史实现：`setIgnoreMouseEvents` 翻转 + 主进程光标轮询（Windows/macOS 默认，行为不变）。
 * `shape`  = Linux 默认：永不调用 `setIgnoreMouseEvents`，改用 `win.setShape(rects)`——形状之外
 *            **既不绘制也不接收鼠标**，事件落到下层应用。渲染端上报"宠物可见盒 + 覆盖层矩形"，
 *            主进程只负责应用，不需要任何光标轮询。
 * `always` = 整窗永远可交互（不穿透）。`setShape` 在某些合成器上不可用时的兜底。
 *
 * 为什么 Linux 不能用 `ignore`：X11 分支里 ignore=true 把窗口 ShapeInput 设成 **1×1**
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

/** win.id → 上一次应用过的形状（JSON）：形状逐帧算也没关系，重复值不发系统调用 */
const windowShapeKey = new Map();

/**
 * 应用窗口形状（仅 `shape` 模式）。`rects` 是**窗口内容区坐标**。
 *
 * 空列表会被忽略：`setShape([])` 的语义是"恢复矩形窗口"，那会让整窗变成可交互、把下层应用全挡住。
 * @param win 目标窗口
 * @param rects 形状矩形列表（窗口内容区坐标，整数）
 */
function applyWindowShape(win, rects) {
  if (INPUT_MODE !== 'shape') return;
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
  if (clean.length === 0) return;
  const key = JSON.stringify(clean);
  if (windowShapeKey.get(win.id) === key) return;
  windowShapeKey.set(win.id, key);
  try {
    if (typeof win.setShape === 'function') win.setShape(clean);
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] setShape failed:', String(e && e.message ? e.message : e));
  }
}

/**
 * 建窗时的临时形状：渲染端首帧上报前，别让整窗（含四周透明余量）一直挡点击。
 * @param sizePx 宠物包围盒边长（物理像素）
 * @param winW 窗口内容区宽
 * @param winH 窗口内容区高
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

/** 翻转整窗穿透的唯一出口：状态与镜像永远一起更新（穿透期间保留 forward） */
function setWindowIgnore(win, ignore) {
  // 先记镜像（兜底轮询 / 冒烟断言都读它），再决定要不要真的调系统 API。
  windowIgnore.set(win.id, ignore);
  // `shape` / `always` 模式下**绝不调用 setIgnoreMouseEvents**：X11 上 ignore=true 会把窗口
  // ShapeInput 设成 1×1，而 ignore=false 那步（Mask + source_bitmap None）在 KDE/KWin + XWayland
  // 实测不生效 → 窗口永久穿透，宠物看得见却点不中、拖不动。Linux 改走窗口形状（见 INPUT_MODE）。
  if (INPUT_MODE !== 'ignore') return;
  win.setIgnoreMouseEvents(ignore, { forward: true });
}

/** 兜底通道的光标轮询间隔（ms） */
const POINTER_POLL_MS = 60;
/** 冒烟期间暂停兜底轮询：它按真实光标翻转 windowIgnore，会干扰冒烟对渲染端通道的断言 */
let pointerFallbackPaused = false;

/**
 * 每窗口「渲染端正拿着鼠标输入」标记（win.id → true/false），由渲染端经 `pet:input-busy` 上报。
 *
 * 必须由渲染端说了算：兜底通道判定的是光标与窗口矩形的关系，而窗口比宠物身体大一圈；拖拽时宠物
 * 滞后于光标，甩得快时光标先出窗，翻回穿透就会断掉正在用的 pointermove/pointerup。主进程光看
 * 光标位置与窗口位移分不清拖拽跟手与漫游/抛掷，所以 busy 期间本进程绝不翻回穿透。
 */
const inputBusy = new Map();
/** 新渲染端把菜单/聊天框局部矩形单独上报，避免忙碌态下整窗透明余量吞点击。 */
const inputRegions = new Map();

/** 每窗口「光标停在余量区且非 busy」的连续时长（ms）：到点由兜底通道强制恢复穿透 */
const offBodyMs = new Map();

/**
 * 桌面宠物列表（[{id,size}]）：宿主经 DSH_PET_PETS 透传，每只宠物一个窗口。
 * 解析失败或未透传（手动 start-desktop）时回落到单个默认窗口，渲染端首帧会按真实配置自校正。
 * 空数组是合法输入、不等于未透传：宿主在「桌面宠物全关掉但仍需托住托盘」时会明确传 []，
 * 此时必须建 0 个窗口——回落成默认窗口会让渲染端读到「没有桌面宠物」并弹出错误条。
 */
function petsFromEnv() {
  try {
    const raw = process.env.DSH_PET_PETS || '';
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map((p, i) => ({
        id: String(p?.id ?? `pet-${i}`),
        size: Number(p?.size) > 0 ? Number(p.size) : 462,
        index: i,
      }));
    }
  } catch {
    /* fallthrough */
  }
  return [{ id: 'main', size: 462, index: 0 }];
}

/** 窗口初始尺寸 = 宠物包围盒 + 四周外扩余量；渲染端首帧 set-bounds 会按真实配置精确覆盖，
 *  这里只是避免启动瞬间的尺寸跳变。 */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

/**
 * 把窗口从任务栏摘掉（合盖/唤醒后任务栏会冒出 Electron 默认图标）。
 *
 * skipTaskbar 只在建窗时生效一次；Windows 在唤醒、显示器拓扑变化后会让 Shell 重新枚举顶层窗口，
 * 窗口重新 show 时任务栏按钮会被重建且不保证再被摘掉。show() 内部重建按钮是异步的，紧跟一个
 * 0ms 的第二次调用才算数（只调一次仍会残留按钮），所以凡是窗口可能重新出现的时机都要再摘一次。
 */
function keepOffTaskbar(win) {
  if (!win || win.isDestroyed()) return;
  win.setSkipTaskbar(true);
  setTimeout(() => {
    if (!win.isDestroyed()) win.setSkipTaskbar(true);
  }, 0);
}

/**
 * 桌面几何：逐显示器的工作区列表 + 它们的外接矩形 + 主屏下标（屏幕坐标）。
 *
 * hull 只作渲染端视口的坐标系原点与换算基准；所有边界判定（漫游落点/抛掷反弹/角落定位/菜单夹取）
 * 必须走 areas 的并集——显示器摆放不规则时 hull 里会有大片不属于任何屏的空洞，以它为边界会把
 * 宠物放进看不见的地方。
 */
function deskGeometry() {
  return buildDeskGeometry(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.platform);
}

function createPetWindows() {
  const geo = deskGeometry();
  const area = geo.hull;
  const configUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config';
  const pets = petsFromEnv();
  const scale = petScale();
  for (const pet of pets) {
    // 初始窗口尺寸也要吃缩放补偿，否则启动瞬间会有一次可见的尺寸跳变
    const { width, height } = petWindowSize(pet.size * scale);
    const win = new BrowserWindow({
      width,
      height,
      x: area.x, // 初始左上角；renderer 首帧按配置角落/位置校正
      y: area.y,
      show: false,
      useContentSize: true,
      // macOS 默认会把已显示窗口的 y 钳到菜单栏下沿；局部画布的透明余量必须允许伸出屏幕。
      enableLargerThanScreen: true,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // 任务栏按钮万一还是冒出来（唤醒后重建），至少显示宠物图标而不是 Electron 默认原子图
      icon: path.join(__dirname, '..', '..', 'assets', 'logo.png'),
      resizable: false,
      hasShadow: false,
      // 可聚焦：对话输入框/菜单需要窗口焦点才能打字；显示用 showInactive()，不打断其它应用。
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        paintWhenInitiallyHidden: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, topmostLevel(process.platform));
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 窗口被另一只宠物完全遮挡时 Chromium 默认会暂停本窗口渲染，表现成小宠物「消失」；
    // 关掉后台节流让被遮挡窗口持续渲染，移开遮挡后立刻可见。
    win.webContents.setBackgroundThrottling(false);
    // 屏蔽 Electron 默认右键菜单：右键菜单由渲染端统一自绘，绝无双菜单
    win.webContents.on('context-menu', (event) => event.preventDefault());
    // 页面级缩放 = petScale()（渲染端 CONFIG.scale 的同一来源）：整窗内容统一放大，固定 px 的
    // 菜单/弹窗随之恢复 DIP 观感；跨进程交换仍走物理像素，由渲染端 toScreen/toLocal 收口。
    // webPreferences.zoomFactor 对 show:false 的窗口不生效（实测），须在加载完成后设置。
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(scale);
    });
    // 默认整窗点击穿透（渲染端在光标进出身体命中区时经 IPC 翻转）；
    // forward:true 保证穿透期间 mousemove 仍转发进渲染端做命中判定。
    setWindowIgnore(win, true);
    // `shape` 模式：先给一个"宠物包围盒"量级的形状，渲染端首帧上报后再换成精确值
    // （否则从建窗到首帧之间，整窗矩形会把下方应用的点击吞掉）
    applyWindowShape(win, initialShapeFor(pet.size * scale, width, height));
    // 任务栏按钮可能在 show / ready-to-show / 唤醒 / 显示器变化后重建（见 keepOffTaskbar）
    win.on('show', () => keepOffTaskbar(win));
    win.once('ready-to-show', () => {
      keepOffTaskbar(win);
      win.showInactive();
    });
    // 兜底显示：paintWhenInitiallyHidden:false 时渲染器可能不产出首帧，ready-to-show 便永不触发，
    // 而 show 只挂在它上面 → 窗口永远隐藏。页面加载完成后强制兜底一次；zoomFactor 在更早注册的
    // did-finish-load 里设置，顺序不受影响。
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
      }, 400);
    });
    // 兜底交互：正规翻转链路只有 forward 鼠标钩子一个入口，该钩子在 Windows 上可能静默失效，
    // 失效后悬浮、拖拽、点击与右键全废。这里按真实光标位置独立判定，与渲染端通道并存、
    // 判定区域一致（状态未变不翻转）。唯一不能自行决定的是 busy：渲染端正拿着输入时不得翻回穿透
    // （主进程光看光标与窗口位移分不清拖拽跟手和漫游/抛掷，所以由渲染端上报）。
    const pointerTimer = setInterval(() => {
      // `shape` 模式不用光标轮询：窗口形状已经决定了哪里接收鼠标（见 INPUT_MODE）。
      // `always` 模式整窗永远可交互，也不需要翻转。
      if (INPUT_MODE !== 'ignore') return;
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const b = win.getBounds();
      if (b.width < 8 || b.height < 8) return; // 尺寸还没落定（renderer 首帧上报前）
      const ignoring = windowIgnore.get(win.id) !== false;
      const busy = inputBusy.get(win.id) === true;
      const point = currentPointer();
      // 余量区停留计时：只在"非 busy 且在余量区"时累加，离开余量区即清零；busy 期间不累加。
      const mg = winMargins.get(win.id);
      const zone = pointerZone(b, point, mg);
      const nextMs = !busy && zone === 'margin' ? (offBodyMs.get(win.id) ?? 0) + POINTER_POLL_MS : 0;
      offBodyMs.set(win.id, nextMs);
      const next = decideWindowIgnore(b, point, ignoring, busy, nextMs, inputRegions.get(win.id), mg);
      if (next !== ignoring) setWindowIgnore(win, next);
    }, POINTER_POLL_MS);
    // 置顶看门狗：建窗时那次 setAlwaysOnTop 之后再没复查，外部一次 z 序扰动就能让宠物沉底，而
    // WS_EX_TOPMOST 位还在（点击穿透的读-改-写会把它写回来），查位永远得 true。这里低频重钉一次，
    // 落地不移动、不重绘、不抢焦点（依据与代价见 topmost-watchdog.js）。
    // 总开关当前关闭：重钉会把宠物抬到所有置顶窗口之上，打断全屏游戏与截图。
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
    win.on('closed', () => {
      clearInterval(pointerTimer);
      clearInterval(topmostTimer);
      windows.delete(pet.id);
      lastRequestedBounds.delete(win.id);
      winMargins.delete(win.id);
      windowIgnore.delete(win.id);
      windowShapeKey.delete(win.id);
      inputBusy.delete(win.id);
      inputRegions.delete(win.id);
      offBodyMs.delete(win.id);
    });
    win
      // 绝对路径：本文件有两条运行方式（宿主 spawn / 同进程 require），相对路径会按 Electron 的
      // app 路径解析，同进程时那是 lib/，必然 ERR_FILE_NOT_FOUND。
      .loadFile(path.join(__dirname, 'index.html'), {
        query: {
          configUrl,
          bridge: BRIDGE ? '1' : '0',
          // 工具项「打开网站」的文案按宿主形态自动变（见 sprite.js）：desktop=唤起桌面应用 / site=打开站点
          openTarget: OPEN_TARGET,
          scale: String(scale),
          petIndex: String(pet.index),
          workAreaW: String(area.width),
          workAreaH: String(area.height),
          workAreaX: String(area.x),
          workAreaY: String(area.y),
          // 逐屏工作区（屏幕坐标）+ 主屏下标：边界判定走它们的并集。首帧就要用，所以走 query；
          // 运行期变化再经 pet:displays 推送。
          areas: JSON.stringify(geo.areas),
          workAreas: JSON.stringify(geo.workAreas),
          topInsetRatio: String(geo.topInsetRatio),
          // 逐屏完整面板（含任务栏区）：抛掷越界侧探测用（任务栏条带不当墙，见 shared/physics.ts）
          panels: JSON.stringify(geo.panels),
          primaryIndex: String(geo.primaryIndex),
        },
      })
      .catch((error) => {
        console.error(`[dsh-pet-desktop-helper] page load failed (${pet.id}):`, error);
        win.destroy();
      });
    windows.set(pet.id, win);
  }
}

// bridge 协议：渲染端的每个 fetch 落到 dsh-pet-bridge://，protocol.handle 把请求以一行 JSON 写
// stdout 转发宿主。宿主应答不走近 0 号管道（Electron 主进程在 Windows 上收不到 piped stdin），
// 所以本进程开一个 127.0.0.1 随机端口 HTTP 回调，按 id 唤醒等待中的请求；素材只回绝对路径，
// 由本进程自行读盘应答（二进制不过管道）。协议行统一前缀 BRIDGE_PREFIX，宿主据此区分协议与日志。

let bridgeSeq = 0;
/** id -> {resolve, reject}：一个请求对应宿主的一次回调应答 */
const bridgePending = new Map();
let bridgeCallbackUrl = '';

/** 渲染端请求 → 宿主（请求行带回调 URL）；返回宿主应答（{status, contentType?, body?, file?}），超时抛错 */
function bridgeRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const id = ++bridgeSeq;
    bridgePending.set(id, { resolve, reject });
    process.stdout.write(BRIDGE_PREFIX + JSON.stringify({ id, method, url, body, cb: bridgeCallbackUrl }) + '\n');
    // 宿主若长期不应答（进程退出/宿主动作挂起）不无限挂起：45s 兜底（LLM 生成最长 30-60s）
    setTimeout(() => {
      const p = bridgePending.get(id);
      if (!p) return;
      bridgePending.delete(id);
      p.reject(new Error('bridge request timeout'));
    }, 45000).unref?.();
  });
}

/** 把宿主回调应答（{id, status, ...}）派发给对应请求 */
function bridgeResolve(resp) {
  const p = resp && bridgePending.get(resp.id);
  if (!p) return;
  bridgePending.delete(resp.id);
  p.resolve(resp);
}

/** 本地回调服务器：宿主把应答 POST 到这里（127.0.0.1 随机端口，绕开 stdin/DSH 闸门） */
function startBridgeCallback() {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/respond') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dsh-pet: not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        bridgeResolve(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('dsh-pet: bad payload');
      }
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('dsh-pet: bad payload');
    });
  });
  server.on('error', (e) => {
    console.error('[dsh-pet-desktop-helper] bridge callback server error:', String(e && e.message ? e.message : e));
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    bridgeCallbackUrl = 'http://127.0.0.1:' + (addr && typeof addr === 'object' ? addr.port : 0) + '/respond';
    console.error('[dsh-pet-desktop-helper] bridge callback: ' + bridgeCallbackUrl);
  });
  return server;
}

/** 处理一个渲染端请求：拼宿主请求行 → 等应答 → 组装 Response（素材读盘） */
async function handleBridgeRequest(request) {
  const url = new URL(request.url); // dsh-pet-bridge://dsh-pet/dsh-pet-7340/...
  const method = request.method || 'GET';
  let body;
  if (method === 'POST' || method === 'PUT') {
    body = await request.text();
  }
  const resp = await bridgeRequest(method, url.pathname + url.search, body);
  const headers = { 'access-control-allow-origin': '*' }; // 渲染端页面是 file:// 源，scheme 跨源需 CORS
  if (resp.contentType) headers['content-type'] = resp.contentType;
  if (resp.file) {
    // 素材：直接读盘返回（宿主已解析好绝对路径；带 range 让视频能拖动进度条）
    try {
      const data = await fsPromises.readFile(resp.file);
      return new Response(new Uint8Array(data), { status: resp.status || 200, headers });
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] bridge file read failed:', resp.file, e);
      return new Response('dsh-pet: asset read failed', { status: 500, headers });
    }
  }
  return new Response(resp.body ?? '', { status: resp.status || 200, headers });
}

// 系统托盘：桌面端的显示开关。
// 托盘放在本进程，是因为它是桌面模式唯一不进浏览器的入口：某只宠物的 display 改成 web/none 后
// 桌面窗口与它自己的右键菜单一起消失，只有托盘还能在桌面侧把它切回来。
// 它不是非有不可：main 条目的 trayEnabled 为 false 时不建托盘，宿主也就不再为本进程常驻。
// 数据不新增通道：读写都走渲染端在用的同一条 bridge。菜单是静态的——每次切换 display 宿主都会重启
// 本进程（syncDesktop），新进程按新配置重建菜单，所以不需要「重建菜单刷新勾选」的逻辑。

const PET_ROUTE = '/dsh-pet-7340';
const ORIGIN = new URL(process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config').origin;
const TRAY_PLATFORM = trayPlatform(process.platform);

/** 与宿主 handlePetRoute 通信：bridge 模式走管道，手动 start-desktop 流退回 HTTP 直连 */
async function hostRequest(method, url, body) {
  if (BRIDGE) return bridgeRequest(method, url, body);
  const resp = await fetch(ORIGIN + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(APP_TOKEN ? { 'X-DSH-Pet-Token': APP_TOKEN } : {}),
    },
    body,
  });
  return { status: resp.status, body: await resp.text() };
}

const isDesktopDisplay = (display) => display === 'desktop' || display === 'both';

/** 翻转「桌面位」：both↔web、desktop↔none——浏览器位保持不动，因此不制造新的单向门 */
const toggleDisplay = (display) =>
  display === 'both' ? 'web' : display === 'web' ? 'both' : display === 'desktop' ? 'none' : 'desktop';

let tray = null;

/** 写回某只宠物的 display：宿主写完配置会重启本进程，响应可能永远不回（同 sprite.js 的 setPetDisplay） */
function traySetPetDisplay(id, display) {
  hostRequest('POST', PET_ROUTE + '/pet-display', JSON.stringify({ id, display })).catch((e) => {
    console.error('[dsh-pet-desktop-helper] tray pet-display failed:', String(e && e.message ? e.message : e));
  });
}

/** 托盘图标：包内 logo 缩到 16×16（macOS 要模板图，否则深色菜单栏下看不见） */
function trayIcon() {
  const file = path.join(__dirname, '..', '..', 'assets', 'logo.png');
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) {
    // 读不到图标 = 托盘不可见但菜单逻辑照跑，最难查的一种坏法：必须留下能定位的日志
    console.error('[dsh-pet-desktop-helper] tray icon missing or unreadable: ' + file);
    return img;
  }
  img = img.resize({ width: 16, height: 16 });
  if (TRAY_PLATFORM.templateImage) img.setTemplateImage(true);
  return img;
}

/**
 * 建托盘：列出配置里全部宠物（含 display 为 web/none 的——它们当前勾是空的，点一下就能送回来，
 * 这是托盘相对宠物右键菜单的增量）。勾 = 当前 display 含 desktop/both。
 */
async function startTray() {
  try {
    // 请求行要携带回调 URL，而端口在 startBridgeCallback 的 listen 回调里才有值（最多等 2s）
    for (let i = 0; BRIDGE && !bridgeCallbackUrl && i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const resp = await hostRequest('GET', PET_ROUTE + '/config');
    const merged = JSON.parse(resp.body || '{}');
    // 托盘开关（main 条目的 trayEnabled）：只有显式 false 才不建，缺失或写坏时保持建，
    // 免得一份老配置或一个错值让托盘无声消失。与下面的 pets 取自同一份成品配置。
    if (merged && merged.main && merged.main.trayEnabled === false) return;
    // 成品聚合的形状是 { <条目>: <整份配置文档> }：顶层键不是宠物，宠物在各条目的 pets 数组里
    // （与渲染端同一契约）。托盘只要 id/name/display，所以不吹条目级字段。
    const pets = Object.values(merged)
      .flatMap((conf) => (conf && Array.isArray(conf.pets) ? conf.pets : []))
      .map((pet) => ({
        id: String((pet && pet.id) || ''),
        name: String((pet && pet.name) || '').trim(), // host 已保证 name 缺失时回落 id
        display: String((pet && pet.display) || ''),
      }))
      .filter((pet) => pet.id);
    if (!pets.length) return; // 配置里没有任何宠物：没有可切换的对象，不建托盘
    // 托盘「退出」是否可用：独立应用与手动 start-desktop 流都可以自己 app.quit()；
    // BRIDGE 下本进程由宿主拉起，自己退会被当成崩溃按退避重启，必须先问宿主（GET /quit 的 canQuit）。
    // 探测失败一律按不支持处理，菜单项因此不出现。
    let hostCanQuit = false;
    if (BRIDGE && !APP_MODE) {
      try {
        hostCanQuit = JSON.parse((await hostRequest('GET', PET_ROUTE + '/quit')).body || '{}').canQuit === true;
      } catch (e) {
        console.error('[dsh-pet-desktop-helper] quit capability probe failed:', String(e && e.message ? e.message : e));
      }
    }
    const canQuit = APP_MODE || !BRIDGE || hostCanQuit;
    const quitApp = () => {
      if (!BRIDGE || APP_MODE) {
        app.quit();
        return;
      }
      // 交给宿主停机：它会先停本进程再退，所以这条请求不用等结果
      hostRequest('POST', PET_ROUTE + '/quit').catch((e) => {
        console.error('[dsh-pet-desktop-helper] tray quit failed:', String(e && e.message ? e.message : e));
      });
    };
    tray = new Tray(trayIcon());
    tray.setToolTip('dsh-pet 桌面宠物');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...pets.map((pet) => ({
          label: pet.name || pet.id,
          type: 'checkbox',
          checked: isDesktopDisplay(pet.display),
          click: () => traySetPetDisplay(pet.id, toggleDisplay(pet.display)),
        })),
        ...(canQuit ? [{ type: 'separator' }, { label: '退出', click: quitApp }] : []),
      ]),
    );
    // Windows 上 setContextMenu 只接管右键，左键默认什么都不做（macOS 相反：左键即弹菜单）
    if (TRAY_PLATFORM.leftClickPopsMenu) tray.on('click', () => tray.popUpContextMenu());
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] tray init failed:', String(e && e.message ? e.message : e));
  }
}

app.whenReady().then(() => {
  // 探测子进程：此时没有 force-device-scale-factor，读到的是 Windows 的真实主屏缩放。
  // 退出推迟一拍——在 ready 回调里直接 app.exit() 会赶在 stdout 落盘前拆掉进程
  if (DPI_PROBE) {
    process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
    setTimeout(() => app.exit(0), 0);
    return;
  }
  console.error(
    '[dsh-pet-desktop-helper] displays: ' +
      JSON.stringify(deskGeometry()) +
      ' forcedScaleFactor=' +
      (FORCED_SCALE || 'off') +
      ' primaryScale=' +
      (PRIMARY_SCALE || 'unknown') +
      ' petScale=' +
      petScale(),
  );

  if (BRIDGE) {
    // 自定义 scheme 接住渲染端全部请求（配置/余额/碎碎念/广播/素材）
    protocol.handle('dsh-pet-bridge', (request) =>
      handleBridgeRequest(request).catch((e) => {
        console.error('[dsh-pet-desktop-helper] bridge handler error:', String(e && e.message ? e.message : e));
        return new Response('dsh-pet: bridge error', {
          status: 502,
          headers: { 'access-control-allow-origin': '*' },
        });
      }),
    );
    startBridgeCallback(); // 宿主应答回调服务器（stdin 在 Electron 主进程不可用，改走本地 HTTP）
  }

  // macOS：桌面宠物不该占 Dock。不跟 trayEnabled 联动——宠物本体的右键菜单仍在，桌面侧还能操作。
  if (TRAY_PLATFORM.hideDock && app.dock) app.dock.hide();

  // 托盘：不 await（建窗与建托盘互不依赖），内部自己等 bridge 回调服务就绪
  void startTray();

  linuxPointer?.start();
  createPetWindows();

  // 合盖/唤醒是任务栏按钮重建最集中的时刻：resume / unlock-screen 后把每只宠物重新摘一次。
  // powerMonitor 只能在 ready 之后使用，所以挂在这里而不是模块顶层。
  const reassertTaskbar = () => {
    for (const win of windows.values()) keepOffTaskbar(win);
  };
  powerMonitor.on('resume', reassertTaskbar);
  powerMonitor.on('unlock-screen', reassertTaskbar);

  // 窗口形状上报（Linux `shape` 模式）：渲染端把"宠物可见盒 + 气泡/提示/菜单/对话/积分弹窗"
  // 算成一组矩形发上来，主进程只负责应用。形状之外不绘制也不接收鼠标 → 事件落到下层应用。
  ipcMain.on('pet:shape', (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !input || !Array.isArray(input.rects)) return;
    applyWindowShape(win, input.rects);
  });

  // 宠物窗口跟随：renderer 逐帧上报窗口内容区位置/尺寸
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    // 去重必须比较我们上一次请求的值，绝不能拿 win.getContentBounds() 的回读值来比：
    // 跨缩放屏的 DIP↔物理往返有向外取整与原点舍入，读回值永远不等于设定值，去重就永远不生效。
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (lastRequestedBounds.get(win.id) !== key) {
      lastRequestedBounds.set(win.id, key);
      win.setContentBounds(rect, false);
    }
    // 窗口余量（左右/上）：命中区判定的依据，余量四边不再相等。
    const ml = Number(bounds?.marginL);
    const mt = Number(bounds?.marginT);
    if (Number.isFinite(ml) && Number.isFinite(mt)) winMargins.set(win.id, { l: ml, t: mt });
    // 碰撞站场的位置必须用包围盒左上角（渲染端显式上报 boxX/boxY）：窗口坐标 = 包围盒 − margin，
    // 直接拿窗口坐标会让跨窗检测整体错位。
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (petId) {
      const bx = Number(bounds?.boxX);
      const by = Number(bounds?.boxY);
      const size = Number(bounds?.size);
      const bottomPad = Number(bounds?.bottomPad);
      const vx = Number(bounds?.vx);
      const vy = Number(bounds?.vy);
      // 位置 + 尺寸 + 速度一并登记：set-bounds 每次位置变化都会触发，带上尺寸静止宠物才能被
      // 跨窗碰撞检测看见；速度取渲染端上报值（飞行中实时、静止/拖拽 = 0），落地后不残留旧速度。
      updatePetState(petId, {
        x: Number.isFinite(bx) ? bx : x,
        y: Number.isFinite(by) ? by : y,
        size: Number.isFinite(size) && size > 0 ? size : petStates.get(petId)?.size || 0,
        bottomPad: Number.isFinite(bottomPad) && bottomPad > 0 ? bottomPad : petStates.get(petId)?.bottomPad || 0,
        vx: Number.isFinite(vx) ? vx : 0,
        vy: Number.isFinite(vy) ? vy : 0,
      });
    }
  });

  // 飞行状态上报（碰撞站场）：renderer 飞行中每 ~30ms 上报一次自己的位置/速度/尺寸
  ipcMain.on('pet:report-flight', (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (!petId) return;
    const s = state || {};
    const x = Number(s.x);
    const y = Number(s.y);
    const vx = Number(s.vx);
    const vy = Number(s.vy);
    const size = Number(s.size);
    const bottomPad = Number(s.bottomPad);
    if (![x, y, vx, vy, size, bottomPad].every(Number.isFinite)) return;
    updatePetState(petId, { x, y, vx, vy, size, bottomPad });
  });

  // 碰撞结果转发：飞行方窗口检测到撞到 targetId → 把动量结果（目标新初速）转发给目标窗口
  ipcMain.on('pet:collide-result', (event, payload) => {
    const targetId = payload && typeof payload === 'object' ? String(payload.targetId || '') : '';
    const vx = Number(payload?.vx);
    const vy = Number(payload?.vy);
    if (!targetId || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const targetWin = windows.get(targetId);
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send('pet:hit', { vx, vy });
    }
  });

  // 点击穿透翻转：渲染端在光标进出身体命中区时上报；穿透期间仍保留 forward。
  // 兜底轮询也走同一个出口 setWindowIgnore，两条通道共享同一份镜像状态。
  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const input = inputRegions.get(win.id);
    // 渲染端的旧 menuOpen/chatOpen 守卫会请求整窗可交互；这里按真实光标和控件矩形裁定。
    const ignoring =
      interactive && input && inputBusy.get(win.id)
        ? decideWindowIgnore(
            win.getContentBounds(),
            screen.getCursorScreenPoint(),
            false,
            true,
            0,
            input,
            winMargins.get(win.id),
          )
        : !interactive;
    setWindowIgnore(win, ignoring);
  });

  // 拖拽持有完整输入租约；菜单/对话则由 inputRegions 把交互限制在实际控件矩形内。
  // 这里只存标记、不直接翻窗口——唯一出口仍是 setWindowIgnore，否则两条通道会抢着翻同一个窗口。
  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    inputBusy.set(win.id, !!busy);
  });

  ipcMain.on('pet:input-regions', (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !input || !Array.isArray(input.rects)) return;
    const rects = input.rects.filter(
      (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
    );
    inputRegions.set(win.id, { dragging: input.dragging === true, rects });
  });

  // 右键菜单「打开网站」：交给系统默认浏览器（等效网页里 Ctrl+点击链接），不建专属窗口——
  // 宠物窗口是透明小窗，不该承载常规网页浏览。URL 由渲染端从 configUrl 推导。
  const openSite = (url) => {
    // 宿主注入的已鉴权站点 URL（含本进程启动令牌）：DSH 只在 GET / 接受它并换发浏览器 Cookie，
    // 裸 origin 在默认浏览器里必然 401。令牌等价登录态，只在与目标同 origin 时启用，
    // 绝不让它被带去别的站点；取不到该变量时行为与以前一致。
    let target = url;
    const authed = process.env.DSH_PET_SITE_URL || '';
    if (/^https?:[/][/]/.test(authed)) {
      try {
        if (new URL(authed).origin === new URL(url).origin) target = authed;
      } catch {
        /* 形状不对：保持裸地址（原行为） */
      }
    }
    shell.openExternal(target).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  };

  // 去向由宿主形态决定：desktop 用应用自注册的 dsh:// 协议把主窗口叫回前台（已运行则被单实例锁
  // 拦下、宿主收到 second-instance 后聚焦；未运行则协议直接把应用拉起来），比 spawn 宿主 exe 干净；
  // site 则是原行为：系统默认浏览器打开站点。
  ipcMain.on('pet:open-site', (event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    if (OPEN_TARGET === 'desktop') {
      // 协议未注册（绿色版 / 注册表被清）时回落成打开站点，至少不是"点了没反应"
      shell.openExternal('dsh://open').catch((error) => {
        console.error('[dsh-pet-desktop-helper] open dsh:// failed, falling back to site:', error);
        openSite(url);
      });
      return;
    }
    openSite(url);
  });

  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效（原先只在建窗时经 query 注入
  // 一次，运行期永不更新）。这里重算并推给所有窗口，渲染端就地重挂。
  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = deskGeometry();
    lastRequestedBounds.clear(); // 坐标系变了，去重缓存作废，下一帧必须真的重设一次
    for (const win of windows.values()) {
      if (win.isDestroyed()) continue;
      // 显示器拓扑变化同样是任务栏按钮重建的时机
      keepOffTaskbar(win);
      win.webContents.send('pet:displays', geo);
    }
    console.error('[dsh-pet-desktop-helper] displays changed: ' + JSON.stringify(geo));
    // 主屏缩放可能一起变了：线性化生效期间 screen API 只报被强制的值，真实值只能靠探测子进程拿；
    // 不一致就刷新缓存，下次启动自动用上。
    if (FORCED_SCALE > 0) {
      setTimeout(() => {
        const real = probePrimaryScale();
        if (real > 0 && Math.abs(real - PRIMARY_SCALE) > 1e-6) {
          console.error(
            '[dsh-pet-desktop-helper] primary scaleFactor changed ' +
              PRIMARY_SCALE +
              ' -> ' +
              real +
              '; restart the desktop pet to resize',
          );
        }
      }, 1000).unref?.();
    }
  };
  /** 显示器事件会连发（一次改动能来好几条），去抖后只重算一次 */
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      pushDisplays();
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);

  // 冒烟自检（默认关闭）：DSH_PET_SMOKE=1 时延时截图到 DSH_PET_SMOKE_OUT 后退出，
  // 用于验证窗口/渲染/动画链路。
  if (process.env.DSH_PET_SMOKE === '1') {
    const smokeOut = process.env.DSH_PET_SMOKE_OUT || path.join(app.getPath('temp'), 'dsh-pet-smoke.png');
    const afterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS || 9000);
    const target = windows.values().next().value;
    if (target) {
      // 转发渲染端 console（定位动画/余额/错误问题）
      target.webContents.on('console-message', (event) => {
        console.log(`[renderer:${event.level}] ${event.message}`);
      });
    }
    setTimeout(async () => {
      try {
        const first = windows.values().next().value;
        if (first && !first.isDestroyed()) {
          const dump = await first.webContents.executeJavaScript(`(async () => ({
            hasBridge: typeof window.petBridge !== 'undefined',
            hasSetInteractive: typeof window.petBridge?.setInteractive === 'function',
            viewport: window.innerWidth + 'x' + window.innerHeight,
            dpr: window.devicePixelRatio,
            debug: window.__dshPetDebug || null,
            sprites: document.querySelectorAll('.pet-sprite').length,
            errorVisible: document.getElementById('pet-error').classList.contains('visible'),
            errorText: document.getElementById('pet-error').textContent,
            firstBubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent.slice(0, 120),
            hitCursor: (function () {
              var hit = document.querySelector('.pet-hit');
              return hit ? getComputedStyle(hit).cursor : '';
            })(),
            dragTransform: (function () {
              var hit = document.querySelector('.pet-hit');
              var stage = document.querySelector('.pet-stage');
              if (!hit || !stage) return 'no-sprite';
              var out = { idle: stage.style.transform };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.duringClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.afterClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200, screenX: 200, screenY: 200, pointerId: 92 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.duringDrag = stage.style.transform;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.afterDrag = stage.style.transform;
              return out;
            })(),
            releaseKeptPosition: await (async function () {
              // 独立不变量：把宠物先拖到工作区内的固定安全点（600,300），松手后窗口位置必须原地不动。
              // 拖拽抛掷物理（弹簧跟手+甩抛）下：指针长距跳跃后弹簧需要 ~0.3s 收敛，
              // 松手前停留超过 RELEASE_STALE_MS(150ms) 判为「温柔放下」（估速 null，不抛掷）——
              // 所以先等弹簧到位、再停留才松手，只测"释放瞬间是否位移"。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.dragPos || !hit) return null;
              var P = { x: d.dragPos.x, y: d.dragPos.y };
              var T = { x: 600, y: 300 }; // 目标窗口左上角（1708×1020 工作区内，远离四边）
              var upX = 1000 + (T.x - P.x);
              var upY = 600 + (T.y - P.y);
              var sleep = function (ms) {
                return new Promise(function (r) {
                  setTimeout(r, ms);
                });
              };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, clientY: 600, screenX: 1000, screenY: 600, pointerId: 93 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(400); // 弹簧跟随收敛
              var during = { x: d.dragPos.x, y: d.dragPos.y };
              await sleep(200); // 轨迹过期 → 估速 null → 温柔放下（不抛掷）
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(80); // 释放处理完成
              var released = d.lastDragRelease ? { x: d.lastDragRelease.x, y: d.lastDragRelease.y } : null;
              return {
                during: during,
                released: released,
                kept: !!(released && Math.abs(released.x - during.x) <= 1 && Math.abs(released.y - during.y) <= 1),
              };
            })(),
            interactiveFlip: (function () {
              // 点击穿透命中判定：光标在命中区内→可交互；移出→穿透；拖拽中（pointer 已捕获）→强制可交互。
              // hitRect 是 sprite 坐标，mousemove 用窗口坐标——测试事件需加上窗口外扩余量 winMargin。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.hitRect || !d.winMargin || !hit) return null;
              var r = d.hitRect;
              var m = d.winMargin;
              var xIn = m.l + r.x + r.w / 2;
              var yIn = m.t + r.y + r.h / 2;
              var xOut = Math.max(0, m.l + r.x - 20);
              var yOut = Math.max(0, m.t + r.y - 20);
              var out = {};
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn }));
              out.inside = d.interactive === true;
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.outside = d.interactive === false;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn, pointerId: 94 }));
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.duringDragForced = d.interactive === true;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut, pointerId: 94 }));
              return out;
            })(),
            videoSrcA: (document.querySelectorAll('.pet-sprite video')[0] || { src: '' }).src,
            videoSrcB: (document.querySelectorAll('.pet-sprite video')[1] || { src: '' }).src,
            // 右键菜单自检：在命中区派发 contextmenu → 校验菜单挂载/根文案/子面板/运行错误
            menuSmoke: await (async function () {
              // 前面 drag/release/interactive 测试刚拖过宠：justDragged 100ms 内屏蔽右键，
              // 真实用户不会拖完立刻右键——先等 250ms 消除该时序影响
              await new Promise(function (resolve) {
                setTimeout(resolve, 250);
              });
              var hit = document.querySelector('.pet-hit');
              var d = window.__dshPetDebug;
              if (!hit || !d) return null;
              var errsBefore = (d.errors || []).length;
              try {
                hit.dispatchEvent(
                  new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 400, clientY: 260, screenX: 400, screenY: 260 }),
                );
              } catch (err) {
                return { threw: String(err), menuMounted: false };
              }
              var menu = document.querySelector('.dsh-pet-menu');
              var out = {
                threw: null,
                menuMounted: !!menu,
                menuOpen: d.menuOpen === true,
                rootText: menu ? menu.textContent.slice(0, 60) : '',
                errsNew: (d.errors || []).length - errsBefore,
              };
              if (menu) {
                var branch = menu.querySelector('.dsh-pet-menu-branch');
                if (branch) {
                  branch.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: menu }));
                  var panels = Array.prototype.slice.call(
                    menu.querySelectorAll('.dsh-pet-menu-column'),
                  );
                  var visible = function () {
                    return panels.filter(function (p) {
                      return p.style.display !== 'none';
                    });
                  };
                  out.panelCount = panels.length;
                  out.lvl2AfterHoverRoot = visible().length;
                  // 二级：悬停「动作」下的第一个分类 → 打开三级面板（具体动画）
                  var panel1 = visible().filter(function (p) {
                    return p !== panels[0];
                  })[0];
                  if (panel1) {
                    var cat = panel1.querySelector('.dsh-pet-menu-branch');
                    if (cat) {
                      cat.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: panel1 }));
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 50);
                      });
                      out.lvl3AfterHoverCat = visible().length;
                      // 重放用户路径：鼠标从分类项移向三级面板（先离开分类项进入 4px 缝隙，
                      // 再进入三级面板）——缝隙里 mouseleave 会排 160ms 关闭定时器
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 60);
                      });
                      var panel2 = visible()[visible().length - 1];
                      if (panel2) {
                        panel2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                      }
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 220);
                      });
                      out.lvl3SurvivedAfterReenter = visible().length;
                      // 极端情况：缝隙停留超过关闭延时（鼠标犹豫）
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 260);
                      });
                      out.lvl3AfterGapHover = visible().length;
                    }
                  }
                }
              }
              return out;
            })(),
          }))()`);
          console.log(
            '[dsh-pet-desktop-helper] smoke dump: windows=' +
              windows.size +
              ' ids=' +
              JSON.stringify([...windows.keys()]) +
              ' => ' +
              JSON.stringify(dump),
          );
          console.log('[dsh-pet-desktop-helper] smoke bounds:', JSON.stringify(first.getContentBounds()));
          // 点击穿透 round-trip：true → 窗口捕获输入，false → 恢复整窗穿透；状态取自主进程镜像。
          // 期间暂停兜底轮询：它按真实光标翻转，冒烟时鼠标不在宠物身上会覆盖本断言的状态。
          pointerFallbackPaused = true;
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(true); true;');
          await new Promise((r) => setTimeout(r, 80));
          const interactiveIgnoring = windowIgnore.get(first.id);
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(false); true;');
          await new Promise((r) => setTimeout(r, 80));
          const passthroughIgnoring = windowIgnore.get(first.id);
          pointerFallbackPaused = false;
          console.log(
            '[dsh-pet-desktop-helper] smoke interactive round-trip:',
            JSON.stringify({ interactiveIgnoring, passthroughIgnoring }),
          );
          const image = await first.webContents.capturePage();
          writeFileSync(smokeOut, image.toPNG());
          console.log('[dsh-pet-desktop-helper] smoke capture:', smokeOut);
        }
      } catch (error) {
        console.error('[dsh-pet-desktop-helper] smoke capture failed:', error);
      }
      setTimeout(() => app.quit(), 500);
    }, afterMs);
  }
});

// 退出时销毁托盘图标：不销毁会在 Windows 通知区留下「幽灵图标」（鼠标划过才消失）。
// 宿主改 display 时是 SIGTERM/SIGKILL 硬杀，Windows 上拦不到，所以这条只覆盖优雅退出。
app.on('before-quit', () => {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] tray destroy failed:', String(e && e.message ? e.message : e));
  }
  tray = null;
});

app.on('window-all-closed', () => {
  // 托盘常驻：桌面上没有宠物也要留着，否则「全关掉」就再也切不回来
  if (tray) return;
  app.quit();
});
