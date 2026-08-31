#!/usr/bin/env node
/**
 * ensure-electron.mjs
 *
 * 自动下载 Electron 到 $DSH_HOME/electron（默认 ~/.dsh/electron），
 * 供 dsh-pet 桌面 Helper（透明置顶窗口）使用。
 *
 * 用法：
 *   node scripts/ensure-electron.mjs
 *
 * 环境变量：
 *   DSH_HOME                     DSH 主目录（默认 ~/.dsh）
 *   DSH_PET_ELECTRON_VERSION     Electron 版本（默认 43.3.0）
 *   DSH_PET_ELECTRON_MIRROR      镜像地址（默认 npmmirror，国内可达）
 */

import { existsSync, mkdirSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

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
const REQUIRED_FILES =
  PLAT === 'win32'
    ? [
        'electron.exe',
        'icudtl.dat',
        'resources.pak',
        'snapshot_blob.bin',
        'chrome_100_percent.pak',
        'v8_context_snapshot.bin',
      ]
    : PLAT === 'darwin'
      ? [
          ELECTRON_REL,
          join('Electron.app', 'Contents', 'Info.plist'),
          join('Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework'),
        ]
      : ['electron'];

function electronZipName() {
  const plat = PLAT === 'win32' ? 'win32' : PLAT === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `electron-v${VERSION}-${plat}-${arch}.zip`;
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} (${url})`);
  }
  await pipeline(response.body, createWriteStream(dest));
}

/**
 * 解压命令候选（按平台有序，逐个尝试直到成功）。
 *
 * Electron 发布包是 **zip** 而非 tar，`tar -xf` 能否读 zip 取决于 tar 的实现：
 *   - win32 / darwin：系统 tar 实为 bsdtar（libarchive），可透明识别 zip；
 *   - linux：绝大多数是 **GNU tar**，只读 tar 格式，遇 zip 报
 *     `This does not look like a tar archive` 并以 2 退出。
 * 故非 Windows 平台不把 tar 当主力。darwin 同样优先 `unzip`：macOS 的 bsdtar 对 zip 内
 * **符号链接** 的处理与原生 unzip 不一致，而 Electron.app 的
 * Contents/Frameworks/*.framework 结构强依赖 symlink（实测 v43.3.0 darwin 包
 * 585 条目中 14 个为 symlink），symlink 被破坏会导致框架结构损坏、Electron 起不来。
 */
function extractAttempts() {
  if (PLAT === 'win32') {
    return [
      (zipPath, targetDir) => ['tar', ['-xf', zipPath, '-C', targetDir]],
      (zipPath, targetDir) => [
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${targetDir}' -Force`],
      ],
    ];
  }
  return [
    (zipPath, targetDir) => ['unzip', ['-q', '-o', zipPath, '-d', targetDir]],
    (zipPath, targetDir) => ['tar', ['-xf', zipPath, '-C', targetDir]],
  ];
}

function extractZip(zipPath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  let lastError = 'no extractor attempted';
  for (const buildArgs of extractAttempts()) {
    const [command, args] = buildArgs(zipPath, targetDir);
    const result = spawnSync(command, args, { stdio: 'inherit' });
    // 命令不存在时 spawnSync 的 status 为 null（error 为 ENOENT），按失败处理继续下一个候选。
    if (result.status === 0) {
      // 校验关键文件是否完整；不完整说明下载/解压失败，清理后重试下一个候选。
      const missing = REQUIRED_FILES.filter((name) => !existsSync(join(targetDir, name)));
      if (missing.length === 0) return;
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true });
      lastError = `Electron zip incomplete, missing: ${missing.join(', ')}`;
      continue;
    }
    lastError = `${command} exited with ${result.status ?? 'ENOENT'}`;
  }
  rmSync(targetDir, { recursive: true, force: true });
  throw new Error(`failed to extract Electron zip (${lastError})`);
}

async function main() {
  if (existsSync(EXE)) {
    console.log(EXE);
    return;
  }

  console.log(`[ensure-electron] Electron not found, downloading v${VERSION} (${PLAT}-${process.arch}) ...`);
  mkdirSync(TARGET_DIR, { recursive: true });

  const zipName = electronZipName();
  const url = `${MIRROR.replace(/\/$/, '')}/${VERSION}/${zipName}`;
  const zipPath = join(tmpdir(), zipName);

  try {
    console.log(`[ensure-electron] ${url}`);
    await download(url, zipPath);
    extractZip(zipPath, TARGET_DIR);
    if (!existsSync(EXE)) {
      throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
    }
    console.log(EXE);
  } finally {
    try {
      rmSync(zipPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((error) => {
  console.error(`[ensure-electron] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
