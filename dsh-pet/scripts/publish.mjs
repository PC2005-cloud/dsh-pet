#!/usr/bin/env node
/**
 * 发布到 npm 官方源，是 `npm publish` 的薄封装。
 *
 * 为什么需要它：本机全局 registry 指向 npmmirror 镜像（只读，不能发布），而登录 token 只绑在
 * registry.npmjs.org 上——直接 `npm publish` 会发错源，裸跑 `npm whoami` 又会误报未登录。
 * 所以发布前必须把 registry 显式钉死，并先核对登录与版本占用，省掉一次白跑的 prepack。
 * 工作区有未提交改动时拒绝发布：prepack 打包的是当前工作区，脏树会发出一份没进版本库的代码。
 *
 * 用法：
 *   node scripts/publish.mjs                 正式发布
 *   node scripts/publish.mjs --dry-run       预演（照常跑 prepack，但不真正上传）
 *   node scripts/publish.mjs --allow-dirty   跳过工作区检查
 *
 * @module dsh-pet/scripts/publish
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 发布源：全局 registry 是只读镜像，必须显式指定，否则发不出去。 */
const REGISTRY = 'https://registry.npmjs.org/';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// 直接交给 node 跑 npm 的 CLI 文件，不经 shell：安装路径含单引号时会传参切碎（dist.mjs 同因）。
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

/**
 * 预检失败统一出口。
 *
 * @param {string} message - 失败原因，会带上 `[publish]` 前缀方便过滤日志。
 * @returns {never} 永返回：内部直接结束进程。
 */
function fail(message) {
  console.error('[publish] ' + message);
  process.exit(1);
}

/**
 * 跑一次 npm 子命令并取回 stdout。
 *
 * @param {string[]} args - 子命令与参数。
 * @returns {string} 去掉首尾空白的 stdout。
 */
function npmCapture(args) {
  return execFileSync(process.execPath, [npmCli, ...args, '--registry', REGISTRY], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');

// 1. 登录：token 绑在 npmjs 源上，不带 --registry 的 whoami 查的是镜像，必然误报未登录
let user;
try {
  user = npmCapture(['whoami']);
} catch {
  fail(`未登录 ${REGISTRY}。执行 npm login --registry ${REGISTRY} 后重试`);
}
if (!user) fail(`未登录 ${REGISTRY}`);

// 2. 版本占用：npm 不允许覆盖已发布版本，先查一次
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
let taken = '';
try {
  taken = npmCapture(['view', `${pkg.name}@${pkg.version}`, 'version']);
} catch {
  taken = ''; // 查不到 = 还没发过，正是我们要的
}
if (taken !== '') {
  fail(`${pkg.name}@${pkg.version} 已发布。先升 package.json 与 openapi.yaml 的版本号`);
}

// 3. 工作区：只看已跟踪文件的改动，未跟踪的本地杂物不该阻塞发布
if (!flags.has('--allow-dirty')) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (dirty !== '') fail('工作区有未提交改动，先提交，或加 --allow-dirty 跳过：\n' + dirty);
}

console.log(`[publish] user:     ${user}`);
console.log(`[publish] package:  ${pkg.name}@${pkg.version}`);
console.log(`[publish] registry: ${REGISTRY}`);
if (dryRun) console.log('[publish] 模式:     --dry-run（不会真正上传）');

// prepack 会先跑 build / typecheck / lint / check:cycles / check:runtime / format:check /
// check:openapi，输出很长，所以 stdio 直接继承给终端。
const args = [npmCli, 'publish', '--registry', REGISTRY, '--tag', 'latest'];
if (dryRun) args.push('--dry-run');
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
