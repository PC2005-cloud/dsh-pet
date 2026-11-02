/**
 * 头像提交的网络分支（`postAvatar`）：请求形状与失败分档。
 *
 * 编码要 canvas，测试环境没有；所以编码与提交拆开，这里只用注入的 fetch 替身测提交。
 * 跑法：node --experimental-strip-types --test src/client/settings/avatar-upload.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { postAvatar } from './avatar-upload.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';

/** 最小响应替身：只用到 ok / status / json。 */
const response = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** 记录调用的 fetch 替身。 */
function fakeFetch(body: unknown, status = 200): { calls: { url: string; init?: RequestInit }[]; impl: typeof fetch } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response(body, status);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('postAvatar', () => {
  test('成功：POST 到 ?root=，体是 base64 JSON', async () => {
    const { calls, impl } = fakeFetch({ ok: true });
    assert.deepEqual(await postAvatar('baimao', 'AAA=', impl), { ok: true });
    assert.equal(calls[0]?.url, ROUTE_PATH + '/pet-avatar?root=baimao');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.deepEqual(calls[0]?.init?.headers, { 'content-type': 'application/json' });
    assert.equal(calls[0]?.init?.body, JSON.stringify({ base64: 'AAA=' }));
  });

  test('宿主业务失败 → 回它给的文案，不自己编', async () => {
    const { impl } = fakeFetch({ ok: false, message: '内置条目不能换头像' });
    assert.deepEqual(await postAvatar('main', 'AAA=', impl), { ok: false, message: '内置条目不能换头像' });
  });

  test('业务失败但没带文案 → 兜一个通用失败', async () => {
    const { impl } = fakeFetch({ ok: false });
    assert.deepEqual(await postAvatar('cat', 'AAA=', impl), { ok: false, message: '上传失败' });
  });

  test('HTTP 非 2xx → 带状态码的失败文案', async () => {
    const { impl } = fakeFetch({}, 413);
    const result = await postAvatar('cat', 'AAA=', impl);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /413/);
  });

  test('响应不是 JSON → 按失败处理，不抛', async () => {
    const impl = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    assert.equal((await postAvatar('cat', 'AAA=', impl)).ok, false);
  });

  test('素材根会先编码再进查询串', async () => {
    const { calls, impl } = fakeFetch({ ok: true });
    await postAvatar('小猫 pack', 'AAA=', impl);
    assert.equal(calls[0]?.url, ROUTE_PATH + '/pet-avatar?root=' + encodeURIComponent('小猫 pack'));
  });
});
