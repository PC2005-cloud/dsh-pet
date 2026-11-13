/** 桌面 Helper 的站点入口：兼容旧版连接服务与新版宿主入口事件。 */
import type { HostContext } from '../context.ts';

/** 取得宿主提供的完整入口；其中的登录凭据仅传入 Helper 内存，禁止写入日志。 */
export function resolveDesktopSiteUrl(ctx: HostContext, origin: string): string {
  if (typeof ctx.connection.authenticatedUrl === 'function') {
    return ctx.connection.authenticatedUrl(origin);
  }
  const entries: { url: string; open: boolean }[] = [];
  ctx.emit(ctx.webServer, 'webserver/entry-url', origin, entries);
  return entries.find((entry) => entry.open)?.url ?? origin;
}
