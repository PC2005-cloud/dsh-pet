#!/usr/bin/env node
/**
 * ensure-electron.mjs
 *
 * 自动下载 Electron 到 $DSH_HOME/electron（默认 ~/.dsh/electron），
 * 供 dsh-pet 桌面 Helper（透明置顶窗口）使用。
 *
 * 下载走官方 @electron/get（URL 拼装 / 镜像 / SHA256 校验 / 缓存复用），
 * 解压走 electron 43 官方同款 @electron-internal/extract-zip（纯 Node + native，
 * 跨平台一致，正确处理 symlink 与权限，不需要系统 unzip/tar）。
 *
 * 用法：
 *   node scripts/ensure-electron.mjs
 *
 * 环境变量：
 *   DSH_HOME                     DSH 主目录（默认 ~/.dsh）
 *   DSH_PET_ELECTRON_VERSION     Electron 版本（默认 43.3.0）
 *   DSH_PET_ELECTRON_MIRROR      镜像地址（默认 npmmirror，国内可达）
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloadArtifact } from '@electron/get';
import extract from '@electron-internal/extract-zip';

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const VERSION = process.env.DSH_PET_ELECTRON_VERSION || '43.3.0';
const MIRROR = process.env.DSH_PET_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const TARGET_DIR = resolve(HOME, 'electron');

// ---------- 平台适配（win32 / darwin / linux）----------
const PLAT = process.platform;
const ELECTRON_REL =
  PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';
const EXE = join(TARGET_DIR, ELECTRON_REL);

async function main() {
  if (existsSync(EXE)) {
    console.log(EXE);
    return;
  }

  console.log(`[ensure-electron] Electron not found, downloading v${VERSION} (${PLAT}-${process.arch}) ...`);
  mkdirSync(TARGET_DIR, { recursive: true });

  const zipPath = await downloadArtifact({
    version: `v${VERSION}`,
    artifactName: 'electron',
    // platform/arch 不传：@electron/get 用宿主平台与架构自动推断
    mirrorOptions: { mirror: MIRROR.replace(/\/$/, '') + '/' },
    downloadOptions: { quiet: true },
  });
  await extract(zipPath, { dir: TARGET_DIR });
  if (!existsSync(EXE)) {
    throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
  }
  console.log(EXE);
}

main().catch((error) => {
  console.error(`[ensure-electron] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
