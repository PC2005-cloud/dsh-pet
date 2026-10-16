/**
 * 插件存储位置清单（设置页「卸载与存储」区块的数据源）。
 *
 * 这四类位置分属互不相干的基准目录，本模块按「谁写得进谁说了算」分两种来源：
 *
 *   1) 直接吃真实写入方给的路径（零重复，不存在漂移）：
 *      - 用户数据    ← 调用方传 index.ts 的 userRoot（拼 'dsh-pet' 的地方只有那一处）
 *      - Electron    ← 调用方传 helper-process.ts 的 electronLandingDir()（下载方的唯一定义）
 *
 *   2) 系统规则，本模块按平台镜像一份（写入方不是本仓库的代码，无法调用）：
 *      - 桌面端 userData  ← Electron 的 app.getPath('userData')
 *      - Electron 下载缓存 ← @electron/get 默认 cacheRoot = env-paths('electron').cache
 *
 * 第 2 类里唯一能靠调用消掉的字面量是桌面端应用名（main.js 的 app.setName），
 * 但那个文件是独立 CJS（无构建、不可 import），只能在两处各写一遍——
 * storage-paths.test.ts 直接读 main.js 校验它，改了不同步就红。
 * 第 2 类的其余部分（env-paths 的平台口径、Electron 的 userData 口径）是上游约定，
 * 用逐平台用例钉住；上游若改口径，这里必须跟着改（测试只保证我们自己没写错）。
 *
 * 本模块只做路径推导，不复制任何写入逻辑。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 桌面端 Electron userData 目录名（= main.js 的 app.setName 入参） */
export const DESKTOP_APP_NAME = 'dsh-pet-electron-helper';

/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关） */
const ELECTRON_PATHS_NAME = 'electron';

/** 清单条目键：客户端按它取本地化文案（zh/en 的 'storage.<key>'） */
export type StorageKey = 'userData' | 'electron' | 'desktopCache' | 'electronCache' | 'package';

export interface StorageEntry {
  key: StorageKey;
  /** 绝对路径 */
  path: string;
  /** 此刻是否已存在（false = 还没产生，例如从未启用过桌面模式） */
  exists: boolean;
}

export interface StoragePathInput {
  /**
   * 插件用户数据根 —— 传 index.ts 里那个**真实用于写盘**的 userRoot；
   * 本模块不自己拼 'dsh-pet'（拼一遍就多一处会漂移的硬编码）。
   */
  userDataRoot: string;
  /** Electron 运行时落地目录 —— 传 helper-process.ts 的 electronLandingDir()（下载方的唯一定义） */
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
 *
 * 与 Electron 的口径逐平台对齐：
 *   win32  = %APPDATA%\<name>（appData 在 Windows 就是 Roaming）
 *   darwin = ~/Library/Application Support/<name>
 *   linux  = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>
 */
function desktopUserDataDir(input: StoragePathInput): string {
  const { home, env = process.env, platform = process.platform } = input;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), DESKTOP_APP_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', DESKTOP_APP_NAME);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), DESKTOP_APP_NAME);
}

/**
 * Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
 *
 * env-paths 的口径：win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，
 * Linux 用 $XDG_CACHE_HOME（默认 ~/.cache）——都是「应用名单独一层」。
 * 该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
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
 * 前两条直接取真实写入方的路径（userDataRoot / electronDir 由调用方从写盘方传入），
 * 只有系统级目录（桌面端 userData 与 Electron 下载缓存）由本模块按平台推导。
 * @param input 各基准目录与平台/环境（测试注入）
 * @returns 条目数组；exists 由当前磁盘状态即时判定
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
 * 常规安装形态是 <$DSH_HOME>/profiles/<name>/node_modules/dsh-pet；命中即得 <name>。
 * 反推不出来的情况（link: 安装到别处、或装在 profiles/node_modules 共享层）返回 undefined，
 * 由客户端退回占位符——宁可不给具体名字，也不猜一个错的。
 * @param packageRoot 本包根目录
 * @returns profile 名，或 undefined
 */
export function profileNameFrom(packageRoot: string): string | undefined {
  const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot);
  return m?.[1];
}
