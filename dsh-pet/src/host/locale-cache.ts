/**
 * 宿主语言 id 的进程外缓存：浏览器 POST /locale 时落盘，宿主下次启动在 web 客户端上报前也能读到上次的 id。
 * 不是宠物配置字段，只镜像 sections.locale 的 data.id。
 * @module dsh-pet/src/host/locale-cache
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PollStateStore } from './state.ts';

/** 与 POST /locale 校验一致。 */
const LOCALE_ID = /^[\w.-]{1,32}$/;

/** 用户数据根下的缓存文件名。 */
export function hostLocaleCachePath(userRoot: string): string {
  return join(userRoot, 'host-locale.json');
}

/** 读缓存里的 id；文件缺失或非法时返回空串。 */
export function readCachedHostLocale(userRoot: string): string {
  const path = hostLocaleCachePath(userRoot);
  if (!existsSync(path)) return '';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown };
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    return LOCALE_ID.test(id) ? id : '';
  } catch {
    return '';
  }
}

/**
 * 把 id 写入缓存；非法 id 不写。
 *
 * @param userRoot - 插件用户数据根。
 * @param id - 宿主语言 id。
 */
export function writeCachedHostLocale(userRoot: string, id: string): void {
  const trimmed = id.trim();
  if (!LOCALE_ID.test(trimmed)) return;
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(hostLocaleCachePath(userRoot), JSON.stringify({ id: trimmed }), 'utf8');
}

/**
 * 启动时把缓存灌进 sections.locale（有合法 id 才写）。
 *
 * @param state - 轮询 store。
 * @param userRoot - 插件用户数据根。
 */
export function hydrateHostLocale(state: PollStateStore, userRoot: string): void {
  const id = readCachedHostLocale(userRoot);
  if (id === '') return;
  state.writeSection('locale', { id });
}
