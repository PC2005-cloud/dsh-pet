import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { rejectRequest } from './request-security';

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_SETTINGS_BYTES = 16 * 1024;
export const BODY_TIMEOUT_MS = 5000;

/** Buffer once before invoking any plugin. Its old readBody then consumes a bounded replay stream. */
export async function boundedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
  timeoutMs = BODY_TIMEOUT_MS,
): Promise<IncomingMessage | undefined> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    rejectRequest(res, 413, '请求正文过大');
    return undefined;
  }
  const chunks: Buffer[] = [];
  const body = await new Promise<Buffer | undefined>((resolve) => {
    let size = 0;
    const finish = (status?: number): void => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      if (status !== undefined) {
        req.pause();
        if (!res.writableEnded && !res.destroyed)
          rejectRequest(res, status, status === 408 ? '读取请求超时' : '请求正文无效或过大');
        resolve(undefined);
      } else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) finish(413);
      else chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(400);
    const timer = setTimeout(() => finish(408), timeoutMs);
    timer.unref();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onError);
  });
  if (body === undefined) return undefined;
  return Object.assign(Readable.from([body]), {
    method: req.method,
    url: req.url,
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    socket: req.socket,
    httpVersion: req.httpVersion,
  }) as IncomingMessage;
}
