/**
 * 应答工具：命中判定、JSON/文件/错误三种写回。
 *
 * 不决定状态码语义（由处理器给），只负责按格式落盘。
 * 必须始终成立：写回前必须确认响应未结束，避免二次写。
 * @module dsh-pet/src/standalone/server/respond
 */
import { type RegisteredRoute, type StandaloneLogger } from '../context.ts';
import { type ServerResponse } from 'node:http';

/** 前缀路由匹配：exact 只比全等，prefix 允许后接子路径。 */
export function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

/** 回 JSON；探针允许跨域读取。 */
export function sendJson(res: ServerResponse, status: number, body: unknown, cors = false): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...(cors ? { 'access-control-allow-origin': '*' } : {}),
  });
  res.end(payload);
}

/** 回静态资源，附带只允许同源脚本、样式与同源 blob 图片的 CSP。 */
export function sendAsset(res: ServerResponse, body: string, type: string): void {
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    // blob: 只给头像预览用：图片走带令牌的 fetch 再转 blob，不能直接放进 img src（同源 img 不带 Origin，会被判成文件来源）。
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  res.end(body);
}

/** 回设置页标签图标：二进制 PNG，不参与 CSP 与嗅探。 */
export function sendIcon(res: ServerResponse, icon: Buffer): void {
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': icon.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(icon);
}

/** 记录并回一个不含细节的 500。 */
export function fail(res: ServerResponse, _error: unknown, logger: StandaloneLogger): void {
  // 绝不回显或记录服务商错误：其中可能有 API 密钥或带凭据的地址。
  logger.error('独立模式路由处理失败（详细内容已省略以保护凭据）');
  if (res.headersSent) res.destroy();
  else sendJson(res, 500, { error: '本机服务暂时无法处理请求' });
}
