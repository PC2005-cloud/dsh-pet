import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AI_SETTINGS, type StandaloneAiSettings } from '../ai-config.ts';
import type { AiFetch } from '../ai-transport.ts';
import { discoverModels } from './list-models.ts';

const settings: StandaloneAiSettings = {
  ...DEFAULT_AI_SETTINGS,
  baseUrl: 'https://api.example.test/v1',
  model: 'saved-model',
  apiKey: 'saved-key',
};

/** 记录请求并按脚本回放响应的假 fetch。 */
function recorder(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(String(input), init);
  }) as unknown as AiFetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('OpenAI 兼容端点：data 数组被归一成 id 与名称 → 保持端点顺序', async () => {
  const { calls, fetchImpl } = recorder(() =>
    json({ data: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'bare' }] }),
  );
  const result = await discoverModels(fetchImpl, settings, {});
  assert.deepEqual(result, {
    ok: true,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'bare', name: 'bare' },
    ],
  });
  assert.equal(calls[0].url, 'https://api.example.test/v1/models');
  assert.equal(calls[0].headers.authorization, 'Bearer saved-key');
});

test('兼容网关的 models 映射与 Anthropic 的 display_name → 两种写法都能读出名称', async () => {
  const mapped = recorder(() => json({ models: { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } } }));
  assert.deepEqual(await discoverModels(mapped.fetchImpl, settings, {}), {
    ok: true,
    models: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
  });
  const named = recorder(() => json({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }));
  assert.deepEqual(await discoverModels(named.fetchImpl, settings, { protocol: 'anthropic' }), {
    ok: true,
    models: [{ id: 'claude-x', name: 'Claude X' }],
  });
});

test('Anthropic 协议：请求带版本号的清单地址与 x-api-key，不发送 Bearer', async () => {
  const { calls, fetchImpl } = recorder(() => json({ data: [{ id: 'claude-3' }] }));
  await discoverModels(fetchImpl, settings, {
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'draft-key',
  });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(calls[0].headers['x-api-key'], 'draft-key');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('地址省略 /v1：先按原样请求，404 之后改打带版本号的地址', async () => {
  const { calls, fetchImpl } = recorder((url) =>
    url.endsWith('/v1/models') ? json({ data: [{ id: 'found' }] }) : json({ error: 'nope' }, 404),
  );
  const result = await discoverModels(fetchImpl, settings, { baseUrl: 'https://api.example.test' });
  assert.deepEqual(result, { ok: true, models: [{ id: 'found', name: 'found' }] });
  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://api.example.test/models', 'https://api.example.test/v1/models'],
  );
});

test('鉴权失败：401 → code 为 auth，文案不回显响应正文', async () => {
  const { fetchImpl } = recorder(() => json({ error: 'invalid key sk-should-not-leak' }, 401));
  const result = await discoverModels(fetchImpl, settings, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'auth');
  assert.doesNotMatch(result.message, /sk-should-not-leak/);
});

test('响应不是模型列表：code 为 contract，且不做第二次请求', async () => {
  const { calls, fetchImpl } = recorder(() => json({ hello: 'world' }));
  const result = await discoverModels(fetchImpl, settings, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'contract');
  assert.equal(calls.length, 1);
});

test('响应不是 JSON：code 为 contract', async () => {
  const { fetchImpl } = recorder(() => new Response('<html>gateway</html>', { status: 200 }));
  const result = await discoverModels(fetchImpl, settings, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'contract');
});

test('缺地址或缺密钥：不发请求，直接回 code input', async () => {
  const { calls, fetchImpl } = recorder(() => json({ data: [] }));
  const blank = { ...settings, baseUrl: '', apiKey: '' };
  const noBase = await discoverModels(fetchImpl, blank, {});
  assert.equal(noBase.ok, false);
  if (!noBase.ok) assert.equal(noBase.code, 'input');
  const noKey = await discoverModels(fetchImpl, blank, { baseUrl: 'https://api.example.test/v1' });
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.equal(noKey.code, 'input');
  assert.equal(calls.length, 0);
});

test('带账号或查询参数的地址被拒绝', async () => {
  const { calls, fetchImpl } = recorder(() => json({ data: [] }));
  for (const baseUrl of ['https://user:pass@api.example.test/v1', 'https://api.example.test/v1?x=1']) {
    const result = await discoverModels(fetchImpl, settings, { baseUrl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'input');
  }
  assert.equal(calls.length, 0);
});

test('网络失败：code 为 network', async () => {
  const { fetchImpl } = recorder(() => {
    throw new TypeError('fetch failed');
  });
  const result = await discoverModels(fetchImpl, settings, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'network');
});

test('草稿缺省：沿用已保存的地址与密钥', async () => {
  const { calls, fetchImpl } = recorder(() => json({ data: [{ id: 'saved' }] }));
  await discoverModels(fetchImpl, settings, { protocol: 'openai-compatible' });
  assert.equal(calls[0].url, 'https://api.example.test/v1/models');
  assert.equal(calls[0].headers.authorization, 'Bearer saved-key');
});
