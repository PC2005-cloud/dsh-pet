/**
 * DeepSeek ASR 实现的契约测试（src/host/voice/builtin-deepseek-asr.ts）。
 * 只钉「请求形状、返回与失败」——不联网，fetch 全程替身。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createDeepseekAsrProvider,
  DEEPSEEK_ASR_PROVIDER_ID,
  ensureDeepseekAsrProvider,
} from './builtin-deepseek-asr.ts';
import { resetSpeechProviders, resolveSpeechProvider } from './speech-registry.ts';
import { SpeechUnavailableError, validateSpeechProvider } from './speech-types.ts';

/** 一段假音频：实现不做格式校验。 */
const AUDIO = new Uint8Array([1, 2, 3]);

/** 一次被替换掉的 fetch 调用。 */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** 替身 fetch：记录调用并返回给定响应；返回记录数组与其恢复函数。 */
function stubFetch(respond: () => Response): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** 造一个带固定 key 的实现。 */
function providerWithKey(key: string | undefined) {
  return createDeepseekAsrProvider({ resolveKey: async () => key });
}

afterEach(() => {
  resetSpeechProviders();
});

test('声明：通过注册校验，id 是 deepseek', () => {
  const provider = providerWithKey('k');
  assert.doesNotThrow(() => validateSpeechProvider(provider));
  assert.equal(provider.id, DEEPSEEK_ASR_PROVIDER_ID);
  assert.equal(provider.name, 'DeepSeek');
});

test('成功：返回官方响应里的 text', async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ text: '你好', duration_ms: 3200 }), { status: 200 }));
  try {
    assert.equal(await providerWithKey('secret').transcribe({ audio: AUDIO }), '你好');
  } finally {
    stub.restore();
  }
});

test('请求：multipart 上传、带 Bearer、打到官方 ASR', async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ text: '' }), { status: 200 }));
  try {
    await providerWithKey('secret').transcribe({ audio: AUDIO });
    const call = stub.calls[0];
    assert.equal(call?.url, 'https://api.deepseek.com/v1/tools/asr');
    assert.equal((call?.init.headers as Record<string, string>).authorization, 'Bearer secret');
    assert.equal(call?.init.body instanceof FormData, true, '官方只收文件，不收 base64');
    assert.equal((call?.init.body as FormData).has('file'), true);
  } finally {
    stub.restore();
  }
});

test('没有 API key：按「不可用」抛错，且不发请求', async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ text: '' }), { status: 200 }));
  try {
    await assert.rejects(
      () => providerWithKey(undefined).transcribe({ audio: AUDIO }),
      (error: unknown) => error instanceof SpeechUnavailableError,
    );
    assert.equal(stub.calls.length, 0, '没 key 不该打网络');
  } finally {
    stub.restore();
  }
});

test('上游非 200：抛错并带上状态码', async () => {
  const stub = stubFetch(() => new Response('too large', { status: 413 }));
  try {
    await assert.rejects(() => providerWithKey('secret').transcribe({ audio: AUDIO }), /413/);
  } finally {
    stub.restore();
  }
});

test('响应缺 text：抛错，不把 undefined 当识别结果', async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ request_id: 'x' }), { status: 200 }));
  try {
    await assert.rejects(() => providerWithKey('secret').transcribe({ audio: AUDIO }), /invalid body/);
  } finally {
    stub.restore();
  }
});

test('ensure：注册一次，重复调用不覆盖', () => {
  ensureDeepseekAsrProvider({ resolveKey: async () => 'k' });
  const first = resolveSpeechProvider(DEEPSEEK_ASR_PROVIDER_ID);
  assert.equal(first?.name, 'DeepSeek');
  ensureDeepseekAsrProvider({ resolveKey: async () => 'other' });
  assert.equal(resolveSpeechProvider(DEEPSEEK_ASR_PROVIDER_ID), first);
});
