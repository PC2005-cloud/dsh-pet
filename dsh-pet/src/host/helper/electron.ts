/**
 * Electron 定位与下载：找已安装的二进制，缺失时按需下载并解压。
 *
 * 不负责启动进程（归 ./child）；下载失败记日志后返回 undefined，由调用方降级为仅浏览器模式。
 * 必须始终成立：解析结果必须落在包内或用户数据目录，不接受任意路径。
 * @module dsh-pet/src/host/helper/electron
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { type LoggerLike } from '../log-file.ts';
import { PACKAGE_ROOT } from '../paths.ts';
import type { HelperOptions } from './child.ts';

// `@electron/get` 只在真要下载 Electron 时才用到，故按需动态加载（见 ensureElectronDownload）：
// 静态 import 会把它连同 got/fs-extra 一串依赖钉进每个产物的启动路径，而独立应用模式下这条路径不执行。
const require = createRequire(import.meta.url);

/** 包根：与宿主其它模块共用同一个锚点（见 ../paths.ts），不得按本文件目录另算一份。 */
export const packageRoot = PACKAGE_ROOT;

/** 默认的 Helper 入口（runtime/electron-helper/main.js）。 */
export const defaultHelperMain = resolve(packageRoot, 'runtime', 'electron-helper', 'main.js');

/** 只做基本文件校验：不验证二进制格式，也不实际启动候选。 */
function isNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 解析 Electron 可执行文件，按优先级取第一个存在且非空的候选：显式候选与 DSH_PET_ELECTRON_PATH
 * → 本机 electron npm 包 → $DSH_HOME/electron（下载落地路径）。
 * 只认自己的落地路径，不再去 npm 全局目录 / Program Files / /usr/bin 探测别人装的 Electron。
 * 都不存在时由 ensureElectronDownload() 在进程内异步下载（不 spawn 子进程，避免 process.execPath
 * 在 Electron 宿主里指向宿主 exe 而崩溃）。
 */
export function resolveElectronPath(candidates: Array<string | undefined> = []): string | undefined {
  const seen = new Set<string>();
  const list: string[] = [];
  const push = (value: string | undefined | null): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };
  for (const value of candidates) push(value);
  if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && resolved) push(resolved);
  } catch {
    /* electron 未安装时跳过 */
  }
  // 只认自己的落地路径（ensureElectronDownload 下载解压到 $DSH_HOME/electron）；
  // 不再去 npm 全局目录 / Program Files / /usr/bin 等别处探测别人装的 Electron。
  push(defaultElectronExe());
  return list.find(isNonEmptyFile);
}

/**
 * 判断当前环境能否真的跑起 Electron 图形窗口。
 *
 * Linux 无显示环境（服务器 / 容器 / 纯 CLI）下 Electron 能被下载并 spawn，却在初始化图形栈时崩溃；
 * 配合守护循环就变成每秒「拉起 → 崩溃 → 重启」，每个 core dump 约 14MB，几小时能堆到数十 GB 打满
 * 磁盘，所以必须在拉起之前判断。只拦「明确跑不起来」的：win32 / darwin 放行（macOS 无 DISPLAY 也走
 * WindowServer），linux 需要 DISPLAY 或 WAYLAND_DISPLAY 其一。逃生口 DSH_PET_DESKTOP_FORCE=1 强制
 * 跳过，供 Xvfb / 远程桌面等「环境变量没设但其实能显示」的场景使用。
 */
export function hasGraphicalDisplay(): boolean {
  if (process.platform !== 'linux') return true;
  if (process.env.DSH_PET_DESKTOP_FORCE === '1') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** $DSH_HOME（默认 ~/.dsh）；测试与独立模式共用这一处推导。 */
export function dshHomeDir(): string {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  return process.env.DSH_HOME || join(userProfile, '.dsh');
}

// Electron 官方发布包按平台/架构不同：win32 解压出 electron.exe + 散文件，darwin 是 Electron.app
// （可执行文件在 Contents/MacOS/Electron），linux 是 electron 单文件。

/** 当前平台标识（win32 / darwin / linux）。 */
const PLAT = process.platform;

/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台）。 */
const ELECTRON_REL =
  PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

/**
 * Electron 运行时落地目录（$DSH_HOME/electron）—— 下载解压的目标，也是设置页「卸载与存储」里让
 * 用户清理的那个目录。解析（resolveElectronPath / defaultElectronExe）与下载都必须走这里：同一个
 * 目录字面量在别处再写一遍，改了一处另一处没改，设置页就会显示一个永远不存在的路径。
 */
export function electronLandingDir(): string {
  return join(dshHomeDir(), 'electron');
}

/** Electron 落地路径：$DSH_HOME/electron/<按平台的可执行文件>。 */
export function defaultElectronExe(): string {
  return join(electronLandingDir(), ELECTRON_REL);
}

/** 进程内下载 Electron 的选项。 */
export interface EnsureElectronOptions {
  /** Electron 版本号（默认 43.3.0，可被 DSH_PET_ELECTRON_VERSION 覆盖）。 */
  version?: string;
  /** 下载镜像（默认 npmmirror，可被 DSH_PET_ELECTRON_MIRROR 覆盖）。 */
  mirror?: string;
  /** 单次下载超时（默认 10 分钟）。 */
  timeoutMs?: number;
  /**
   * 面向用户的日志出口（进桌宠工作气泡）。与 console 分开：console 留英文原文给终端 / CLI 排障，
   * 这里产出给「没有控制台的 DSH 桌面版用户」看的一句短话。本函数只产出文本，不认识 state。
   */
  onLog?: (event: ElectronDownloadLog) => void;
  /** 落盘日志出口（宿主注入的统一日志器，见 ./log-file）；不传则退回 console。 */
  logger?: LoggerLike;
}

/** 一条下载日志：`text` 给用户看；`level='warn'` = 失败路径；`done` = 本次下载已收尾（成功或失败）。 */
export interface ElectronDownloadLog {
  text: string;
  level: 'info' | 'warn';
  done: boolean;
}

/**
 * 进程内下载并解压 Electron 到 $DSH_HOME/electron。
 *
 * 不 spawn 子进程：CLI node 与 Electron 宿主（DSH Desktop）里都可用，也避开了 process.execPath 在
 * 宿主里指向宿主 exe 而崩溃。已存在则原样返回；失败返回 undefined（不影响 DSH 与浏览器 overlay）。
 */
export async function ensureElectronDownload(options: EnsureElectronOptions = {}): Promise<string | undefined> {
  const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || '43.3.0';
  const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const targetDir = electronLandingDir();
  const exe = defaultElectronExe();
  if (isNonEmptyFile(exe)) return exe;

  // 下载日志默认走 console；宿主会把它自己的统一日志器传进来——桌面版没有控制台，console 直出
  // 等于丢失（ctx.logger 在部分宿主也不映射到终端）。
  const sink = options.logger ?? console;
  const log = (message: string): void => sink.info?.(`[dsh-pet] ${message}`);
  const warn = (message: string): void => sink.warn?.(`[dsh-pet] ${message}`);
  // 同一件事两个出口（见 EnsureElectronOptions.onLog）：console 原文 + 给用户看的一句。
  // 文案刻意分成两套——版本号 / 路径 / 耗时对开发者有用，对用户是噪音，不合并成同一句。
  const info = (consoleText: string, text: string, done = false): void => {
    log(consoleText);
    options.onLog?.({ text, level: 'info', done });
  };
  const fail = (consoleText: string, text: string): void => {
    warn(consoleText);
    options.onLog?.({ text, level: 'warn', done: true });
  };
  const startedAt = Date.now();

  if (existsSync(exe)) {
    info(`Electron cache is empty or not a regular file: ${exe}`, 'Electron 缓存无效，准备重新下载');
  }
  info(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`, `正在下载 Electron ${version}`);

  try {
    // 目录创建也可能失败（权限不足、同名文件等），与下载失败一样降级到浏览器宠物。
    mkdirSync(targetDir, { recursive: true });
    // 官方 @electron/get 下载：负责 URL 拼装、镜像、SHA256 校验（sumchecker）、下载缓存
    // （同一版本只下载一次，之后命中缓存秒回）。超时用 AbortController 传给 fetch。
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    let nextLogAt = Date.now() + 3000;
    try {
      // 按需加载（见文件头的 import 注释）：只有走到「确实要下载」这一步才会解析这个包
      const { downloadArtifact } = await import('@electron/get');
      const zipPath = await downloadArtifact({
        version: `v${version}`,
        artifactName: 'electron',
        // platform/arch 不传：@electron/get 用宿主平台与架构自动推断
        // （getHostArch 还处理 arm → armv7l 特例，比显式传 process.arch 更准）
        mirrorOptions: { mirror: mirror.replace(/\/$/, '') + '/' },
        downloadOptions: {
          signal: controller.signal,
          quiet: true, // 关掉 @electron/get 自己的进度条（stdout 走宿主日志，不进 bridge 协议）
          getProgressCallback: async (progress: { transferred: number; total: number | null }) => {
            const now = Date.now();
            if (!progress.total || now < nextLogAt) return;
            nextLogAt = now + 3000;
            const doneMb = (progress.transferred / 1024 / 1024).toFixed(1);
            const totalMb = (progress.total / 1024 / 1024).toFixed(1);
            const percent = Math.min(100, Math.floor((progress.transferred / progress.total) * 100));
            info(`downloading ${doneMb}MB / ${totalMb}MB`, `Electron 下载 ${percent}% · ${doneMb}/${totalMb}MB`);
          },
        },
      });
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      info(`download complete (${seconds}s), extracting to ${targetDir} ...`, `下载完成（${seconds}s），正在解压`);
      // 解压用官方 extract-zip（electron 43 官方安装同款）：纯 Node + native binding，跨平台一致，
      // 正确处理 symlink 与文件权限，不需要系统 unzip/tar/powershell。
      // 必须动态 import：该包是 N-API 原生模块，预编译产物没有 Android target，静态 import 会在模块
      // 求值期就 throw，让只想用 Web 模式的用户整个 entry 激活失败；按需加载后失败只落进本函数 catch。
      const { default: extract } = await import('@electron-internal/extract-zip');
      await extract(zipPath, { dir: targetDir });
      if (!isNonEmptyFile(exe)) {
        throw new Error(`Electron zip extracted, but ${ELECTRON_REL} is missing, empty or not a regular file`);
      }
      const readySeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      info(`ready in ${readySeconds}s: ${exe}`, `Electron 就绪（${readySeconds}s），正在启动桌宠`, true);
      return exe;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`ensure failed: ${reason}`, `Electron 下载失败：${reason}`);
    warn('desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.');
    return undefined;
  }
}

/**
 * 默认启动方式：Electron 可执行文件 + Helper 入口脚本。
 * @throws Electron 解析不到时抛错（调用方据此降级到浏览器宠物）。
 */
/** 覆盖 Linux 显示后端的环境变量（空/未设 = 按 DISPLAY 自动决定，见 {@link displayBackendArgs}）。 */
export const OZONE_PLATFORM_ENV = 'DSH_PET_OZONE_PLATFORM';

/**
 * 当前该给 Electron 补哪些显示后端开关（win32/darwin 恒为空）。
 *
 * 桌面宠物在 Linux 上必须跑 X11（XWayland）：宠物的"移动"= 每帧让窗口跟着宠物走（渲染端上报
 * bounds → 主进程 setContentBounds）。Wayland 协议里客户端**无权决定自己顶层窗口的位置**，
 * Ozone/Wayland 后端会把 SetBounds 的 x/y 静默丢弃——而 getBounds 只回显请求值，自检看不出来。
 * 实测（KDE Plasma 6，Electron 43.3.0）：同一只宠物在 Wayland 后端下被合成器摆在 (271,52) 且
 * keepAbove=false；加 `--ozone-platform=x11` 后落在渲染端要求的位置、图层=置顶层。
 *
 * 开关只能走命令行：ozone 后端在 JS 主脚本跑起来之前就定了，主进程里 appendSwitch 无效。
 *
 * @param platform 目标平台（默认当前进程）。
 * @param env 环境变量来源（默认 process.env）。
 * @returns 要插在 argv 最前面的开关；不需要时为空数组。
 */
export function displayBackendArgs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform !== 'linux') return [];
  const override = String(env[OZONE_PLATFORM_ENV] ?? '').trim();
  if (override) return [`--ozone-platform=${override}`];
  // 没有 DISPLAY = 没有 XWayland/X11 可落：加了也只会起不来窗口，保持原行为
  return env.DISPLAY ? ['--ozone-platform=x11'] : [];
}

/**
 * 把显示后端开关补到 argv 最前面（必须在 app 路径之前；已显式指定则原样返回）。
 *
 * @param args 原始 argv。
 * @param platform 目标平台。
 * @param env 环境变量来源。
 */
export function withDisplayBackendArgs(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (args.some((arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))) return args;
  const extra = displayBackendArgs(platform, env);
  return extra.length === 0 ? args : [...extra, ...args];
}

export function defaultLaunch(options: HelperOptions = {}): { command: string; args: string[] } {
  const electronPath = resolveElectronPath([options.electronPath]);
  if (!electronPath) {
    throw new Error('dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.');
  }
  const helperPath = options.helperPath || defaultHelperMain;
  // Linux 补 --ozone-platform=x11：Wayland 不允许客户端定位顶层窗口（见 displayBackendArgs）
  return { command: electronPath, args: withDisplayBackendArgs([helperPath]) };
}
