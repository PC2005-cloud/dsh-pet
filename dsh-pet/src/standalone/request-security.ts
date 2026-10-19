import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestSecurity {
  /** Process capability: private launcher manifest only, never an HTTP response or log. */
  readonly token: string;
  authenticatedUrl(baseUrl: string): string;
  authorize(req: IncomingMessage, res: ServerResponse): boolean;
}

export function rejectRequest(res: ServerResponse, status: number, error: string): false {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error }));
  return false;
}

function publicRead(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let path: string;
  try {
    path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return false;
  }
  if (['/standalone-ai/settings', '/shutdown'].includes(path)) return false;
  if (/^\/dsh-pet-\d+\/(?:whisper|chat)(?:\/|$)/.test(path)) return false;
  return (
    ['/', '/health', '/standalone-ai/', '/standalone-ai/settings.js', '/standalone-ai/settings.css'].includes(path) ||
    /^\/dsh-pet-\d+\//.test(path)
  );
}

/** Origin/Fetch-Metadata are CSRF checks; the custom capability header also excludes HTML forms. */
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
    authorize(req, res) {
      const host = req.headers.host;
      const port = req.socket.localPort;
      if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        return rejectRequest(res, 403, '仅允许当前本机地址');
      }
      if (
        (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      ) {
        return rejectRequest(res, 403, '不允许跨站请求');
      }
      try {
        if (publicRead(req)) return true;
      } catch {
        return rejectRequest(res, 400, '请求地址无效');
      }
      const supplied = req.headers['x-dsh-pet-token'];
      if (
        typeof supplied !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      ) {
        return rejectRequest(res, 403, '请从桌宠菜单重新打开设置');
      }
      return true;
    },
  };
}

/** Upstream plugin handlers write wildcard CORS; remove it at the actual HTTP boundary. */
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
