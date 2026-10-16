#!/usr/bin/env node
/**
 * build-desktop-core.mjs —— 把 src/shared（浏览器与桌面共用的纯逻辑）构建成
 * runtime/electron-helper/shared-core.js（经典 script，全局 window.PetShared）。
 *
 * 为什么是经典 script 而非 ESM：Electron 的 loadFile 从 file:// 加载页面，
 * Chromium 对 file:// 的 ES module 有 CORS 限制（origin null 被阻），
 * 经典 script 无此问题——shared-core.js 先于 renderer.js 加载，renderer 读全局。
 *
 * 用法：node scripts/build-desktop-core.mjs（npm run build:desktop-core）
 * 由 prepare.js（发布链）与本地开发 bundle 后调用。
 */
import { rolldown } from 'rolldown';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

try {
  const bundle = await rolldown({
    input: join(ROOT, 'src', 'shared', 'index.ts'),
    platform: 'browser',
  });
  await bundle.write({
    format: 'iife',
    name: 'PetShared',
    file: join(ROOT, 'runtime', 'electron-helper', 'shared-core.js'),
  });
  console.log('[build-desktop-core] ✓ runtime/electron-helper/shared-core.js (window.PetShared)');
} catch (error) {
  console.error('[build-desktop-core] build failed:', error);
  process.exit(1);
}
