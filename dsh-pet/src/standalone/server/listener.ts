/**
 * 请求分发与监听器创建：按路由表顺序匹配，未命中回 404。
 *
 * 不做业务判断；处理器返回什么就写什么。
 * 必须始终成立：处理器抛错一律归一成 500，绝不把栈信息回给客户端。
 * @module dsh-pet/src/standalone/server/listener
 */
import { createRequestSecurity, rejectRequest, secureResponse, type RequestSecurity } from '../request-security.ts';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { settingsPage, settingsScript, settingsStyle } from '../settings-page.ts';
import { readChatPanelScript } from '../chat-panel-asset.ts';
import { readSettingsIcon } from '../icon.ts';
import { MAX_REQUEST_BYTES, MAX_SETTINGS_BYTES, boundedRequest } from '../request-body.ts';
import { type StandaloneLogger } from '../context.ts';
import { DEFAULT_STANDALONE_PORT, PORT_SCAN_LIMIT } from './options.ts';
import type { StandaloneServer, StandaloneServerOptions } from './options.ts';
import { balanceHandler, modelsHandler, settingsHandler, testHandler, setupHandler } from './handlers.ts';
import { fail, matches, sendAsset, sendIcon, sendJson } from './respond.ts';

/** 组装请求分发器：先处理探针、设置页与停机，再交给插件路由。 */
function dispatch(
  options: StandaloneServerOptions,
  shutdownSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => void {
  const settings = settingsHandler(options.ai);
  const tester = testHandler(options.ai);
  const models = modelsHandler(options.ai);
  const balance = balanceHandler(options.ai);
  const setup = setupHandler(options.setup);
  return (req, res, pathname) => {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/' || pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendJson(res, 200, options.status?.() ?? { name: 'dsh-pet-standalone' }, true);
      return;
    }
    if (pathname === '/shutdown') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '停机请使用 POST');
        return;
      }
      if (shutdownSecurity) {
        const supplied = req.headers['x-dsh-pet-token'];
        if (
          typeof supplied !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(shutdownSecurity.token))
        ) {
          rejectRequest(res, 403, '停机需要提供令牌');
          return;
        }
      }
      sendJson(res, 200, { ok: true, stopping: true });
      queueMicrotask(() => options.onShutdown?.());
      return;
    }
    const assets: Record<string, readonly [string, string]> = {
      '/standalone-ai/': [settingsPage, 'text/html'],
      '/standalone-ai/settings.js': [settingsScript, 'text/javascript'],
      '/standalone-ai/settings.css': [settingsStyle, 'text/css'],
    };
    if (pathname === '/standalone-ai/icon.png') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      const icon = readSettingsIcon();
      if (!icon) {
        rejectRequest(res, 404, '图标缺失');
        return;
      }
      sendIcon(res, icon);
      return;
    }
    if (pathname === '/standalone-ai/chat-panel.js') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      // 构建产物随包发布；缺失只可能是没跑 bundle，明确回 404 而不是给空脚本。
      const chatPanel = readChatPanelScript();
      if (chatPanel === undefined) {
        rejectRequest(res, 404, '对话面板脚本缺失，请重新构建（npm run bundle）');
        return;
      }
      sendAsset(res, chatPanel, 'text/javascript');
      return;
    }
    const asset = assets[pathname];
    if (asset) {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendAsset(res, asset[0], asset[1]);
      return;
    }
    if (pathname === '/standalone-ai/setup') {
      void setup(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/settings') {
      void settings(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/test') {
      void tester(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/models') {
      void models(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/balance') {
      void balance(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    const route = options.routes.find((candidate) => matches(candidate, pathname));
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `dsh-pet-standalone: 没有匹配的路由（已注册：${options.routes.map((item) => item.path).join(', ') || '无'}）`,
      );
      return;
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch((error: unknown) => fail(res, error, options.logger));
    } catch (error) {
      fail(res, error, options.logger);
    }
  };
}

/**
 * 创建 HTTP 请求监听器。
 * @param options - 启动选项。
 * @param injectedSecurity - 注入的访问校验。
 * @returns 监听器。
 */
export function createRequestListener(
  options: StandaloneServerOptions,
  injectedSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse) => void {
  const security = options.security ?? injectedSecurity;
  const route = dispatch(options, security);
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      rejectRequest(res, 400, '请求地址无效');
      return;
    }
    secureResponse(res, pathname);
    if (security && !security.authorize(req, res)) return;
    // 不记录路径、片段、查询、正文与鉴权头，避免把令牌写进日志。
    options.logger.debug('收到本机 HTTP 请求');
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    const bodyMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '');
    // 有正文或写方法都要先走有界读取，避免插件自己无限读。
    if ((hasBody || bodyMethod) && typeof req.on === 'function') {
      const limit = ['/standalone-ai/settings', '/standalone-ai/setup'].includes(pathname)
        ? MAX_SETTINGS_BYTES
        : MAX_REQUEST_BYTES;
      void boundedRequest(req, res, limit, options.bodyTimeoutMs)
        .then((bounded) => {
          if (bounded) route(bounded, res, pathname);
        })
        .catch((error: unknown) => fail(res, error, options.logger));
    } else route(req, res, pathname);
  };
}

/** 从首选端口起逐个尝试，只接受 EADDRINUSE 后继续。 */
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
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      // 端口顺延时提示一次，读者才知道最终地址与请求的不同。
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}

/**
 * 创建并启动本机服务。
 * @param options - 启动选项。
 * @returns 已监听的服务。
 * @throws 连续多个端口都被占用时抛出。
 */
export async function listenStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const security = options.security;
  const server = createServer(createRequestListener(options, security));
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await bindFirstFree(server, options.port ?? DEFAULT_STANDALONE_PORT, options.logger);
  options.logger.info(`独立模式服务已监听 http://127.0.0.1:${port}/`);
  return {
    port,
    security: security ?? createRequestSecurity(),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
