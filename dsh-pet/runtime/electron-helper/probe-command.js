/**
 * DPI 探测子进程的启动命令 —— 纯逻辑（不 require electron、不碰 fs/env）。
 *
 * 壳在 app ready 之前需要主屏 scaleFactor，只能 spawn 一个一次性探测进程
 * （`DSH_PET_DPI_PROBE=1`，打印一行后退出）。两种运行形态的拉起方式不同：
 *   开发形态：`electron.exe <helper main.js> --dsh-pet-dpi-probe`
 *   打包形态：安装目录里只有一个 exe，入口内置 —— `DSH Pet.exe --dsh-pet-dpi-probe`
 *             （`desktop/main.mjs` 按参数分流到 dpi-probe 角色，再把 DSH_PET_DPI_PROBE 置 1）。
 *
 * 打包后 `__filename` 指向 asar 内的脚本路径，把它当参数传给 exe 没有意义，
 * 还会随角色分流规则变化而变成不可预测的行为 —— 所以命令构造收在这里，带单测（ticket 03）。
 */

'use strict';

/**
 * @param {{packaged?: boolean, execPath: string, helperEntry?: string}} input
 * @returns {{command: string, args: string[]}}
 */
function probeSpawnCommand(input) {
  const execPath = input && input.execPath;
  if (typeof execPath !== 'string' || !execPath) {
    throw new TypeError('probeSpawnCommand: execPath is required');
  }
  const packaged = Boolean(input.packaged);
  if (packaged) {
    // 同一个应用 exe + 角色参数；入口由包内 desktop/main.mjs 分流，不传脚本路径。
    return { command: execPath, args: ['--dsh-pet-dpi-probe'] };
  }
  const helperEntry = input.helperEntry;
  if (typeof helperEntry !== 'string' || !helperEntry) {
    throw new TypeError('probeSpawnCommand: helperEntry is required when packaged is false');
  }
  return { command: execPath, args: [helperEntry, '--dsh-pet-dpi-probe'] };
}

module.exports = { probeSpawnCommand };
