/**
 * 设置页标签图标：直接读插件自己的 `assets/logo.png`，不在别处复制第二份图。
 *
 * 两个本机服务（独立模式监听器与应用模式路由）共用本模块；读取结果按进程缓存，
 * 文件缺失时回 undefined，由调用方回 404——不在缺图时静默给一张占位图。
 * @module dsh-pet/src/standalone/icon
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../host/paths.ts';

let cached: Buffer | undefined;

/**
 * 读取标签图标字节。
 *
 * @returns PNG 字节；文件不存在或不可读时为 undefined。
 */
export function readSettingsIcon(): Buffer | undefined {
  if (cached) return cached;
  try {
    cached = readFileSync(join(PACKAGE_ROOT, 'assets', 'logo.png'));
    return cached;
  } catch {
    return undefined;
  }
}
