#!/usr/bin/env node
/**
 * 打包独立桌面应用（Windows exe）—— `npm run desktop`。
 *
 * 产物（desktop/dist/）：
 *   - dsh-pet-desktop-Setup-<version>.exe   NSIS 安装包（oneClick，装完即启动）
 *   - dsh-pet-desktop-<version>.exe         便携版（单文件，双击即用）
 *
 * 流程（全部可重复执行，中途失败可直接重跑）：
 *   1. 带 DSH_PET_DESKTOP_BUILD=1 跑 tsdown bundle（多产出 lib/desktop.js，第 4 份配置）；
 *   2. 重建 desktop/app/：应用 package.json + bootstrap.js（helper/host 角色分流）+
 *      lib/ + runtime/electron-helper/ + assets（webm/fonts/pic/memes/config/logo）；
 *   3. 写 desktop/electron-builder.json：Electron 优先复用 ~/.dsh/electron（electronDist），
 *      没有则走 ELECTRON_MIRROR 下载；版本从本机 electron.exe --version 实测；
 *   4. electron-builder --win 出 NSIS + portable 两个 exe。
 *
 * 角色设计见 bootstrap.js 头注释：一个 exe，宿主实例（双击 → 独立模式 + 托盘）
 * 与 Helper 实例（宿主 spawn → 透明小窗）共用同一份二进制。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(packageRoot, 'desktop');
const appDir = join(desktopDir, 'app');

/** Electron 运行时落地目录（与 helper-process.ts 的 electronLandingDir 同口径） */
function electronLandingDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'electron');
}

/** 读本地包的 bin 入口（不进 shell，避免 PATH/pnpm 差异） */
function pkgBin(name) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'node_modules', name, 'package.json'), 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name];
  if (!bin) throw new Error(`node_modules/${name} 没有 bin 入口`);
  return join(packageRoot, 'node_modules', name, bin);
}

/** 跑一个本地 node 脚本/工具，失败即终止（输出直通终端，方便排障） */
function runNode(scriptPath, args, env = {}, label = '') {
  console.log(`\n===== ${label} =====`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`✗ ${label} 失败（exit ${String(result.status)}）`);
    process.exit(result.status ?? 1);
  }
}

/** 实测本机 Electron 版本（electron.exe --version → v43.3.0），读不到返回 undefined */
function detectElectronVersion(exe) {
  const result = spawnSync(exe, ['--version'], { timeout: 15_000, encoding: 'utf8', windowsHide: true });
  const match = /v?(\d+\.\d+\.\d+)/.exec(result.stdout ?? '');
  return match?.[1];
}

// ---------- 0. 前置体检：依赖缺了早说，别让用户在打包中段对着一屏报错猜 ----------

const missing: string[] = [];
if (!existsSync(join(packageRoot, 'node_modules', 'tsdown'))) missing.push('tsdown（pnpm install）');
if (!existsSync(join(packageRoot, 'node_modules', 'electron-builder'))) {
  missing.push('electron-builder（pnpm add -D electron-builder）');
}
if (missing.length > 0) {
  console.error(`dsh-pet-desktop: 缺少依赖 → ${missing.join('；')}`);
  process.exit(1);
}

const rootManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };

// ---------- 1. 构建四入口 bundle（第 4 份配置由该 env 打开）----------

runNode(pkgBin('tsdown'), [], { DSH_PET_DESKTOP_BUILD: '1' }, '1/4 tsdown bundle（含 desktop 入口）');
if (!existsSync(join(packageRoot, 'lib', 'desktop.js'))) {
  console.error('✗ lib/desktop.js 未产出：tsdown 第 4 份配置没有生效（检查 DSH_PET_DESKTOP_BUILD）');
  process.exit(1);
}

// 桌面 Helper 运行时的共享纯逻辑（window.PetShared），与 lib 同级必需
runNode(join(packageRoot, 'scripts', 'build-desktop-core.mjs'), [], {}, '2/4 桌面共享逻辑 shared-core.js');

// ---------- 2. 组装 desktop/app/（electron-builder 的 app 源目录，asar:false 原样进 resources/app）----------

console.log('\n===== 3/4 组装 desktop/app =====');
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

writeFileSync(
  join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-pet-desktop',
      version: rootManifest.version,
      type: 'module',
      main: 'bootstrap.js',
      description: 'dsh-pet 独立桌面应用 —— 不打开 DSH 也能养的桌宠',
      author: 'PC2005-cloud',
      license: 'MIT',
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(appDir, 'bootstrap.js'),
  `/**
 * dsh-pet 桌面应用主进程入口（electron-builder 打包产物，由 scripts/build-desktop-app.mjs 生成）。
 *
 * 一个 exe 两种角色：
 *   - 宿主实例（用户双击）：没有 helper env → import lib/desktop.js，起独立模式 + 托盘；
 *   - Helper 实例（宿主经 HelperProcess spawn，env 带 DSH_PET_CONFIG_URL）：
 *     直接 require runtime/electron-helper/main.js（与 DSH 内运行完全同份的桌面脚本）。
 *     注：HelperProcess 传的脚本路径参数会被打包版 Electron 忽略（exe 固定加载本文件），
 *     角色判定只看环境变量。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

if (process.env.DSH_PET_CONFIG_URL) {
  require(join(here, 'runtime', 'electron-helper', 'main.js'));
} else {
  await import('./lib/desktop.js');
}
`,
);

// lib（四个入口 bundle）与桌面 Helper 脚本：随包分发、无 node_modules 依赖（外部引用已在打包配置里换掉）
cpSync(join(packageRoot, 'lib'), join(appDir, 'lib'), { recursive: true });
cpSync(join(packageRoot, 'runtime', 'electron-helper'), join(appDir, 'runtime', 'electron-helper'), {
  recursive: true,
});
// 素材：与 npm 包 files 白名单同口径（webm 播放资源 + 字体 + 图片 + 表情 + 内置默认配置 + 图标）
const assetsDir = join(packageRoot, 'assets');
const appAssets = join(appDir, 'assets');
mkdirSync(appAssets, { recursive: true });
for (const dir of ['webm', 'fonts', 'pic', 'memes']) {
  cpSync(join(assetsDir, dir), join(appAssets, dir), { recursive: true });
}
for (const file of ['config.jsonc', 'logo.png']) {
  cpSync(join(assetsDir, file), join(appAssets, file));
}

// ---------- 3. 写 electron-builder 配置并出 exe ----------

const electronLanding = electronLandingDir();
const electronExe = join(electronLanding, process.platform === 'win32' ? 'electron.exe' : 'electron');
const hasLocalElectron = existsSync(electronExe);
// electronVersion 必须与 electronDist 里的实际版本一致（以实测为准；读不到时回落到 ensure-electron 的默认值）
const electronVersion = hasLocalElectron ? detectElectronVersion(electronExe) ?? '43.3.0' : '43.3.0';

/** 注意：artifactName 里的 ${version} 是 electron-builder 的模板语法，必须原样落进 JSON */
const builderConfig = {
  appId: 'cloud.pc2005.dshpet.desktop',
  productName: 'yellow hair',
  electronVersion,
  directories: { app: 'desktop/app', output: 'desktop/dist', buildResources: 'desktop/build' },
  asar: false,
  files: ['**/*'],
  win: { target: ['nsis', 'portable'] },
  nsis: { oneClick: true, unicode: true, artifactName: 'yellow-hair-Setup-${version}.exe' },
  portable: { artifactName: 'yellow-hair-${version}.exe', requestExecutionLevel: 'user' },
};
if (hasLocalElectron) builderConfig.electronDist = electronLanding;

mkdirSync(join(desktopDir, 'build'), { recursive: true });
cpSync(join(packageRoot, 'assets', 'logo.png'), join(desktopDir, 'build', 'icon.png')); // ≥256×256，builder 自动转 ico
writeFileSync(join(desktopDir, 'electron-builder.json'), `${JSON.stringify(builderConfig, null, 2)}\n`);

console.log(`\n===== 4/4 electron-builder（Electron ${electronVersion}${hasLocalElectron ? '，复用 ~/.dsh/electron' : '，经镜像下载'}）=====`);
const result = spawnSync(
  process.execPath,
  [pkgBin('electron-builder'), '--win', '--config', join('desktop', 'electron-builder.json')],
  {
    cwd: packageRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  },
);
if (result.status !== 0) {
  console.error(`✗ electron-builder 失败（exit ${String(result.status)}）`);
  process.exit(result.status ?? 1);
}

// ---------- 4. 报告产物 ----------

const distDir = join(desktopDir, 'dist');
const artifacts = existsSync(distDir)
  ? readdirSync(distDir).filter((name) => name.endsWith('.exe')).map((name) => join(distDir, name))
  : [];
console.log('\n===== 打包完成 =====');
for (const artifact of artifacts) console.log(`  ${artifact}`);
if (artifacts.length === 0) {
  console.error('✗ desktop/dist 下没有 exe 产物，请检查上方 electron-builder 日志');
  process.exit(1);
}
console.log('\n用法：安装包双击安装；便携版双击直接运行（同一时刻只允许一个宿主实例）。');