/**
 * 数 cookie 库里到底攒了多少条 `dsh-auth-*`。
 *
 * 为什么不能数请求头：桌面版里 renderer 的请求由外壳经 IPC 转发，只带当前这次启动的那一条，
 * 库里攒了几十条时 `Cookie` 头里也只看得见一条，看不住真实体积。所以只能去读库本身，
 * 而它在 DSH 运行期间被独占打开——借句柄那套在 ./win32。读不到就回 `ok:false`，不猜数。
 * @module dsh-pet/src/host/cookie/probe
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJarBytes } from './win32.ts';

/** 登录 cookie 的名字：`dsh-auth-` 加 43 位 base64url 摘要。 */
const COOKIE_NAME_PATTERN = /dsh-auth-[A-Za-z0-9_-]{43}/g;

/** 一次探测的结论；失败只给原因，条数不进失败分支（避免调用方误读成 0 条）。 */
export type CookieProbeResult =
  | {
      readonly ok: true;
      /** 库里不同 cookie 名的个数（同一个名字出现多次只算一条）。 */
      readonly count: number;
      /** 字节是直接读文件还是借外壳句柄读到的。 */
      readonly source: 'file' | 'borrowed-handle';
      readonly fileSize: number;
      /** 这次探测耗时；借句柄要扫全机句柄表，通常在 200ms 量级。 */
      readonly elapsedMs: number;
    }
  | { readonly ok: false; readonly reason: string; readonly fileSize?: number };

/**
 * 桌面版的 cookie 库位置。
 * @returns 绝对路径；`DSH_PET_COOKIE_DB` 可覆盖（换安装形态或排查时用）。
 */
export function cookieDatabasePath(): string {
  const override = process.env.DSH_PET_COOKIE_DB;
  if (typeof override === 'string' && override.trim() !== '') return override;
  const appData = process.env.APPDATA;
  if (typeof appData !== 'string' || appData === '') {
    return join(homedir(), 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
  }
  return join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
}

/**
 * 从库的原始字节里数出不同的 cookie 名。
 *
 * 按名字去重而不是按出现次数：同一条 cookie 在库里有多个版本，算成多条会虚报占用。
 * @param raw - 库文件的原始字节。
 * @returns 不同 cookie 名的个数。
 */
export function countCookieNames(raw: Buffer): number {
  const text = raw.toString('latin1');
  const names = new Set<string>();
  for (const match of text.matchAll(COOKIE_NAME_PATTERN)) names.add(match[0]);
  return names.size;
}

/**
 * 探测一次 cookie 库。
 *
 * @returns 条数与来源，或不可读的原因（含文件大小，便于判断是路径错了还是句柄没借到）。
 */
export function probeJar(): CookieProbeResult {
  const startedAt = Date.now();
  const file = cookieDatabasePath();

  let fileSize: number;
  try {
    fileSize = statSync(file).size;
  } catch {
    return { ok: false, reason: `找不到 cookie 库：${file}` };
  }

  const read = readJarBytes(file);
  if (!read.ok) return { ok: false, reason: read.reason, fileSize };

  return {
    ok: true,
    count: countCookieNames(read.raw),
    source: read.source,
    fileSize,
    elapsedMs: Date.now() - startedAt,
  };
}
