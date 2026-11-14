/**
 * 桌面 Helper 的站点入口：优先旧版连接服务，缺失时向新宿主收集入口事件。
 *
 * 只决定「交给浏览器的入口地址」，不认证、不记日志；完整入口里的令牌只经环境变量
 * 传入 Helper 内存，禁止落盘。两条来源互斥：`connection.authenticatedUrl` 存在即用
 * 旧路径，否则同步 emit `webserver/entry-url`。
 * @module dsh-pet/src/host/plugin/desktop/site-url
 */
import type { HostContext } from '../context.ts';

/** 宿主的入口收集事件名；新版 WebServer 以自身为 subject 同步分发。 */
const ENTRY_URL_EVENT = 'webserver/entry-url';

/**
 * 取得宿主提供的完整入口。
 *
 * @param ctx - 宿主上下文；`connection` 与 `webServer` 都可能缺，取用一律走可选链。
 * @param origin - 服务器基地址（协议 + authority），同时用作收集主题与兜底返回值。
 * @returns 已鉴权的完整入口；没有入口提供者时原样返回 `origin`。
 */
export function resolveDesktopSiteUrl(ctx: HostContext, origin: string): string {
  if (typeof ctx.connection?.authenticatedUrl === 'function') {
    return ctx.connection.authenticatedUrl(origin);
  }
  const entries: { url: string; open: boolean }[] = [];
  ctx.emit(ctx.webServer, ENTRY_URL_EVENT, origin, entries);
  return entries.find((entry) => entry.open)?.url ?? origin;
}
