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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = join(ROOT, 'lib', 'types');
const HOST_OUT = join(TYPES, 'host');

rmSync(TYPES, { recursive: true, force: true });
mkdirSync(TYPES, { recursive: true });

// Windows 下 npm/npx 是 .cmd，spawnSync 无法直接执行；用 cmd /c 跑整条命令。
// 非 Windows（linux/darwin）直接跑即可——之前这里无条件用 cmd /c，
// 导致类 unix 平台上 spawnSync 拿到 shell 的 127（cmd: command not found），
// 而 TYPES 目录在本文件开头已被清空，结果是「声明被删掉却没重新生成」。
// 写法与 scripts/prepare.js 保持一致。
const tscRun =
  process.platform === 'win32' ? 'cmd /c npx tsc -p tsconfig.types.json' : 'npx tsc -p tsconfig.types.json';
const tsc = spawnSync(tscRun, { cwd: ROOT, stdio: 'inherit', shell: true });
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
