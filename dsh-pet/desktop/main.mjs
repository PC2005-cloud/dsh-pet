/**
 * 打包后的 Electron 主进程入口（ticket 02）。
 *
 * 安装目录里只有一个可执行文件，同一个 exe 按命令行参数分三种角色（纯逻辑在
 * `src/host/launch-plan.ts` 的 `parseAppRole`）：
 *   无参数 / --autostart → 宿主：在 Electron 主进程里跑现有独立模式（伪 Cordis ctx + apply()
 *                          + 本机 node:http 服务），不需要 DSH、不需要 Node；
 *   --dsh-pet-helper     → 桌面壳：加载现有 runtime/electron-helper/main.js（CJS）；
 *   --dsh-pet-dpi-probe  → 一次性 DPI 探测：壳的开关只认 DSH_PET_DPI_PROBE，这里补上环境变量。
 *
 * 布局约束：安装包内 `desktop/`、`lib/`、`runtime/electron-helper/`、`assets/` 必须保持相对位置不变 ——
 * `src/host/index.ts` 的 PACKAGE_ROOT 由 bundle（lib/index.js）位置反推，挪动任何一层都会让
 * 配置、字体、图片、视频与 package.json 版本一起错位（见 electron-builder.yml 的 files 白名单）。
 *
 * 本文件是 ESM（.mjs + 包根 package.json 的 type: module），Electron 43 支持 ESM 主进程。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 打包形态标志：宿主半边（src/host/index.ts 的 startHelper）据此完全不碰
// resolveElectronPath / ensureElectronDownload —— 安装包已内置运行时，断网也必须能启动。
// 必须在加载 lib/ 产物之前设置；子进程经 helperSpawnEnv 复制 process.env 自动继承。
process.env.DSH_PET_PACKAGED = '1';

const { parseAppRole } = await import('../lib/launch-plan.js');
// second-instance 的启动时序闸门（纯逻辑，见 src/host/single-instance.ts）
const { createFocusGate } = await import('../lib/single-instance.js');
// 打包形态下 process.argv = [exe 路径, ...应用参数]，与 launch-plan 的约定一致
const invocation = parseAppRole(process.argv.slice(1));
for (const warning of invocation.warnings) console.warn(`[dsh-pet] ${warning}`);

if (invocation.role === 'dpi-probe') {
  // 壳的探测开关当前只认这个环境变量（desktop/main.mjs 的角色参数只负责把进程引到这里）。
  // probePrimaryScale 用 `process.execPath + [__filename, '--dsh-pet-dpi-probe']` 起子进程，
  // 打包后 __filename 在 asar 内、不是以 '-' 开头，parseAppRole 会忽略它并识别出探测角色。
  process.env.DSH_PET_DPI_PROBE = '1';
}

if (invocation.role === 'helper' || invocation.role === 'dpi-probe') {
  // 现有桌面壳是 CJS（runtime/electron-helper/package.json 没有 type 字段，见 packaging.test.ts）。
  // 相对路径刻意保留包内布局：desktop/ 与 runtime/、lib/ 同级。
  // 注意：这一支**不取单实例锁** —— 壳是宿主 spawn 出来的第二个进程，DPI 探测还会再 spawn 一个；
  // 让它们参与锁会把合法的子进程判成重复实例（ticket 05）。
  require('../runtime/electron-helper/main.js');
} else {
  // 宿主角色：走独立模式的可编程入口（不要 import lib/standalone.js —— 那是 CLI，
  // 被 import 就会解析 argv 并 process.exit）。
  const { app } = require('electron');
  // 单实例锁只在宿主角色、且在启动服务/窗口之前取（ticket 05）：
  // 第二次双击时拿不到锁 → 立即退出，不启动 standalone 服务、不拉起第二套 helper；
  // 第一个实例会收到 app 的 second-instance 事件，由 startHost 里的闸门唤回已有宠物窗口。
  // Electron 的锁随进程退出释放，宿主正常退出/被结束后下一次启动能重新拿到。
  if (!app.requestSingleInstanceLock()) {
    console.error('[dsh-pet] 已有实例在运行，本次启动退出');
    app.exit(0);
  } else {
    await startHost(app);
  }
}

/**
 * 宿主角色启动（已持有单实例锁）。
 *
 * second-instance 可能早于启动完成到达（例如自启实例还在延迟启动，用户已手动双击）：
 * 请求记为 pending，等 startStandalone 返回、服务与 helper 就绪后再执行一次唤回——
 * 既不提前打断延迟，也绝不会再拉起第二套。
 */
async function startHost(app) {
  let handle;
  const gate = createFocusGate({
    focus: async () => {
      if (!handle) throw new Error('宿主尚未完成启动');
      if (!(await handle.focusWindows())) throw new Error('桌面 Helper 未响应唤回请求（详见上方日志）');
    },
    onError: (error) => {
      console.warn(`[dsh-pet] 唤回宠物窗口失败：${error instanceof Error ? error.message : String(error)}`);
    },
  });
  // 监听尽早注册（此处尚未 await）：锁已到手，second-instance 随时可能到。
  app.on('second-instance', () => {
    console.log('[dsh-pet] 检测到二次启动，唤回已有宠物窗口');
    gate.request();
  });

  const { startStandalone } = await import('../lib/standalone-app.js');

  const exitAfter = (shutdown) => {
    shutdown()
      .then(() => app.exit(0))
      .catch((error) => {
        console.error(`[dsh-pet] 收尾失败：${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      });
  };

  try {
    handle = await startStandalone({
      autostart: invocation.autostart,
      onShutdownRequested: (_reason, shutdown) => exitAfter(shutdown),
    });
    // 启动完成：此刻才放行 pending 的唤回（ticket 09 的延迟启动接在这之前）。
    gate.markReady();
    // 宿主生命周期与 HTTP 服务一致：收到信号先释放插件 effect、关服务、清运行时文件，再退出。
    // （Windows 上 GUI 进程通常收不到 SIGTERM；验证/托盘退出走带 token 的 POST /shutdown。）
    process.once('SIGINT', () => exitAfter(() => handle.shutdown('SIGINT')));
    process.once('SIGTERM', () => exitAfter(() => handle.shutdown('SIGTERM')));
  } catch (error) {
    console.error(`[dsh-pet] 宿主启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    app.exit(1);
  }
}
