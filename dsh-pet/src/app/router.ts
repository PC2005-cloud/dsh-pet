/**
 * 独立应用的 HTTP 入口：插件路由、AI 配置页与状态页共用同一个本机服务。
 *
 * 只做路由与请求边界（去重、限长、CORS、错误兜底），不实现各路由的业务逻辑；对 Electron 无依赖，
 * 便于直接测非法与不可信请求。依赖 standalone 的页面与安全模块，安全判定一律先于分发。
 *
 * @module dsh-pet/src/app/router
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RegisteredRoute } from '../standalone/context.ts';
import { boundedRequest, MAX_REQUEST_BYTES, MAX_SETTINGS_BYTES } from '../standalone/request-body.ts';
import { rejectRequest, type RequestSecurity } from '../standalone/request-security.ts';
import {
  balanceHandler,
  modelsHandler,
  settingsHandler,
  testHandler,
  setupHandler,
  type StandaloneServerOptions,
} from '../standalone/server.ts';
import { sendIcon } from '../standalone/server/respond.ts';
import { readChatPanelScript } from '../standalone/chat-panel-asset.ts';
import { readSettingsIcon } from '../standalone/icon.ts';
import { settingsPage, settingsScript, settingsStyle } from '../standalone/settings-page.ts';

/** 路由依赖：安全校验、AI 处理器与两个页面的数据源，全部注入以脱离 Electron 测试。 */
interface RouterDeps {
  security: RequestSecurity;
  ai?: StandaloneServerOptions['ai'];
  setup?: StandaloneServerOptions['setup'];
  log(message: string): void;
  status(port: number): unknown;
  landingPage(port: number): string;
  /** 对话面板脚本来源；缺省读包内 `lib/chat-panel.js`，测试可注入。 */
  chatPanelScript?: () => string | undefined;
}

/**
 * 启动本机服务并返回实际端口与关闭函数。
 *
 * 只监听 127.0.0.1 的随机端口；请求体在进入处理器前先按路由限长读取。
 */
export function startRouter(
  routes: RegisteredRoute[],
  deps: RouterDeps,
): Promise<{ port: number; close: () => Promise<void> }> {
  const settings = settingsHandler(deps.ai);
  const chatPanelScript = deps.chatPanelScript ?? readChatPanelScript;
  const tester = testHandler(deps.ai);
  const models = modelsHandler(deps.ai);
  const balance = balanceHandler(deps.ai);
  /** 独立模式自带的 AI 路由：路径即处理器的查表，条目再多也不会把分支嵌套加深。 */
  const aiRoutes: Record<string, typeof settings> = {
    '/standalone-ai/setup': setupHandler(deps.setup),
    '/standalone-ai/settings': settings,
    '/standalone-ai/test': tester,
    '/standalone-ai/models': models,
    '/standalone-ai/balance': balance,
  };
  let boundPort = 0;

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      rejectRequest(res, 400, '请求地址无效');
      return;
    }
    const route = routes.find((candidate) =>
      candidate.kind === 'exact'
        ? url.pathname === candidate.path
        : url.pathname === candidate.path || url.pathname.startsWith(`${candidate.path}/`),
    );
    // 只有插件路由接受来自 file 渲染端的请求，且仍需它自己的凭证。
    if (!deps.security.authorize(req, res, !!route)) return;
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const dispatch = async (request: IncomingMessage): Promise<void> => {
      const assets: Record<string, readonly [string, string]> = {
        '/standalone-ai/': [settingsPage, 'text/html'],
        '/standalone-ai/settings.js': [settingsScript, 'text/javascript'],
        '/standalone-ai/settings.css': [settingsStyle, 'text/css'],
      };
      if (url.pathname === '/standalone-ai/icon.png') {
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
      if (url.pathname === '/standalone-ai/chat-panel.js') {
        if (method !== 'GET' && method !== 'HEAD') {
          rejectRequest(res, 405, '仅支持 GET');
          return;
        }
        // 与 CLI 侧共用同一份产物：设置页固定引用它，打包应用里缺这条路由会让对话区空白。
        const chatPanel = chatPanelScript();
        if (chatPanel === undefined) {
          rejectRequest(res, 404, '对话面板脚本缺失，请重新构建（npm run bundle）');
          return;
        }
        sendText(res, 200, 'text/javascript', chatPanel);
        return;
      }
      const asset = assets[url.pathname];
      if (asset || url.pathname === '/health' || url.pathname === '/') {
        if (method !== 'GET' && method !== 'HEAD') {
          rejectRequest(res, 405, '仅支持 GET');
          return;
        }
        if (asset) sendText(res, 200, asset[1], asset[0]);
        else if (url.pathname === '/health')
          sendText(res, 200, 'application/json', JSON.stringify(deps.status(boundPort)));
        else sendText(res, 200, 'text/html', deps.landingPage(boundPort));
        return;
      }
      const aiHandler = aiRoutes[url.pathname];
      if (aiHandler) {
        await aiHandler(request, res);
        return;
      }
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      // CORS 只让已鉴权的 file 渲染端可用，它本身不授予任何能力。
      res.setHeader('access-control-allow-origin', '*');
      await route.handler(request, res);
    };

    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    const bodyMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    void (async () => {
      if (hasBody || bodyMethod) {
        const limit = ['/standalone-ai/settings', '/standalone-ai/setup'].includes(url.pathname)
          ? MAX_SETTINGS_BYTES
          : MAX_REQUEST_BYTES;
        const bounded = await boundedRequest(req, res, limit);
        if (bounded) await dispatch(bounded);
      } else await dispatch(req);
    })().catch(() => {
      // 请求体、地址与抛出的值都可能带凭证：日志保持笼统。
      deps.log('本机接口处理失败');
      if (!res.headersSent) rejectRequest(res, 500, '接口暂时无法处理请求');
      else res.end();
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      boundPort = (server.address() as AddressInfo).port;
      resolvePromise({
        port: boundPort,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** 写一段纯文本响应：固定关缓存与嗅探，避免页面内联脚本被当资源加载。 */
function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}
