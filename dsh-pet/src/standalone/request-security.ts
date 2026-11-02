/**
 * 本机 HTTP 的访问边界：回环 Host 校验、CSRF 校验与进程能力令牌。
 *
 * 负责判定请求能否进入路由，并清掉上游写出的宽 CORS 头；不处理业务语义。
 * 必须始终成立：只接受当前回环地址；令牌只出现在启动清单、请求头与 HttpOnly cookie，
 * 绝不进日志或响应体。设置页首次带令牌访问后换一枚会话 cookie，刷新时地址栏里已没有令牌。
 * @module dsh-pet/src/standalone/request-security
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 请求安全门面。 */
export interface RequestSecurity {
  /** 进程能力令牌，只写入本机启动清单，绝不进 HTTP 响应或日志。 */
  readonly token: string;
  /** 生成带令牌的设置页地址。 */
  authenticatedUrl(baseUrl: string): string;
  /** 判定请求是否放行；拒绝时已经写好响应。 */
  authorize(req: IncomingMessage, res: ServerResponse, allowFileOrigin?: boolean): boolean;
}

/** 回一个结构化错误并返回 false，便于调用方直接 return。 */
export function rejectRequest(res: ServerResponse, status: number, error: string): false {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error }));
  return false;
}

/** 无需令牌的只读路径；写操作与敏感路径必须带令牌。 */
function publicRead(req: IncomingMessage): boolean {
  // 插件在分发前会解码路径，鉴权必须用同一种拼写判断。
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (['/standalone-ai/settings', '/shutdown'].includes(path)) return false;
  if (/^\/dsh-pet-\d+\/(?:whisper|chat)(?:\/|$)/.test(path)) return false;
  return (
    [
      '/',
      '/health',
      '/standalone-ai/',
      '/standalone-ai/settings.js',
      '/standalone-ai/settings.css',
      '/standalone-ai/chat-panel.js',
      '/standalone-ai/icon.png',
    ].includes(path) || /^\/dsh-pet-\d+\//.test(path)
  );
}

/** 设置页凭据 cookie：首次带令牌访问后下发，刷新时替代已从地址栏清掉的令牌。 */
const TOKEN_COOKIE = 'dsh_pet_token';

/** 令牌的固定形状：32 字节 base64url。形状校验先跑，定时安全比较才有等长前提。 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** 从 Cookie 头里取出本服务的凭据；没有则返回空串。 */
function readTokenCookie(req: IncomingMessage): string {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== TOKEN_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}

/** 创建请求安全门面。 */
export function createRequestSecurity(): RequestSecurity {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    authenticatedUrl(baseUrl) {
      const base = new URL(baseUrl);
      if (
        base.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(base.hostname) ||
        base.username ||
        base.password
      ) {
        throw new Error('设置地址必须是本机 HTTP 地址');
      }
      return `${base.origin}/standalone-ai/#token=${token}`;
    },
    authorize(req, res, allowFileOrigin = false) {
      const host = req.headers.host;
      const port = req.socket.localPort;
      if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        return rejectRequest(res, 403, '仅允许当前本机地址');
      }
      // 文件页渲染器也要带令牌：沙箱网页同样会发来 null 来源。
      // 同一渲染器加载媒体时可能完全不带 Origin，只有这种情况才放行。
      // 字体这类强制 CORS 的子资源，Chromium 从 file:// 页面发出的是 `file://` 本身——
      // 既不是 null 也不是省略，漏掉它会让打包应用的字体一律 403。
      const fileOrigin =
        allowFileOrigin &&
        (req.headers.origin === 'null' || req.headers.origin === undefined || req.headers.origin === 'file://');
      if (
        !fileOrigin &&
        ((req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) ||
          req.headers['sec-fetch-site'] === 'cross-site')
      ) {
        return rejectRequest(res, 403, '不允许跨站请求');
      }
      try {
        if (publicRead(req) && !fileOrigin) return true;
      } catch {
        return rejectRequest(res, 400, '请求地址无效');
      }
      // 页内请求走请求头；刷新后地址栏令牌已被清掉，改用首次访问换来的 HttpOnly cookie。
      const header = req.headers['x-dsh-pet-token'];
      const fromHeader = typeof header === 'string' && TOKEN_SHAPE.test(header);
      const supplied = fromHeader ? header : readTokenCookie(req);
      // 先按固定形状校验，再走定时安全比较，避免长度与内容泄漏。
      if (!TOKEN_SHAPE.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return rejectRequest(res, 403, '请从桌宠菜单重新打开设置');
      }
      if (fromHeader && readTokenCookie(req) !== token) {
        // 会话级 cookie：不设 Max-Age，关掉浏览器即失效，同一进程内刷新继续可用。
        // Path 取根：对话面板要调 /dsh-pet-<n>/chat 这类插件路由，限定在 /standalone-ai/ 会让它拿不到凭据。
        res.setHeader('set-cookie', `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      }
      return true;
    },
  };
}

/** 清掉上游写出的宽 CORS 头，并补上安全响应头。 */
export function secureResponse(res: ServerResponse, pathname?: string): void {
  const writeHead = res.writeHead.bind(res);
  const isPublicOp = pathname === '/' || pathname === '/health';
  res.writeHead = ((status: number, ...args: unknown[]) => {
    const filtered = isPublicOp
      ? args
      : args.map((value) => {
          if (Array.isArray(value)) {
            return value.reduce<string[]>((result, item, index) => {
              if (index % 2 === 0 && !String(item).toLowerCase().startsWith('access-control-')) {
                return [...result, String(item), String(value[index + 1])];
              }
              return result;
            }, []);
          }
          if (value !== null && typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value).filter(([name]) => !name.toLowerCase().startsWith('access-control-')),
            );
          }
          return value;
        });
    if (!isPublicOp) {
      for (const name of res.getHeaderNames()) {
        if (name.toLowerCase().startsWith('access-control-')) res.removeHeader(name);
      }
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    return Reflect.apply(writeHead, res, [status, ...filtered]);
  }) as typeof res.writeHead;
}
