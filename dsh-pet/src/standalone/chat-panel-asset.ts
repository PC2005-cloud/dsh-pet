/**
 * 设置页对话面板的浏览器产物：运行时读同包内的 `lib/chat-panel.js`。
 *
 * 与 icon.ts 同口径：按进程缓存、读不到回 undefined，由调用方回 404——
 * 缺产物时宁可显式报错，也不静默回一个空脚本让页面只剩空白。
 * @module dsh-pet/src/standalone/chat-panel-asset
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../host/paths.ts';

let cached: string | undefined;

/**
 * 读取对话面板脚本。
 *
 * @returns 打包后的脚本源码；未构建或文件不可读时为 undefined。
 */
export function readChatPanelScript(): string | undefined {
  if (cached !== undefined) return cached;
  try {
    cached = readFileSync(join(PACKAGE_ROOT, 'lib', 'chat-panel.js'), 'utf8');
    return cached;
  } catch {
    return undefined;
  }
}
