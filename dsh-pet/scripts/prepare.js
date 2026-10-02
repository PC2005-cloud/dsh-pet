#!/usr/bin/env node
/**
 * prepare.js —— 发布前微调（构建完整产物 + 收敛 files）
 *
 * 插件只发布**单一 webm 格式**（VP9-alpha）：浏览器 overlay 的
 * Chrome/Edge/Firefox 与桌面模式（Electron = Chromium）共用同一格式
 * （源码写死 .webm，无发布期注入）。Safari/HEVC(mov) 兼容由仓库保留的
 * 流水线（scripts/encode_hevc_alpha.sh + hevc_alpha_encoder.swift +
 * .github/workflows/hevc-alpha.yml）支持——需要兼容 Safari 者 fork
 * 仓库后自行启用，不参与本插件的发布流程。
 *
 * 做什么：
 *   1. 构建（npm run bundle：tsdown 把 src/ → lib/）
 *   1.5 构建桌面共享核心（npm run build:desktop-core：src/shared → window.PetShared）
 *   1.6 生成类型声明（npm run types：tsc → lib/types/*.d.ts）
 *   2. 改写 package.json：files 收敛为发布清单（含桌面模式运行时 runtime/electron-helper、
 *      表情包 assets/memes）—— 幂等：跑一次即定格为当前状态，再跑结果不变，无需备份/恢复
 *
 * 用法：node scripts/prepare.js（npm run prepare；npm install / npm publish 自动执行）
 * 发布：npm publish --tag latest
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PKG = join(ROOT, 'package.json');

// 1. 构建 src → lib
// Windows 下 npm 是 npm.cmd，spawnSync 无法直接执行 .cmd；用 cmd /c 跑整条命令
// （固定命令行，无用户输入，无注入风险）
console.log('[prepare] building (tsdown)...');
const npmRun = process.platform === 'win32' ? 'cmd /c npm run bundle' : 'npm run bundle';
const build = spawnSync(npmRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (build.status !== 0) {
  console.error(`[prepare] 构建失败 (exit ${build.status})`);
  process.exit(1);
}

// 1.5 构建桌面共享核心（src/shared → window.PetShared 经典 script；与浏览器 bundle 同一份源码）
console.log('[prepare] building desktop shared-core...');
const coreRun = process.platform === 'win32' ? 'cmd /c npm run build:desktop-core' : 'npm run build:desktop-core';
const buildCore = spawnSync(coreRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (buildCore.status !== 0) {
  console.error(`[prepare] 桌面 shared-core 构建失败 (exit ${buildCore.status})`);
  process.exit(1);
}

// 1.6 生成类型声明（lib/types/*.d.ts，tsc 产出；构建产物不入 git，克隆后由本步骤补齐）
console.log('[prepare] generating types (npm run types)...');
const typesRun = process.platform === 'win32' ? 'cmd /c npm run types' : 'npm run types';
const buildTypes = spawnSync(typesRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (buildTypes.status !== 0) {
  console.error(`[prepare] 类型声明生成失败 (exit ${buildTypes.status})`);
  process.exit(1);
}

// 2. 改写 package.json：files 收敛为发布清单（幂等，无备份）
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const keep = [
  'lib',
  'src',
  'assets/webm',
  'runtime/electron-helper',
  'assets/fonts',
  'assets/pic',
  // 表情包（碎碎念/对话配图的图片）：host 只从**包内** assets/memes 读图、与配置 memes 键配对，
  // 漏掉它 → 包内一张图都没有、配图功能整体失效。注意本函数每次发布（npm install/publish）都会
  // 用这个数组**覆盖** package.json 的 files，所以"只在 package.json 里加一行"是无效的，必须加在这里
  'assets/memes',
  'assets/config.jsonc',
  // 插件图标（DSH 插件管理页显示）：package.json 顶层 icon 字段指向这张图。
  // 与 memes 同理——本数组会覆盖 package.json 的 files，漏掉它则 npm 包里没有这张图，
  // 读取方 dsh-app-boot 的 iconOf 找不到文件会抛错，图标退回默认插画
  'assets/logo.png',
  'scripts/ensure-electron.mjs',
  'cordis.patch.yml',
];
writeFileSync(PKG, JSON.stringify({ ...pkg, files: keep }, null, 2) + '\n', 'utf8');
console.log(`[prepare] ✓ package.json files=[${keep.join(', ')}]`);
console.log('[prepare] ready to publish: npm publish --tag latest');
