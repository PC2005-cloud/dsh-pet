/**
 * 独立模式体检（`--check`）：不 `apply`、不起窗口、不联网，只回答"为什么能/不能跑起来"。
 *
 * 为什么单独一份而不是复用路由：体检的价值恰恰在于**不启动宿主**（否则一跑就把桌宠窗口拉起来，
 * 排查"没出现"时反而多一个变量）。因此这里直接读插件自己的纯模块
 * （`host/config.ts` 的 readAllConfig/flattenPetList、`host/helper-process.ts` 的 Electron 解析），
 * 与插件内运行时读的是同一份配置与同一套解析规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flattenPetList, readAllConfig } from '../host/config';
import {
  dshHomeDir,
  electronLandingDir,
  hasGraphicalDisplay,
  packageRoot,
  resolveElectronPath,
} from '../host/helper-process';
import type { StandaloneLogger } from './context';
import { configPathsFor, describePets, isDesktopVisible } from './options';

/** 包版本（读不到就 unknown）—— 体检报告与启动横幅共用 */
export function packageVersion(root: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 打印体检报告。
 * @param logger 输出目标
 * @returns 进程退出码：0 = 就绪；1 = 缺包内默认配置或配置读不出来
 */
export function runCheck(logger: StandaloneLogger): number {
  const home = dshHomeDir();
  const paths = configPathsFor(packageRoot, home);
  const electron = resolveElectronPath();
  const lines: string[] = [
    `Node            ${process.version}（${process.platform}-${process.arch}）`,
    `插件            dsh-pet@${packageVersion(packageRoot)}  ${packageRoot}`,
    `DSH_HOME        ${home}`,
    `用户配置        ${paths.userFile}${existsSync(paths.userFile) ? '' : '（不存在 → 用包内默认）'}`,
    `文件宠物目录    ${paths.petDir}${existsSync(paths.petDir) ? '' : '（不存在）'}`,
    `内置默认配置    ${paths.defaultFile}${existsSync(paths.defaultFile) ? '' : '  ✗ 缺失'}`,
    `Electron        ${electron ?? `未发现（首次运行会下载到 ${electronLandingDir()}）`}`,
    `图形显示环境    ${hasGraphicalDisplay() ? '有' : '无（桌面小窗会跳过；远程桌面/Xvfb 可设 DSH_PET_DESKTOP_FORCE=1）'}`,
  ];

  const fail = (message: string): number => {
    for (const line of lines) logger.info(line);
    logger.error(message);
    return 1;
  };

  if (!existsSync(paths.defaultFile)) {
    return fail(
      '包内默认配置读不到：很可能是在**直接跑源码**（包根被解析成了 src/）。' +
        '独立模式请用构建产物：npm run bundle 后 node lib/standalone.js，或 npm run standalone。',
    );
  }

  try {
    const merged = readAllConfig(paths);
    const entries = Object.keys(merged);
    lines.push(`配置条目        ${entries.length} 个：${entries.join(', ') || '（空）'}`);
    for (const entry of entries) {
      const conf = merged[entry] ?? {};
      const pets = Array.isArray(conf.pets) ? (conf.pets as Record<string, unknown>[]) : [];
      const animations = conf.animations as { idle?: unknown[] } | undefined;
      const idle = Array.isArray(animations?.idle) ? animations.idle.length : 0;
      lines.push(`  条目 ${entry}：宠物 ${pets.length} 只  ${describePets(pets)}｜idle 动画 ${idle} 个`);
    }
    const desktopVisible = flattenPetList(merged).filter(isDesktopVisible);
    lines.push(
      `桌面小窗        ${desktopVisible.length} 只${
        desktopVisible.length === 0 ? '（display 需要 desktop 或 both，否则独立模式没有可显示的宠物）' : ''
      }`,
    );
    for (const line of lines) logger.info(line);
    logger.info('结论：配置与 Electron 就绪，可以直接启动（npm run standalone）。');
    return 0;
  } catch (error) {
    return fail(`读配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
