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
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头）
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
// 任务栏看门狗：Windows 上 skipTaskbar 只是一次性 DeleteTab，shell 重建任务栏后按钮复现（见 taskbar-watchdog.js）
const { taskbarWatchdogEnabledFromEnv } = require('./taskbar-watchdog.js');
// 宿主存活判定：宿主退出 → 管道断开 → 自己退，绝不弹框、绝不留僵尸
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');
// 全局 DPI 线性化的纯判定与换算（平台例外见该文件头）
// 托盘的平台差异（模板图 / 左键是否自动弹菜单 / Dock）：规则住在模块里，main.js 只接线
const { trayPlatform } = require('./tray-platform.js');
const { buildDeskGeometry } = require('./desktop-geometry.js');
const { runSmokeCheck } = require('./main/smoke.js');
const { createDpi } = require('./main/dpi.js');
const { createBridge } = require('./main/bridge.js');
const { createTray } = require('./main/tray.js');
const { createWindows } = require('./main/windows.js');
const { registerIpc } = require('./main/ipc.js');
const { createDisplaySync } = require('./main/displays.js');

/** Linux 指针提供者：仅在 Linux 创建；查询失败时 get() 返回 null（调用方回退 Electron 原生 API） */
const linuxPointer = process.platform === 'linux' ? createLinuxPointer() : null;

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

// [fix] 受限令牌下 %APPDATA% 可能不可写：宿主用受限令牌拉起 helper 时实测如此。
// 此时 Chromium 的 profile 初始化会卡住，app.whenReady() 永不 resolve，
// 宿主只看到约 6 秒后的一次 0xC0000005（退出期访问违例），没有任何可读错误。
// 这里探测 userData 是否真的可写；不可写就退回到 DSH 自己的目录。
try {
  const fsCheck = require('node:fs');
  const userDataDir = app.getPath('userData');
  fsCheck.mkdirSync(userDataDir, { recursive: true });
  fsCheck.accessSync(userDataDir, fsCheck.constants.W_OK);
} catch (error) {
  try {
    const fallbackDir = path.join(require('node:os').homedir(), '.dsh', 'dsh-pet', 'electron-profile');
    require('node:fs').mkdirSync(fallbackDir, { recursive: true });
    app.setPath('userData', fallbackDir);
    console.error(
      '[dsh-pet-desktop-helper] userData 不可写，回退到',
      fallbackDir,
      String(error && error.message ? error.message : error),
    );
  } catch (fallbackError) {
    console.error(
      '[dsh-pet-desktop-helper] userData 回退失败:',
      String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError),
    );
  }
}

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

/** DPI/指针能力：缩放探测、强制缩放开关、petScale 与光标位置。 */
const dpi = createDpi({
  app,
  screen,
  mainPath: __filename,
  linuxPointer,
  dpiProbe: DPI_PROBE,
  dpiMark: DPI_MARK,
  forceDsf: process.env.DSH_PET_FORCE_DSF,
});

/** bridge 模式：DSH_PET_BRIDGE=1（宿主注入）。开启时注册 dsh-pet-bridge scheme + 管道转发 */
const BRIDGE = process.env.DSH_PET_BRIDGE === '1';

/** 菜单首项的去向（宿主按自身形态注入）：
 *  'desktop'    = DSH 桌面应用 → 唤起应用主窗口；
 *  'standalone' = 独立模式 → 打开本机 AI 设置页；
 *  'web'        = dsh web / 手写 start-desktop（无该变量）→ 默认浏览器打开站点。 */
const OPEN_TARGET_RAW = process.env.DSH_PET_OPEN_TARGET;
const OPEN_TARGET = OPEN_TARGET_RAW === 'desktop' || OPEN_TARGET_RAW === 'standalone' ? OPEN_TARGET_RAW : 'web';
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

// bridge 协议：渲染端的每个 fetch 落到 dsh-pet-bridge://，protocol.handle 把请求以一行 JSON 写
// stdout 转发宿主。宿主应答不走近 0 号管道（Electron 主进程在 Windows 上收不到 piped stdin），
// 所以本进程开一个 127.0.0.1 随机端口 HTTP 回调，按 id 唤醒等待中的请求；素材只回绝对路径，
// 由本进程自行读盘应答（二进制不过管道）。协议行统一前缀 BRIDGE_PREFIX，宿主据此区分协议与日志。

// 系统托盘：桌面端的显示开关。
// 托盘放在本进程，是因为它是桌面模式唯一不进浏览器的入口：某只宠物的 display 改成 web/none 后
// 桌面窗口与它自己的右键菜单一起消失，只有托盘还能在桌面侧把它切回来。
// 它不是非有不可：main 条目的 trayEnabled 为 false 时不建托盘，宿主也就不再为本进程常驻。
// 数据不新增通道：读写都走渲染端在用的同一条 bridge。菜单是静态的——每次切换 display 宿主都会重启
// 本进程（syncDesktop），新进程按新配置重建菜单，所以不需要「重建菜单刷新勾选」的逻辑。

const PET_ROUTE = '/dsh-pet-7340';
const ORIGIN = new URL(process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config').origin;
const TRAY_PLATFORM = trayPlatform(process.platform);

/** 与宿主的通道：bridge 走管道 + 本地回调，否则 HTTP 直连。 */
const bridge = createBridge({ isBridge: BRIDGE, prefix: BRIDGE_PREFIX, origin: ORIGIN, token: APP_TOKEN });

/** 窗口能力：建窗、整窗穿透镜像、宠物状态广播、两条实时泵。 */
const petWindows = createWindows({
  BrowserWindow,
  screen,
  buildDeskGeometry,
  dpi,
  helperDir: __dirname,
  isBridge: BRIDGE,
  openTarget: OPEN_TARGET,
  platform: TRAY_PLATFORM,
  shouldReassertTopmost,
  topmostLevel,
  taskbarWatchdogEnabled: taskbarWatchdogEnabledFromEnv(process.env.DSH_PET_TASKBAR_WATCHDOG),
});
/** 托盘：显示开关与退出入口。 */
const tray = createTray({
  app,
  Tray,
  Menu,
  nativeImage,
  hostRequest: bridge.hostRequest,
  callbackUrl: bridge.callbackUrl,
  isBridge: BRIDGE,
  appMode: APP_MODE,
  petRoute: PET_ROUTE,
  platform: TRAY_PLATFORM,
  helperDir: __dirname,
});

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
      JSON.stringify(petWindows.geometry()) +
      ' forcedScaleFactor=' +
      (dpi.forcedScale || 'off') +
      ' primaryScale=' +
      (dpi.primaryScale || 'unknown') +
      ' petScale=' +
      dpi.petScale(),
  );

  if (BRIDGE) {
    // 自定义 scheme 接住渲染端全部请求（配置/余额/碎碎念/广播/素材）
    protocol.handle('dsh-pet-bridge', (request) =>
      bridge.handle(request).catch((e) => {
        console.error('[dsh-pet-desktop-helper] bridge handler error:', String(e && e.message ? e.message : e));
        return new Response('dsh-pet: bridge error', {
          status: 502,
          headers: { 'access-control-allow-origin': '*' },
        });
      }),
    );
    bridge.startCallback(); // 宿主应答回调服务器（stdin 在 Electron 主进程不可用，改走本地 HTTP）
  }

  // macOS：桌面宠物不该占 Dock。不跟 trayEnabled 联动——宠物本体的右键菜单仍在，桌面侧还能操作。
  if (TRAY_PLATFORM.hideDock && app.dock) app.dock.hide();

  // 托盘：不 await（建窗与建托盘互不依赖），内部自己等 bridge 回调服务就绪
  void tray.start();

  linuxPointer?.start();
  petWindows.create();

  // 合盖/唤醒是任务栏按钮重建最集中的时刻：resume / unlock-screen 后把每只宠物重新摘一次。
  // powerMonitor 只能在 ready 之后使用，所以挂在这里而不是模块顶层。
  const reassertTaskbar = () => {
    for (const win of petWindows.state.windows.values()) petWindows.keepOffTaskbar(win);
  };
  powerMonitor.on('resume', reassertTaskbar);
  powerMonitor.on('unlock-screen', reassertTaskbar);

  registerIpc({ ipcMain, petWindows, shell, openTarget: OPEN_TARGET, petRoute: PET_ROUTE });
  createDisplaySync({ screen, petWindows, dpi });

  // 冒烟自检（默认关闭）：DSH_PET_SMOKE=1 时延时截图到 DSH_PET_SMOKE_OUT 后退出，
  // 用于验证窗口/渲染/动画链路。
  if (process.env.DSH_PET_SMOKE === '1') {
    runSmokeCheck({
      app,
      windows: petWindows.state.windows,
      windowIgnore: petWindows.state.windowIgnore,
      setPointerFallbackPaused: petWindows.setPointerFallbackPaused,
    });
  }
});

// 退出时销毁托盘图标：不销毁会在 Windows 通知区留下「幽灵图标」（鼠标划过才消失）。
// 宿主改 display 时是 SIGTERM/SIGKILL 硬杀，Windows 上拦不到，所以这条只覆盖优雅退出。
app.on('before-quit', () => {
  petWindows.stopTaskbarWatchdog();
  if (!tray.exists()) return;
  try {
    tray.destroy();
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] tray destroy failed:', String(e && e.message ? e.message : e));
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻：桌面上没有宠物也要留着，否则「全关掉」就再也切不回来
  if (tray.exists()) return;
  app.quit();
});
