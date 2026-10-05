/**
 * dsh-pet desktop helper —— Electron 用户数据目录的覆盖判定（独立模式与 DSH 内运行的隔离）。
 *
 * 背景（0.3.5 发版后真机复现）：helper 用 `app.setName('dsh-pet-electron-helper')` 定名，
 * 于是 userData 固定落在 `%APPDATA%\dsh-pet-electron-helper` —— **与哪个宿主把它拉起来无关**。
 * 换言之「DSH 内那只」与「独立模式那只」共用同一个 Chromium profile：
 * 后启动的那只拿不到 profile 锁，真机日志是
 *   `ERROR:net\disk_cache\cache_util_win.cc:25 Unable to move the cache: 拒绝访问。 (0x5)`
 *   `ERROR:net\disk_cache\disk_cache.cc:284 Unable to create cache`
 *   `ERROR:gpu\ipc\host\gpu_disk_cache.cc:737 Gpu Cache Creation failed: -2`
 * 结果是 helper 只起来 1 个子进程（正常 3 个）、渲染端**一个素材都不拉**、宠物画不出来。
 * 这不是"良性缓存警告"，是硬冲突。
 *
 * 旁路都已验证无效：
 *   - 只给这个进程改 `%APPDATA%`：Windows 上 Electron 取路径走系统 API，不读环境变量；
 *   - `--user-data-dir`：Chromium 支持，但插件侧没有把它传给 helper 的口子（本文件补上等效能力）；
 *   - 「关掉某一侧的桌面小窗」：`hasGraphicalDisplay()` 在 win32 恒为 true，没有这个开关。
 *
 * 因此由**独立模式**（src/standalone/cli.ts）默认声明 `DSH_PET_USER_DATA_DIR`，main.js 在
 * **任何一次 getPath('userData') 之前**设进 Electron；helper 的 DPI 探测子进程继承同一份 env，
 * 于是也落在同一目录。未设置时本模块返回 null，行为与以前完全一致（DSH 内运行不受影响）。
 *
 * 这里只放**纯逻辑**（不 require('electron')）：helper 是随包发行的手写 JS，而开发机上跑不起
 * Electron（受限环境里 Chromium 建不了自己的 Mojo 命名管道），所以判定必须能脱离 Electron 单测。
 */

'use strict';

const path = require('node:path');

/**
 * 解析覆盖用的用户数据目录。
 *
 * 宽松到"读不懂就不改行为"：非字符串、空串、纯空白一律返回 null，让 Electron 用它自己的默认目录；
 * 合法值裁掉首尾空白后 `path.resolve` 成绝对路径（`app.setPath` 只接受绝对路径）。
 *
 * @param {Record<string, string|undefined>} env 进程环境（注入以便单测）
 * @returns {string|null} 绝对路径；未设置/不可用时 null
 */
function resolveUserDataDir(env) {
  const raw = env ? env.DSH_PET_USER_DATA_DIR : undefined;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : path.resolve(trimmed);
}

module.exports = { resolveUserDataDir };
