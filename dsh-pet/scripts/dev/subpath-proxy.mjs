/**
 * 子路径部署复现工具：把 `/app/DeepSeek-Harness/fngateway/*` 剥掉前缀转发给本机 DSH，
 * 前缀之外一律 404——与 fnOS 应用网关这类反向代理同一口径，用来复现 issue #242。
 * 开发自测工具，不入 npm 包。不实现鉴权、不改写响应体；Cookie 与请求头原样透传，
 * 只改写 Host，因此浏览器在 DSH 站点上已有的登录态可直接复用。
 * 端口、目标与前缀分别取 argv[2..4]，默认 9090 → http://127.0.0.1:8080 → /app/DeepSeek-Harness/fngateway；
 * 入口是 npm run dev:subpath。
 * @module dsh-pet/scripts/dev/subpath-proxy
 */
import { createServer, request } from 'node:http';
import { connect } from 'node:net';

const LISTEN_PORT = Number(process.argv[2] || 9090);
const TARGET = new URL(process.argv[3] || 'http://127.0.0.1:8080');
/** 去掉尾部斜杠：前缀本身不是可请求地址，带斜杠的形式由下面的重定向补齐。 */
const PREFIX = (process.argv[4] || '/app/DeepSeek-Harness/fngateway').replace(/\/+$/, '');
/** 改写后的 Host：宿主按自己认的 authority 校验签名 Cookie，端口必须与目标一致。 */
const UPSTREAM_AUTHORITY = `${TARGET.hostname}:${TARGET.port}`;

/** 剥掉前缀后的上游路径；挂载根本身映射成 `/`。 */
function upstreamPath(url) {
  const rest = url.slice(PREFIX.length);
  return rest === '' ? '/' : rest;
}

const server = createServer((req, res) => {
  const url = req.url || '/';
  // 不带尾斜杠的挂载根必须重定向：否则文档基准退到上一层目录，相对请求会全部指错
  if (url === PREFIX || url.startsWith(PREFIX + '?')) {
    res.writeHead(301, { location: PREFIX + '/' + url.slice(PREFIX.length) });
    res.end();
    return;
  }
  if (!url.startsWith(PREFIX + '/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`outside mount prefix: ${url}\n`);
    return;
  }
  const upstream = request(
    {
      host: TARGET.hostname,
      port: TARGET.port,
      method: req.method,
      path: upstreamPath(url),
      headers: { ...req.headers, host: UPSTREAM_AUTHORITY },
    },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`upstream error: ${error.message}\n`);
  });
  req.pipe(upstream);
});

// WebSocket 握手同样受前缀约束：DSH 的会话事件走 ws，缺了它页面能开但会话连不上
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';
  if (!url.startsWith(PREFIX + '/')) {
    socket.destroy();
    return;
  }
  const upstream = connect(Number(TARGET.port), TARGET.hostname, () => {
    const lines = [`GET ${upstreamPath(url)} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = name.toLowerCase() === 'host' ? UPSTREAM_AUTHORITY : req.rawHeaders[i + 1];
      lines.push(`${name}: ${value}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`子路径环境就绪：http://127.0.0.1:${LISTEN_PORT}${PREFIX}/`);
  console.log(`转发目标：${TARGET.origin}（Host 改写为 ${UPSTREAM_AUTHORITY}）`);
  console.log('前缀之外的请求一律 404：与真实应用网关同口径');
});
