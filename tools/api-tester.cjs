/**
 * dsh-pet HTTP 接口测试页的本地代理。
 *
 * 为什么需要它：宿主路由（src/host/index.ts）**不返回 CORS 头**——浏览器半侧之所以能用，
 * 是因为它由 DSH 自己的 Web 服务同源提供。测试页要么是 file://（Origin: null），
 * 要么是本地另一个端口，跨域请求会被浏览器直接拦掉（不是 404，是压根发不出去）。
 * 所以这里起一个同源小服务：转发到宿主，并补上 CORS 头。
 *
 * 用法：
 *   node tools/api-tester.cjs                # 默认探测 3080，自动开浏览器
 *   node tools/api-tester.cjs --port 3080    # 指定宿主端口
 *   node tools/api-tester.cjs --no-open      # 不自动开浏览器
 *
 * 也可以用 --dir 指向别的静态目录（默认 tools/ 自身），方便调试别的页面。
 * 只监听 127.0.0.1；这条命令不碰任何生产代码。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PROXY_PORT = Number(argOf('--proxy-port', '8741'));
const ROOT_DIR = path.resolve(argOf('--dir', __dirname));
const PAGE = argOf('--page', 'api-tester.html');
const NO_OPEN = argv.includes('--no-open');

/** 转发目标端口：测试页上的输入框可以改它（经 /__target），所以是可变状态 */
let hostPort = Number(argOf('--port', '3080'));

/** 路由前缀：与 src/host/index.ts 的 ROUTE_PREFIX 一致（7340 是名字，不是端口） */
const PREFIX = '/dsh-pet-7340';

/** 这一跳要补的 CORS 头。注意：**只给本机测试代理补**，不改宿主行为。 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

/** 需要转发的路径：接口前缀本身 + 代理自身的探测端点 */
const isApi = (url) => url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 转发一个请求到宿主，并把响应（含 CORS 头）回给浏览器 */
function forward(req, res) {
  const target = `http://127.0.0.1:${hostPort}${req.url}`;
  const headers = { ...req.headers, host: `127.0.0.1:${hostPort}` };

  const upstream = http.request(target, { method: req.method, headers }, (up) => {
    // 转发时保留上游的 content-type 等，再叠 CORS；源站没给 content-length 也不影响（chunked 照传）
    res.writeHead(up.statusCode || 502, { ...up.headers, ...CORS });
    up.pipe(res);
  });

  upstream.on('error', (err) => {
    const msg =
      err.code === 'ECONNREFUSED'
        ? `连不上宿主 http://127.0.0.1:${hostPort}——DSH 没在跑，或端口不对（页面上改端口，或启动时 --port 指定）`
        : `转发失败：${err.message}`;
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify({ proxyError: msg, target }, null, 2));
  });

  req.pipe(upstream);
}

/**
 * 代理自己的小端点（**不是** dsh-pet 接口，所以放在前缀之外）：
 *   GET  /__target        → { port }        页面启动时问"现在转发到哪个端口"
 *   POST /__target?port=N → { port }        页面改了端口输入框，切换转发目标
 * 这样测试页不用重新启动代理就能换端口试。
 */
function handleTarget(req, res, url) {
  if (req.method === 'POST' || req.method === 'GET') {
    const p = Number(url.searchParams.get('port'));
    if (Number.isInteger(p) && p > 0 && p <= 65535) hostPort = p;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify({ port: hostPort }));
}

/** 静态文件（测试页本身）；做了防穿越校验 */
function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/' + PAGE;
  const file = path.resolve(ROOT_DIR, '.' + rel);
  if (!file.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found: ' + rel);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === '/__target') return handleTarget(req, res, url);
  if (isApi(req.url || '')) return forward(req, res);
  serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PROXY_PORT} 已被占用。换个端口：node tools/api-tester.cjs --proxy-port 8742\n`);
  } else {
    console.error('\n代理启动失败：' + err.message + '\n');
  }
  process.exit(1);
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PROXY_PORT}/${PAGE}`;
  console.log('');
  console.log('  dsh-pet 接口测试页');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  测试页   ${url}`);
  console.log(`  转发到   http://127.0.0.1:${hostPort}${PREFIX}`);
  console.log('');
  console.log('  Ctrl+C 退出');
  console.log('');

  if (NO_OPEN) return;
  // Windows 用 start（注意第一个空参数是窗口标题占位），macOS 用 open，其余 xdg-open
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 打不开就算了，地址已经打印在上面 */
  }
});
