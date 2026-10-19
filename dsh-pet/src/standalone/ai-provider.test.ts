import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneAi } from './ai-provider.ts';
import { isolatedFetch } from './ai-transport.ts';
import { DEFAULT_AI_SETTINGS } from './ai-config.ts';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const config = {
  protocol: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  apiKey: 'test-secret',
  enabled: true,
};
const options = {
  provider: 'standalone',
  model: 'test-model',
  system: 'system',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
};
const collect = async (stream: AsyncIterable<{ text: string }>) => {
  const result: string[] = [];
  for await (const part of stream) result.push(part.text);
  return result.join('');
};

test('disabled model selection cannot be overridden; metadata and saves make no API calls', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-'));
  let calls = 0;
  const ai = createStandaloneAi(home, silent, {
    fetch: async () => {
      calls++;
      throw new Error('must not call');
    },
  });
  try {
    assert.deepEqual(ai.currentSelection(), { provider: 'standalone', model: '' });
    assert.deepEqual(ai.listProviders(), []);
    assert.deepEqual(await ai.listModels('standalone'), []);
    assert.equal(await ai.resolveModelInfo(), undefined);
    await assert.rejects(collect(ai.stream(options)), /not ready/);
    await ai.saveSettings(config);
    assert.equal(ai.isReady(), true);
    assert.equal(ai.canWhisper(), false);
    assert.deepEqual(ai.currentSelection(), { provider: 'standalone', model: 'test-model' });
    assert.equal((await ai.listModels('standalone'))[0].id, 'test-model');
    assert.equal((await ai.resolveModelInfo('standalone', 'test-model'))?.id, 'test-model');
    assert.equal(await ai.resolveModelInfo('other', 'test-model'), undefined);
    await assert.rejects(collect(ai.stream({ ...options, provider: 'other' })), /selection/);
    await assert.rejects(collect(ai.stream({ ...options, model: 'other' })), /selection/);
    assert.equal(calls, 0);
    ai.dispose();
    assert.equal(ai.isReady(), false);
  } finally {
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('official OpenAI SDK extracts fragmented text once, maps text history and pins transport', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-'));
  let request: RequestInit | undefined;
  let address = '';
  const ai = createStandaloneAi(home, silent, {
    fetch: async (url, init) => {
      address = String(url);
      request = init;
      const chunks = [
        { choices: [{ index: 0, delta: { content: 'hel', reasoning_content: 'secret-reasoning' } }] },
        { choices: [{ index: 0, delta: { content: 'lo' } }] },
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  try {
    await ai.saveSettings(config);
    assert.equal(await collect(ai.stream(options)), 'hello');
    assert.equal(address, 'https://example.test/v1/chat/completions');
    assert.equal(request?.redirect, 'error');
    const body = JSON.parse(String(request?.body));
    assert.equal(body.max_tokens, 1024);
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ]);
    const headers = new Headers(request?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-secret');
    assert.equal(headers.has('openai-organization'), false);
    assert.equal(JSON.stringify(body).includes('source'), false);
  } finally {
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

async function fixture(
  run: (ai: ReturnType<typeof createStandaloneAi>, home: string) => Promise<void>,
  fetcher: typeof fetch,
  protocol = 'openai-compatible',
  now?: () => number,
) {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-'));
  const ai = createStandaloneAi(home, silent, { fetch: fetcher, now });
  try {
    await ai.saveSettings({ ...config, protocol });
    await run(ai, home);
  } finally {
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}
const openAiResponse = (content: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });

test('auth failures are fixed/redacted and pause until explicit save, without SDK retries', async () => {
  let calls = 0;
  await fixture(
    async (ai) => {
      await assert.rejects(
        collect(ai.stream(options)),
        /^Error: Standalone AI authentication failed\. Check credentials and save settings again\.$/,
      );
      assert.equal(ai.isReady(), false);
      assert.equal(ai.currentSelection().model, '');
      await assert.rejects(collect(ai.stream(options)), /not ready/);
      assert.equal(calls, 1);
      await ai.saveSettings({});
      assert.equal(ai.isReady(), true);
    },
    async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'test-secret https://u:p@evil' } }), { status: 401 });
    },
  );
});

test('remote rate limits and API failures never reflect raw response text', async () => {
  for (const status of [429, 400, 500]) {
    await fixture(
      async (ai) => {
        await assert.rejects(
          collect(ai.stream(options)),
          status === 429
            ? /provider rate limit/
            : /^Error: Standalone AI request failed\. Check the endpoint and model settings\.$/,
        );
        assert.equal(ai.isReady(), true);
      },
      async () => new Response('test-secret', { status }),
    );
  }
});

test('input, empty/nontext output, and response output caps are enforced before/while streaming', async () => {
  await fixture(
    async (ai) => {
      for (const patch of [
        { messages: [] },
        { messages: [{ role: 'user', content: [{ type: 'text', text: 123 }] }] },
        { system: 'x'.repeat(32768) },
        { messages: [{ role: 'assistant', content: 'invalid' }] },
      ]) {
        await assert.rejects(collect(ai.stream({ ...options, ...patch })), /input|limits/);
      }
      await assert.rejects(collect(ai.stream(options)), /returned no text/);
    },
    async () => openAiResponse(''),
  );
  await fixture(
    async (ai) => {
      await assert.rejects(collect(ai.stream(options)), /response exceeds limits/);
    },
    async () => openAiResponse('x'.repeat(16385)),
  );
});

test('text history ignores nontext/source data; provider-global rate limits reset only with time', async () => {
  let time = 0;
  await fixture(
    async (ai) => {
      const history = [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'not-sent' },
            { type: 'text', text: 'first' },
          ],
        },
        { role: 'assistant', content: 'reply' },
        ...options.messages,
      ];
      for (let n = 0; n < 6; n++)
        assert.equal(await collect(ai.stream({ ...options, messages: history, sessionId: String(n) })), 'ok');
      await assert.rejects(collect(ai.stream(options)), /rate limit/);
      await ai.saveSettings({ automaticWhispers: true });
      assert.equal(ai.canWhisper(), true);
      await assert.rejects(collect(ai.stream(options)), /rate limit/);
      time = 60001;
      assert.equal(await collect(ai.stream(options)), 'ok');
    },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(JSON.stringify(body).includes('not-sent'), false);
      return openAiResponse('ok');
    },
    'openai-compatible',
    () => time,
  );
});

test('abort, save changes, and dispose cancel in-flight requests; concurrency stays bounded', async () => {
  for (const mode of ['abort', 'save', 'dispose']) {
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    await fixture(
      async (ai) => {
        const controller = new AbortController();
        const outcome = collect(ai.stream({ ...options, signal: controller.signal }));
        const rejected = assert.rejects(outcome, /cancelled|timed out/);
        await start;
        await assert.rejects(collect(ai.stream(options)), /busy/);
        if (mode === 'abort') controller.abort();
        if (mode === 'save') await ai.saveSettings({ enabled: false });
        if (mode === 'dispose') ai.dispose();
        await rejected;
        if (mode !== 'abort') assert.equal(ai.isReady(), false);
        if (mode === 'dispose') await assert.rejects(ai.saveSettings({}), /disposed/);
      },
      async (_url, init) => {
        started();
        return await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('test-secret')), { once: true }),
        );
      },
    );
  }
});

test('wall-clock timeout also bounds a transport ignoring cancellation', async () => {
  await fixture(
    async (ai) => {
      await ai.saveSettings({ timeoutMs: 1000 });
      await assert.rejects(collect(ai.stream(options)), /timed out/);
    },
    async () => await new Promise<Response>(() => {}),
  );
});

test('Anthropic protocol uses explicit key, adaptive Opus without sampling, ignores thinking and refuses cleanly', async () => {
  for (const refused of [false, true]) {
    await fixture(
      async (ai) => {
        await ai.saveSettings({ baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' });
        const stream = ai.stream({ ...options, model: 'claude-opus-5-5' });
        if (refused) await assert.rejects(collect(stream), /could not answer/);
        else assert.equal(await collect(stream), 'hello');
      },
      async (url, init) => {
        assert.equal(String(url), 'https://api.anthropic.com/v1/messages?beta=true');
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.thinking, { type: 'adaptive' });
        assert.equal(body.temperature, undefined);
        assert.equal(body.fallbacks, 'default');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('x-api-key'), 'test-secret');
        assert.equal(headers.has('authorization'), false);
        const events = [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
          {
            type: 'message_delta',
            delta: { stop_reason: refused ? 'refusal' : 'end_turn' },
            usage: { output_tokens: 5 },
          },
        ];
        return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
      'anthropic',
    );
  }
});

test('redirects are disabled and unexpected SDK endpoints are rejected; custom Anthropic has no beta', async () => {
  const settings = { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://example.test/v1', apiKey: 'test-secret' };
  let calls = 0;
  const transport = isolatedFetch(settings, async () => {
    calls++;
    return new Response('');
  });
  await assert.rejects(transport('https://evil.test', {}), /Unexpected/);
  assert.equal(calls, 0);
  await fixture(
    async (ai) => {
      await ai.saveSettings({ model: 'custom-claude' });
      await assert.rejects(collect(ai.stream({ ...options, model: 'custom-claude' })), /returned no text/);
    },
    async (_url, init) => {
      assert.equal(new Headers(init?.headers).has('anthropic-beta'), false);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.thinking, undefined);
      assert.equal(body.fallbacks, undefined);
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    },
    'anthropic',
  );
});

test('testConnection checks parameters and reports success or friendly error', async () => {
  await fixture(
    async (ai) => {
      assert.deepEqual(await ai.testConnection({ baseUrl: '', model: 'm', apiKey: 'k' }), {
        ok: false,
        message: '请先填写接口地址（Base URL）',
      });
      assert.deepEqual(await ai.testConnection({ baseUrl: 'https://example.test/v1', model: '', apiKey: 'k' }), {
        ok: false,
        message: '请先填写模型名称',
      });
      await ai.saveSettings({ clearApiKey: true, enabled: false });
      assert.deepEqual(await ai.testConnection({ baseUrl: 'https://example.test/v1', model: 'm', apiKey: '' }), {
        ok: false,
        message: '请先填写 API 密钥',
      });
      const success = await ai.testConnection({
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
        apiKey: 'test-key',
      });
      assert.equal(success.ok, true);
      assert.match(success.message, /连接成功/);
      assert.equal(success.reply, 'ok');
    },
    async () => {
      const chunk = { choices: [{ delta: { content: 'ok' }, index: 0 }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  );

  await fixture(
    async (ai) => {
      const failure = await ai.testConnection({
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
        apiKey: 'bad-key',
      });
      assert.equal(failure.ok, false);
      assert.match(failure.message, /401/);
    },
    async () => {
      return new Response('Unauthorized', { status: 401 });
    },
  );
});
