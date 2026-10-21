/**
 * 桌面应用入口（electron-builder 打包产物的宿主实例，tsdown 第 4 份配置 → lib/desktop.js）。
 *
 * 一个 exe 两种角色，角色分流在 bootstrap.js（由 scripts/build-desktop-app.mjs 生成）：
 *   - Helper 实例（宿主经 HelperProcess spawn，env 带 DSH_PET_CONFIG_URL）：
 *     bootstrap 直接 require runtime/electron-helper/main.js，不经过本文件；
 *   - 宿主实例（用户双击 exe）→ 走到这里：起独立模式（HTTP 服务 + apply → 拉起透明小窗），
 *     再挂一个托盘图标（打开设置页 / 退出）。
 *
 * 与 CLI 入口（./cli）的差异：
 *   - 双击启动没有终端，日志双写文件（~/.dsh/dsh-pet-desktop/log.txt，超 1MB 轮转）；
 *   - 进程即 Electron：把自己的 execPath 喂给 DSH_PET_ELECTRON_PATH，HelperProcess 会
 *     spawn 本 exe（带 helper 的 env）拉起透明小窗 —— 不需要再下载/探测 Electron；
 *   - runStandalone 的启动前置不满足时返回 undefined（CLI 靠 process.exitCode 退出，
 *     Electron 宿主没有 exitCode 可等），这里显式 app.exit(1)。
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StandaloneLogger } from './context';
import { parseArgs } from './options';
import { runStandalone } from './run';

/** Electron 主进程 API 的最小类型面：运行时经 createRequire 取得（不引入 electron 依赖） */
interface TrayLike {
  setContextMenu(menu: unknown): void;
  setToolTip(text: string): void;
}
interface ElectronMainApi {
  app: {
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    exit(code?: number): void;
  };
  Tray: new (icon: unknown) => TrayLike;
  Menu: { buildFromTemplate(template: Array<Record<string, unknown>>): unknown };
  nativeImage: { createFromPath(path: string): unknown };
  shell: { openExternal(url: string): Promise<void> };
}

const require = createRequire(import.meta.url);

/** 文件日志：超过 1MB 轮转成 .old（只保留一代，日志量很小，够排障用） */
const LOG_DIR = join(homedir(), '.dsh', 'dsh-pet-desktop');
const LOG_FILE = join(LOG_DIR, 'log.txt');
const LOG_OLD = join(LOG_DIR, 'log.old.txt');
const LOG_MAX_BYTES = 1024 * 1024;

/** 双写日志器：控制台（调试期可见）+ 文件（双击启动没有终端，排障全靠它） */
function createDesktopLogger(): StandaloneLogger {
  const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
  let fileWritable = false;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    fileWritable = true;
  } catch {
    /* 目录建不出来就只留控制台日志，不影响运行 */
  }
  const write = (level: string, message: string): void => {
    const line = `[dsh-pet-desktop ${stamp()}] ${level} ${message}`;
    console.log(line);
    if (!fileWritable) return;
    try {
      if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        rmSync(LOG_OLD, { force: true }); // Windows 的 rename 不覆盖已存在目标，先删旧的
        renameSync(LOG_FILE, LOG_OLD);
      }
    } catch {
      /* 轮转失败不影响本次写入 */
    }
    void appendFile(LOG_FILE, `${line}\n`, 'utf8').catch(() => {
      /* 写日志失败静默：日志层绝不能把应用带崩 */
    });
  };
  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    debug: (message) => {
      if (process.env.DSH_PET_STANDALONE_DEBUG === '1') write('DEBUG', message);
    },
  };
}

/** 托盘：左键弹菜单。设置页 = 独立模式 HTTP 服务上的设置路由（与 cli 横幅同一地址） */
function buildTray(electron: ElectronMainApi, port: number, requestShutdown: (reason: string) => void): void {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) break;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  const iconPath = join(dir, 'assets', 'logo.png');
  const tray = new electron.Tray(electron.nativeImage.createFromPath(iconPath));
  tray.setToolTip('dsh-pet 桌宠（独立模式）');
  tray.setContextMenu(
    electron.Menu.buildFromTemplate([
      {
        label: '打开设置页',
        click: () => {
          // 路由前缀与 src/host/index.ts 的 ROUTE_PREFIX 一致（该常量未导出，此处按字面量对齐）
          void electron.shell.openExternal(`http://127.0.0.1:${port}/dsh-pet-7340/`);
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => requestShutdown('托盘退出') },
    ]),
  );
}

/** 桌面应用宿主实例入口 */
async function main(): Promise<void> {
  const electron = require('electron') as ElectronMainApi;

  // 防双开：第二个宿主实例拿不到锁就退出（Helper 实例不经过本文件，也不持锁，
  // 因此每只宠物一个局部小窗口的多进程形态不受影响）
  if (!electron.app.requestSingleInstanceLock()) {
    electron.app.exit(0);
    return;
  }

  // 命令行只留 --port 一个口子（argv[0] 是 exe 自身，用户参数从 1 起）；解析失败直接退出
  const parsed = parseArgs(process.argv.slice(1));
  if ('error' in parsed) {
    console.error(`dsh-pet-desktop: ${parsed.error}\n用法：dsh-pet-desktop.exe [--port <端口>]`);
    electron.app.exit(2);
    return;
  }

  await electron.app.whenReady();

  // HelperProcess 将 spawn 本 exe（带 DSH_PET_CONFIG_URL 等 env）拉起透明小窗：
  // 把自身可执行文件喂给 resolveElectronPath 的 env 候选，helper 不必再探测/下载 Electron。
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;

  const logger = createDesktopLogger();
  const result = await runStandalone(logger, { port: parsed.options.port });
  if (!result) {
    // 启动前置不满足（包内默认配置缺失等）：runStandalone 已打日志，这里结束进程
    electron.app.exit(1);
    return;
  }
  buildTray(electron, result.port, result.requestShutdown);
}

main().catch((error: unknown) => {
  console.error(`dsh-pet-desktop: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  appExitOnError(1);
});

/** main 之外的兜底退出：electron 模块此时仍可取（require 已初始化过），取不到就退进程 */
function appExitOnError(code: number): void {
  try {
    (require('electron') as ElectronMainApi).app.exit(code);
  } catch {
    process.exit(code);
  }
}