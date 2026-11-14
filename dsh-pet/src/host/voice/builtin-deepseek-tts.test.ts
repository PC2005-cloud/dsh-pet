/**
 * DeepSeek TTS 实现的契约测试（src/host/voice/builtin-deepseek-tts.ts）。
 * 只钉「请求形状、返回与失败」——不联网，fetch 全程替身。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createDeepseekTtsProvider,
  DEEPSEEK_TTS_PROVIDER_ID,
  ensureDeepseekTtsProvider,
} from './builtin-deepseek-tts.ts';
import { resetVoiceProviders, resolveVoice } from './registry.ts';
import { validateVoiceProvider } from './types.ts';

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

afterEach(() => {
  resetVoiceProviders();
});

test('声明：通过注册校验，两个官方音色都是 provider 内 id', () => {
  const provider = createDeepseekTtsProvider({ resolveKey: async () => 'k' });
  assert.doesNotThrow(() => validateVoiceProvider(provider));
  assert.equal(provider.id, DEEPSEEK_TTS_PROVIDER_ID);
  assert.deepEqual(
    provider.voices.map((voice) => voice.id),
    ['stella', 'tide'],
  );
  assert.equal(provider.format, 'wav');
});

test('成功：把响应体原样交成字节', async () => {
  const stub = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  try {
    const provider = createDeepseekTtsProvider({ resolveKey: async () => 'secret' });
    const bytes = await provider.synthesize({ text: '你好', voice: 'stella', rate: 0 });
    assert.deepEqual([...bytes], [1, 2, 3]);
  } finally {
    stub.restore();
  }
});

test('请求：打到官方 TTS、带 Bearer、body 用 voice_id 而不是 voice', async () => {
  const stub = stubFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
  try {
    const provider = createDeepseekTtsProvider({ resolveKey: async () => 'secret' });
    await provider.synthesize({ text: '你好', voice: 'tide', rate: -10 });
    const call = stub.calls[0];
    assert.equal(call?.url, 'https://api.deepseek.com/v1/tools/tts');
    assert.equal((call?.init.headers as Record<string, string>).authorization, 'Bearer secret');
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    assert.equal(body.text, '你好');
    assert.equal(body.voice_id, 'tide');
    assert.equal(body.format, 'wav');
    assert.equal('rate' in body, false, '官方没有语速参数，不该出现在请求里');
  } finally {
    stub.restore();
  }
});

test('没有 API key：抛错，不发请求', async () => {
  const stub = stubFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
  try {
    const provider = createDeepseekTtsProvider({ resolveKey: async () => undefined });
    await assert.rejects(() => provider.synthesize({ text: '你好', voice: 'stella', rate: 0 }), /DEEPSEEK_API_KEY/);
    assert.equal(stub.calls.length, 0, '没 key 不该打网络');
  } finally {
    stub.restore();
  }
});

test('上游非 200：抛错并带上状态码', async () => {
  const stub = stubFetch(() => new Response('busy', { status: 503 }));
  try {
    const provider = createDeepseekTtsProvider({ resolveKey: async () => 'secret' });
    await assert.rejects(() => provider.synthesize({ text: '你好', voice: 'stella', rate: 0 }), /503/);
  } finally {
    stub.restore();
  }
});

test('ensure：注册一次，重复调用不覆盖', () => {
  ensureDeepseekTtsProvider({ resolveKey: async () => 'k' });
  const first = resolveVoice(`${DEEPSEEK_TTS_PROVIDER_ID}/stella`);
  assert.equal(first?.provider.name, 'DeepSeek');
  ensureDeepseekTtsProvider({ resolveKey: async () => 'other' });
  assert.equal(resolveVoice(`${DEEPSEEK_TTS_PROVIDER_ID}/stella`)?.provider, first?.provider);
});
