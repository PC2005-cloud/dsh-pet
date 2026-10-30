/**
 * 桌面应用出站请求的访问凭证注入。
 *
 * 只负责给「本机渲染端发起、目标为插件路由」的请求附加令牌；不生成、不校验令牌（校验在宿主路由侧）。
 * 依赖 Electron 的 session 请求拦截与 file:// 渲染页。始终成立：令牌只进请求头，且只对顶层渲染端
 * 指向本机 origin 的插件路由生效，重定向目标不携带。
 * @module dsh-pet/src/app/desktop-auth
 */

import { pathToFileURL } from 'node:url';
import { ROUTE_SEGMENT } from '../shared/constants.ts';

/** 一次出站请求的最小形态：只声明注入凭证需要读的字段。 */
interface RequestDetails {
  url: string;
  requestHeaders: Record<string, string>;
  frame?: { url: string; parent: unknown } | null;
}

/** 主进程默认 session 的最小形态（只用到请求头拦截）。 */
export interface DesktopSession {
  webRequest: {
    onBeforeSendHeaders(
      listener: (
        details: RequestDetails,
        callback: (response: { requestHeaders: Record<string, string> }) => void,
      ) => void,
    ): void;
  };
}

/**
 * 为本机顶层 file 渲染端访问插件路由的请求附加访问令牌。
 *
 * 目标 origin、插件路由段、顶层 frame 与渲染页地址必须同时匹配，任一不满足都不加令牌；
 * 先删同名请求头再按需写入，避免调用方自带的伪令牌被带到别的目标。
 *
 * @param session - 主进程默认 session（出站请求拦截）。
 * @param origin - 本机服务 origin。
 * @param rendererPath - 桌面 Helper 渲染页绝对路径。
 * @param token - 访问令牌。
 */
export function installDesktopAuth(session: DesktopSession, origin: string, rendererPath: string, token: string): void {
  const renderer = pathToFileURL(rendererPath).href;
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    // 重定向后的请求不得把凭证带去别的目标。
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'x-dsh-pet-token') delete headers[name];
    }
    try {
      const target = new URL(details.url);
      const frame = details.frame;
      const page = frame ? new URL(frame.url) : undefined;
      if (
        target.origin === origin &&
        target.pathname.startsWith(ROUTE_SEGMENT + '/') &&
        frame?.parent === null &&
        page?.protocol === 'file:' &&
        page.origin === 'null' &&
        page.href.split(/[?#]/, 1)[0] === renderer
      ) {
        headers['X-DSH-Pet-Token'] = token;
      }
    } catch {
      // frame 缺失/已销毁或地址非法时，一律不授予凭证。
    }
    callback({ requestHeaders: headers });
  });
}
