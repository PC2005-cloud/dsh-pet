/**
 * 插件存储位置清单（设置页「卸载与存储」区块的数据源）。
 *
 * 只做路径推导，不复制任何写入逻辑：用户数据与 Electron 落地目录直接取调用方从真实写入方传来的
 * 路径，只有系统级目录（桌面端 userData、Electron 下载缓存）按平台镜像一份。
 * 必须始终成立：能靠调用消掉的路径字面量不再写第二遍——多写一处就多一处会漂移的硬编码；
 * 桌面端应用名与 main.js 的 app.setName 必须一致（测试直接读 main.js 校验）。
 * @module dsh-pet/src/host/storage-paths
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 桌面端 Electron userData 目录名（= main.js 的 app.setName 入参）。 */
export const DESKTOP_APP_NAME = 'dsh-pet-electron-helper';

/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关）。 */
const ELECTRON_PATHS_NAME = 'electron';

/** 清单条目键：客户端按它取本地化文案（各语言字典的 'storage.<key>'）。 */
export type StorageKey = 'userData' | 'electron' | 'desktopCache' | 'electronCache' | 'package';

/** 一条存储位置。 */
export interface StorageEntry {
  key: StorageKey;
  /** 绝对路径 */
  path: string;
  /** 此刻是否已存在（false = 还没产生，例如从未启用过桌面模式） */
  exists: boolean;
}

/** 清单推导的输入：各基准目录、平台与环境（后两者测试注入）。 */
export interface StoragePathInput {
  /** 插件用户数据根：传 index.ts 里真实用于写盘的 userRoot，本模块不自己拼 'dsh-pet'。 */
  userDataRoot: string;
  /** Electron 运行时落地目录：传 helper-process.ts 的 electronLandingDir()（下载方的唯一定义）。 */
  electronDir: string;
  /** 用户主目录（系统级基准目录的兜底） */
  home: string;
  /** 本包根目录（= 插件本体所在目录） */
  packageRoot: string;
  /** 平台，默认 process.platform（测试注入） */
  platform?: NodeJS.Platform;
  /** 环境变量，默认 process.env（测试注入） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 桌面端 userData 目录（Electron app.getPath('userData') 的等价推导）。
 * 逐平台对齐 Electron 口径：win32 = %APPDATA%\<name>，darwin = ~/Library/Application Support/<name>，
 * linux = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>。
 */
function desktopUserDataDir(input: StoragePathInput): string {
  const { home, env = process.env, platform = process.platform } = input;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), DESKTOP_APP_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', DESKTOP_APP_NAME);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), DESKTOP_APP_NAME);
}

/**
 * Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
 * win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，Linux 用 $XDG_CACHE_HOME
 * （默认 ~/.cache）。该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
 */
function electronCacheDir(input: StoragePathInput): string {
  const { home, env = process.env, platform = process.platform } = input;
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), ELECTRON_PATHS_NAME, 'Cache');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', ELECTRON_PATHS_NAME);
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), ELECTRON_PATHS_NAME);
}

/**
 * 插件在本机落盘的全部位置（顺序即设置页展示顺序：先用户数据，后运行时与缓存，最后插件本体）。
 *
 * 前两条直接取真实写入方的路径，只有系统级目录由本模块按平台推导。
 * @param input - 各基准目录与平台、环境（测试注入）。
 * @returns 条目数组；exists 由当前磁盘状态即时判定。
 */
export function storageEntries(input: StoragePathInput): StorageEntry[] {
  const items: Array<{ key: StorageKey; path: string }> = [
    { key: 'userData', path: input.userDataRoot },
    { key: 'electron', path: input.electronDir },
    { key: 'desktopCache', path: desktopUserDataDir(input) },
    { key: 'electronCache', path: electronCacheDir(input) },
    { key: 'package', path: input.packageRoot },
  ];
  return items.map((it) => ({ ...it, exists: existsSync(it.path) }));
}

/**
 * 从本包路径反推 profile 名（设置页拼卸载命令用）。
 *
 * 常规安装形态是 <$DSH_HOME>/profiles/<name>/node_modules/dsh-pet；反推不出来（link: 安装到别处、
 * 或装在 profiles/node_modules 共享层）返回 undefined，由客户端退回占位符——宁可不给名字，也不猜错。
 * @param packageRoot - 本包根目录。
 * @returns profile 名，或 undefined。
 */
export function profileNameFrom(packageRoot: string): string | undefined {
  const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot);
  return m?.[1];
}
