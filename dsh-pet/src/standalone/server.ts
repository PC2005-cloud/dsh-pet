/**
 * 独立模式的 HTTP 监听器：接管 DSH WebServer 原本扮演的角色。
 *
 * 这里**没有路由表** —— 路由表属于插件自己的宿主半边（`apply` 注册在 `ctx.webServer` 上的
 * prefix handler，见 `./context`）。本模块只做四件事：
 *   1. 绑定 127.0.0.1（端口被占用则顺延，独立模式没有 DSH 指定的固定端口）；
 *   2. 把落在插件路由前缀上的请求原样交给那份 handler（它自己写响应头与 body）；
 *   3. 提供 `/` 与 `/health`（运维信息）和 `/shutdown`（脚本化停机）；
 *   4. 兜住 handler 的异常，按插件自身的口径回 500 JSON。
 *
 * 为什么这里不补 `Access-Control-Allow-Origin`：独立模式的桌面渲染端经 bridge 管道
 * 取数据（不是 HTTP 跨源请求），CORS 对它无意义；而由本服务直接写的响应（`/`、`/shutdown`、
 * 未匹配路由）都带上了跨源头，供浏览器/第三方工具直接消费。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

import type { RegisteredRoute, StandaloneLogger } from './context';

/** 独立模式默认端口（与插件 helper 的内置默认一致） */
export const DEFAULT_STANDALONE_PORT = 3080;
/** 端口被占用时向后顺延的个数上限 */
export const PORT_SCAN_LIMIT = 25;

export interface StandaloneServerOptions {
  /** 插件注册的路由（与 `createStandaloneContext` 共用同一个数组） */
  routes: RegisteredRoute[];
  logger: StandaloneLogger;
  /** 首选端口，默认 {@link DEFAULT_STANDALONE_PORT} */
  port?: number;
  /** `/` 与 `/health` 的运维信息提供者 */
  status?: () => unknown;
  /** `/shutdown` 被请求时通知调用方收尾（独立模式的脚本化停机） */
  onShutdown?: () => void;
}

export interface StandaloneServer {
  /** 实际监听的端口（首选端口被占用时会大于请求值） */
  port: number;
  close(): Promise<void>;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

/** 只取 pathname（不解码，避免 %2F 一类输入在校验之前被改写）；非法 URL 落回 '/' */
function pathnameOf(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
    ...headers,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

/** handler 抛错时的收口：头已发出就断连（与插件 sendFile 的错误口径一致），否则 500 JSON */
function fail(res: ServerResponse, error: unknown, logger: StandaloneLogger): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`路由处理异常：${message}`);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, 500, { error: message });
}

/** 建一个请求监听器（导出以便单测直接驱动，不必真的起 socket） */
export function createRequestListener(
  options: StandaloneServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { routes, logger, status, onShutdown } = options;
  return (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = pathnameOf(req.url);
    logger.debug(`${method} ${pathname}`);

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (pathname === '/' || pathname === '/health') {
      sendJson(res, 200, status?.() ?? { name: 'dsh-pet-standalone' });
      return;
    }
    if (pathname === '/shutdown') {
      // 先回话再收尾：调用方要能拿到 200，而不是被自己的停机动作打断
      sendJson(res, 200, { ok: true, stopping: true });
      queueMicrotask(() => onShutdown?.());
      return;
    }

    const route = routes.find((candidate) => matches(candidate, pathname));
    if (route === undefined) {
      sendText(
        res,
        404,
        `dsh-pet-standalone: 没有匹配的路由（已注册：${routes.map((item) => item.path).join(', ') || '无'}）`,
      );
      return;
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch((error: unknown) => fail(res, error, logger));
    } catch (error) {
      fail(res, error, logger);
    }
  };
}

/** 从 preferred 起找一个能绑上的 127.0.0.1 端口；`preferred = 0` 表示交给系统分配 */
async function bindFirstFree(server: HttpServer, preferred: number, logger: StandaloneLogger): Promise<number> {
  for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) {
    try {
      await new Promise<void>((accept, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          accept();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      // 真实端口必须回读 address()：传 0 时监听端口由系统分配，不等于请求值
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}

/**
 * 起独立模式服务。
 * @param options 路由、日志器、首选端口与运维回调
 * @returns 实际端口与关闭函数
 */
export async function listenStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const server = createServer(createRequestListener(options));
  // 客户端半截请求（扫描器、被中断的连接）不该变成未捕获异常刷屏
  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await bindFirstFree(server, options.port ?? DEFAULT_STANDALONE_PORT, options.logger);
  options.logger.info(`独立模式服务已监听 http://127.0.0.1:${port}/`);
  return {
    port,
    async close(): Promise<void> {
      // keep-alive 连接会让 close() 一直等：先断开全部连接再关（脚本化停机不能挂住）
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
