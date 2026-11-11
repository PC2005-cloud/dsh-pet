/**
 * 出站 JSON 抓取的契约测试：超时与网络错误重试一次，4xx/5xx 与解析失败各自归一。
 *
 * 全部用手写 fetch 替身，不联网；sleep 注入成空实现，测试不吃真实重试间隔。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FetchJsonError, fetchJson } from './fetch-json.ts';

/** 造一个按调用次序回应的 fetch 替身；步数用尽后一直复用最后一步。 */
function fakeFetch(steps: (() => Response | Promise<Response>)[]): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(String(url));
    return step();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 造一个 JSON 响应。 */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** 不吃真实等待的重试间隔。 */
const NO_SLEEP = async (): Promise<void> => {};

/** 造一个超时异常（AbortSignal.timeout 抛出的 name 就是这个）。 */
function timeoutError(): Error {
  const error = new Error('aborted');
  error.name = 'TimeoutError';
  return error;
}

describe('fetchJson —— 成功路径', () => {
  test('返回已解析的 JSON 值', async () => {
    const fake = fakeFetch([() => json({ temperature: 26.1 })]);

    const value = await fetchJson('https://example.test/a', { label: 't', fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(value, { temperature: 26.1 });
    assert.deepEqual(fake.calls, ['https://example.test/a'], '只应发一次请求');
  });
});

describe('fetchJson —— 失败归一', () => {
  test('非 2xx：报 http-status，且不重试', async () => {
    const fake = fakeFetch([() => new Response('', { status: 500 })]);

    await assert.rejects(
      () => fetchJson('https://example.test/a', { label: 'ip-api', fetchImpl: fake.impl, sleep: NO_SLEEP }),
      (error: unknown) => error instanceof FetchJsonError && error.code === 'http-status',
      '500 应归一成 http-status',
    );
    assert.equal(fake.calls.length, 1, '5xx 有明确语义，不该重试');
  });

  test('超时：重试一次后仍失败，报 timeout', async () => {
    const fake = fakeFetch([
      () => {
        throw timeoutError();
      },
      () => {
        throw timeoutError();
      },
    ]);

    await assert.rejects(
      () => fetchJson('https://example.test/a', { label: 't', fetchImpl: fake.impl, sleep: NO_SLEEP }),
      (error: unknown) => error instanceof FetchJsonError && error.code === 'timeout',
      '超时应归一成 timeout',
    );
    assert.equal(fake.calls.length, 2, '超时要重试一次');
  });

  test('网络错误：重试一次后成功', async () => {
    const fake = fakeFetch([
      () => {
        throw new Error('ECONNRESET');
      },
      () => json({ ok: true }),
    ]);

    const value = await fetchJson('https://example.test/a', { label: 't', fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(value, { ok: true });
    assert.equal(fake.calls.length, 2, '网络错误后应重试一次');
  });

  test('响应不是 JSON：报 bad-json', async () => {
    const fake = fakeFetch([() => new Response('<html>', { status: 200 })]);

    await assert.rejects(
      () => fetchJson('https://example.test/a', { label: 't', fetchImpl: fake.impl, sleep: NO_SLEEP }),
      (error: unknown) => error instanceof FetchJsonError && error.code === 'bad-json',
      '非 JSON 响应应归一成 bad-json',
    );
  });

  test('错误文案带上端点名，便于定位是哪个接口挂了', async () => {
    const fake = fakeFetch([() => new Response('', { status: 403 })]);

    await assert.rejects(
      () => fetchJson('https://example.test/a', { label: 'ipwho.is', fetchImpl: fake.impl, sleep: NO_SLEEP }),
      (error: unknown) => error instanceof Error && error.message.includes('ipwho.is'),
      '错误信息应含端点名',
    );
  });
});
