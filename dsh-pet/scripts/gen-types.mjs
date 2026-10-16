#!/usr/bin/env node
/**
 * gen-types.mjs —— 用 tsc 声明导出生成 lib/types 下的类型声明（发布门禁 prepack 需要）。
 *
 * tsdown 的 dts 管线与双入口（client/host）不兼容（开启即构建失败），因此声明
 * 由 tsc 单独产出。布局与 package.json exports 的 types 路径一致：
 *   lib/types/index.d.ts          （宿主半侧，host 文件整体上移到根）
 *   lib/types/client/index.d.ts   （浏览器半侧）
 *
 * 用法：node scripts/gen-types.mjs（npm run types）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = join(ROOT, 'lib', 'types');
const HOST_OUT = join(TYPES, 'host');

rmSync(TYPES, { recursive: true, force: true });
mkdirSync(TYPES, { recursive: true });

// 直接调用本仓库的 tsc，不经过 npm/npx：
// 旧写法是 `cmd /c npx tsc -p tsconfig.types.json`，它要求环境里存在 npm/npx
// （纯 node / 只有 pnpm 的环境会失败），还额外背着一个 Windows 专用的 cmd /c 分支。
// tsc 本来就在本地 node_modules 里，用当前 node 跑它即可 —— 跨平台一致、零外部命令依赖。
// 解析走 createRequire：pnpm 的隔离布局下 typescript 只在 node_modules 里链了一次，
// 用 require.resolve 比手拼路径更可靠。
const require = createRequire(import.meta.url);
const tscEntry = require.resolve('typescript/lib/tsc.js');
const tsc = spawnSync(process.execPath, [tscEntry, '-p', 'tsconfig.types.json'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (tsc.status !== 0) {
  console.error(`[gen-types] 类型声明生成失败 (exit ${tsc.status})`);
  process.exit(tsc.status ?? 1);
}

// 宿主半侧声明上移到 lib/types/ 根（lib/types/index.d.ts），client 子树保持不变。
if (existsSync(HOST_OUT)) {
  for (const name of readdirSync(HOST_OUT)) {
    renameSync(join(HOST_OUT, name), join(TYPES, name));
  }
  rmSync(HOST_OUT, { recursive: true, force: true });
}

console.log('[gen-types] ✓ lib/types 声明生成完成');
