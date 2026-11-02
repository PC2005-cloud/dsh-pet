/**
 * 宿主半侧的 HTTP 管道：素材路径校验、文件/JSON/文本应答、请求体收集、MIME 映射与图片类型判定。
 *
 * 只做协议层的事：不判断业务、不读配置、不碰状态；路由层（./routes）决定应答什么，这里决定怎么落盘。
 * 必须始终成立：素材路径一律经 resolveAsset 限定在给定根目录内，任何拼接都不得逃出该根。
 * @module dsh-pet/src/host/http
 */
import { createReadStream, existsSync, fstatSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';

/** 不同扩展名对应的 Content-Type 映射 */
export const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** 图片魔数判定需要读到的最大字节数：WebP 要看到第 12 字节。 */
export const IMAGE_HEAD_BYTES = 16;

/**
 * 按文件头魔数判定图片类型。
 *
 * 只看前 {@link IMAGE_HEAD_BYTES} 字节，不解析完整图片：调用方要么刚写完校验过的字节，
 * 要么手里没有扩展名可信的文件（附件对象按哈希命名、头像可被用户换成任意格式）。
 *
 * @param header - 文件头缓冲（可能不满 {@link IMAGE_HEAD_BYTES}）。
 * @param size - header 里实际读到的字节数。
 * @returns 图片的 Content-Type；不是 PNG / JPEG / GIF / WebP 之一时返回 undefined。
 */
export function imageTypeOf(header: Buffer, size: number): string | undefined {
  if (size >= 8 && header.readUInt32BE(0) === 0x89504e47 && header.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'image/png';
  }
  if (size >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (size >= 6) {
    const tag = header.toString('latin1', 0, 6);
    if (tag === 'GIF87a' || tag === 'GIF89a') return 'image/gif';
  }
  if (size >= 12 && header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

/**
 * 图片 Content-Type → 落盘扩展名。
 *
 * @param contentType - {@link imageTypeOf} 的返回值。
 * @returns 带点的扩展名；不在支持范围内返回 undefined。
 */
export function imageExtOf(contentType: string): string | undefined {
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/webp') return '.webp';
  if (contentType === 'image/gif') return '.gif';
  return undefined;
}

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined。
 */
export function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
export function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/** 单段字节区间（闭区间）。 */
export type ByteRange = { readonly start: number; readonly end: number };

/** Range 判定：命中区间、越界（回 416）、忽略（回整份 200）。 */
export type RangeDecision = ByteRange | 'unsatisfiable' | null;

/**
 * 解析单段 `Range` 头。
 *
 * 只接受 `bytes=<start>-<end>`、`bytes=<start>-`、`bytes=-<suffix>` 三种单段形式。多段、单位不符、
 * 语法非法返回 null（回整份）；起点越界或 start > end 返回 'unsatisfiable'（回 416）。
 * @param header - 请求头原值，可能为 undefined。
 * @param totalBytes - 文件总字节数；非正数时一律忽略 Range。
 * @returns 闭区间、'unsatisfiable' 或 null。
 */
export function parseRange(header: string | undefined, totalBytes: number): RangeDecision {
  if (!header || totalBytes <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    // 后缀形式：bytes=-N，取末尾 N 字节
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, totalBytes - suffixLength), end: totalBytes - 1 };
  }

  const start = Number(startText);
  const end = endText === '' ? totalBytes - 1 : Number(endText);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= totalBytes) return 'unsatisfiable';
  return { start, end: Math.min(end, totalBytes - 1) };
}

/**
 * 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
 *
 * Content-Length 必须取自正在读的那个 fd（open 事件里 fstat）：先 stat 再另开流，会在素材被覆盖/
 * 截断时声明长度大于实际字节，响应永远不结束也不报错（浏览器 stalled、视频 loadeddata 永不触发）。
 * 同一个 fd 的 fstat 拿到的大小与随后读出的字节天然一致。
 *
 * 支持单段 Range：视频会中途按 `Range: bytes=N-` 补数据，回整份会让播放器把整份当后半段拼，
 * 解到错位处提前 ended（动作被截断）。
 */
export function sendFile(req: IncomingMessage, res: ServerResponse, file: string, contentType: string): void {
  const stream = createReadStream(file);
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy(); // 客户端在开流前就放弃了
      return;
    }
    let totalBytes: number;
    try {
      totalBytes = fstatSync(fd).size;
    } catch {
      // 极端情况下 fstat 拿不到：不发长度头，交给 Node 用 chunked 收尾（长度天然一致，只是没声明）
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' });
      stream.pipe(res);
      return;
    }
    const decision = parseRange(req.headers.range, totalBytes);
    if (decision === 'unsatisfiable') {
      stream.destroy();
      res.writeHead(416, {
        'content-type': contentType,
        'content-range': `bytes */${totalBytes}`,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=3600',
      });
      res.end();
      return;
    }
    if (decision !== null) {
      // 命中区间：createReadStream 不能从中途开始，所以按 start/end 重开；长度用 fstat 的总长算，与切片一致
      stream.destroy();
      const ranged = createReadStream(file, { start: decision.start, end: decision.end });
      res.writeHead(206, {
        'content-type': contentType,
        'content-length': decision.end - decision.start + 1,
        'content-range': `bytes ${decision.start}-${decision.end}/${totalBytes}`,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=3600',
      });
      ranged.pipe(res);
      ranged.on('error', () => res.destroy());
      res.on('close', () => ranged.destroy());
      return;
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': totalBytes,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=3600',
    });
    stream.pipe(res);
  });
  // 读失败（文件被删/权限/被占用）：直接断连，让客户端立刻看到失败，而不是无限等待
  stream.on('error', () => res.destroy());
  // 客户端提前断开（快速切动画时高频发生）→ 停读，别把整个文件读完
  res.on('close', () => stream.destroy());
}

/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
export function sendJson(
  res: ServerResponse,
  status: number,
  obj: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** 发送纯文本响应（素材 404/400 等显式错误文案） */
export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** 单次业务路由的应答（WebServer 注册与桌面 Helper 管道共用的同一契约；消费方各自落盘） */
export type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string }
  /** 无需应答：调用方在挂起等待期间已断开（见 /playback 的等待分支）——消费方直接收尾，不写 */
  | { kind: 'none' };

/** 请求体上限（字节）：写端点只收 JSON 配置与指令，1MiB 足够，超限直接 413。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 收集请求体（文本）。
 *
 * 带上限与断连处理：客户端半途断开时必须让 Promise 落地，否则处理器永远挂着、内存只增不减。
 *
 * @param req - 请求对象。
 * @returns 请求体文本。
 * @throws {Error} 超过 {@link MAX_BODY_BYTES} 时带 `code: 'body-too-large'`；连接提前断开时带 `code: 'client-aborted'`。
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    /**
     * 落地一次：'close' 在正常应答后也会触发，靠标志位拒绝二次落地。
     * 不摘监听——请求对象随连接回收，摘监听反而要求调用方提供完整的 on/off 对（测试桩通常只有 on）。
     */
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      finish();
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle(() => reject(Object.assign(new Error('request body too large'), { code: 'body-too-large' })));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => settle(() => resolve2(Buffer.concat(chunks).toString('utf8')));
    const onError = (error: Error): void => settle(() => reject(error));
    const onAborted = (): void =>
      settle(() => reject(Object.assign(new Error('client aborted'), { code: 'client-aborted' })));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onAborted);
    req.on('aborted', onAborted);
  });
}
