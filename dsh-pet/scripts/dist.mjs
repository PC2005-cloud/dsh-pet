#!/usr/bin/env node
/**
 * dist.mjs —— 产出 Windows NSIS 安装包（ticket 02）。
 *
 * 前置：`npm run build`（lib/ + shared-core + 类型声明），见 package.json 的 dist 脚本。
 * 本脚本只做两件事：
 *   1. 优先把 electron-builder 的 electronDist 指到**本机已解压的 Electron**
 *      （$DSH_HOME/electron，与 ensure-electron.mjs / helper-process.ts 同一落地路径），
 *      这样打包不需要联网下载 Electron；目录不存在才回退为 electron-builder 默认下载，
 *      并把镜像指向 npmmirror（国内网络下 GitHub 直连常不可用）。
 *   2. 调用 electron-builder（配置在 electron-builder.yml：NSIS、每用户安装、files 白名单）。
 *
 * 产物：dist/dsh-pet-Setup-<version>.exe（dist/ 已被仓库根 .gitignore 忽略）。
 *
 * 用法：npm run dist
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG = join(ROOT, 'electron-builder.yml');

/** $DSH_HOME（默认 ~/.dsh），与 src/host/helper-process.ts 的 dshHomeDir 口径一致 */
function dshHomeDir() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

/** 本机 Electron 落地目录里的可执行文件（按平台）；不存在返回空串 */
function localElectronExe() {
  const rel =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
        : 'electron';
  const exe = join(dshHomeDir(), 'electron', rel);
  return existsSync(exe) ? exe : '';
}

/** electron-builder 的 CLI 入口（本地 devDependency，不经 npx，避免临时下载） */
function electronBuilderCli() {
  try {
    return require.resolve('electron-builder/out/cli/cli.js');
  } catch {
    console.error('[dist] 找不到 electron-builder：先在 dsh-pet/ 下执行 pnpm install');
    process.exit(1);
  }
}

const electronExe = localElectronExe();
const args = [electronBuilderCli(), '--win', 'nsis', '--config', CONFIG, '--publish', 'never'];

if (electronExe) {
  // electronDist 指向解压目录（electron.exe 所在目录），electron-builder 直接复制并改名。
  const electronDist = resolve(electronExe, '..');
  args.push(`--config.electronDist=${electronDist}`);
  console.log(`[dist] 使用本机 Electron：${electronDist}`);
} else {
  console.warn(
    `[dist] 未找到本机 Electron（${join(dshHomeDir(), 'electron')}），回退为 electron-builder 下载；` +
      '镜像已指向 npmmirror。',
  );
  // 只在调用方没显式覆盖时设置，避免盖掉用户自己的镜像配置。
  process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';
}

console.log('[dist] electron-builder...');
const result = spawnSync(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});
if (result.status !== 0) {
  console.error(`[dist] electron-builder 失败（exit ${String(result.status ?? result.signal)}）`);
  process.exit(result.status ?? 1);
}

// 打印产物路径与体积（验收要报告实际数值）
const distDir = join(ROOT, 'dist');
const artifacts = existsSync(distDir)
  ? readdirSync(distDir).filter((name) => /^dsh-pet-Setup-.*\.exe$/i.test(name))
  : [];
if (artifacts.length === 0) {
  console.error(`[dist] 构建结束但 ${distDir} 下没有 dsh-pet-Setup-*.exe`);
  process.exit(1);
}
for (const name of artifacts) {
  const file = join(distDir, name);
  const sizeMb = (statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`[dist] 产物：${file}（${sizeMb} MB）`);
}
