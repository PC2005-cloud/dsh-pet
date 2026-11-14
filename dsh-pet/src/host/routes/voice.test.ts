/**
 * 语音路由的契约测试（src/host/routes/voice.ts）。
 * 只断言协议层：方法判定、JSON 判定，以及把语音服务的结论映射成应答；不发真实请求。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PetRouteDeps } from './types.ts';
import { handleVoiceRoutes } from './voice.ts';

const CATALOG = {
  providers: [
    {
      id: 'edge',
      name: 'Edge',
      voices: [{ id: 'edge/zh-CN-XiaoxiaoNeural', name: '晓晓', tag: '女 · 通用' }],
    },
  ],
};

/** 识别实现的目录；`/voice/hear-providers` 与 `list()` 同源。 */
const SPEECH_CATALOG = { providers: [{ id: 'dsh', name: 'DSH 语音插件' }] };

/** 造最小依赖：只提供 voice 与 speech，其余字段这条路由不会碰。 */
function makeDeps(
  speak: (raw: unknown) => Promise<unknown>,
  hear: (raw: unknown, signal?: AbortSignal) => Promise<unknown> = async () => ({ ok: true, text: '你好' }),
): PetRouteDeps {
  return {
    voice: { list: () => CATALOG, speak },
    speech: { hear, list: () => SPEECH_CATALOG },
  } as unknown as PetRouteDeps;
}

/** 造一次路由输入。 */
function input(rest: string, method: string, body?: string) {
  return { url: new URL(`http://127.0.0.1:1/dsh-pet-7340/${rest}`), rest, method, body };
}

test('GET /voice/hear-providers：返回识别实现目录', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x.mp3', contentType: 'audio/mpeg' })),
    input('voice/hear-providers', 'GET'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.deepEqual(result.obj, { ok: true, ...SPEECH_CATALOG });
});

test('GET /voice/voices：按 provider 分组返回音色目录', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x.mp3', contentType: 'audio/mpeg' })),
    input('voice/voices', 'GET'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.deepEqual(result.obj, { ok: true, ...CATALOG });
});

test('POST /voice/speak 成功：交回音频文件与实现声明的 MIME', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/cache/a.mp3', contentType: 'audio/mpeg' })),
    input('voice/speak', 'POST', '{"text":"hi"}'),
  );
  assert.deepEqual(result, { kind: 'file', file: '/cache/a.mp3', contentType: 'audio/mpeg' });
});

test('POST /voice/speak 成功：WAV 实现的 MIME 原样透传，不在路由里写死', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/cache/a.wav', contentType: 'audio/wav' })),
    input('voice/speak', 'POST', '{"text":"hi"}'),
  );
  assert.deepEqual(result, { kind: 'file', file: '/cache/a.wav', contentType: 'audio/wav' });
});

test('POST /voice/speak 业务失败：200 + 失败实体（不做成 4xx）', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: false, reason: 'bad-request', message: 'nope' })),
    input('voice/speak', 'POST', '{"text":""}'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.equal((result.obj as { reason: string }).reason, 'bad-request');
});

test('POST /voice/speak 请求体不是 JSON：400', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/speak', 'POST', 'not json'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind === 'json') assert.equal(result.status, 400);
});

test('POST /voice/hear 成功：返回识别文字', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x.mp3' })),
    input('voice/hear', 'POST', '{"audio":"AAAA"}'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.deepEqual(result.obj, { ok: true, text: '你好' });
});

test('POST /voice/hear 业务失败：200 + 失败实体（与 /chat 同一口径）', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(
      async () => ({ ok: true, file: '/x.mp3' }),
      async () => ({
        ok: false,
        reason: 'unsupported',
        message: 'host has no speech provider enabled',
      }),
    ),
    input('voice/hear', 'POST', '{"audio":"AAAA"}'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.equal((result.obj as { reason: string }).reason, 'unsupported');
});

test('POST /voice/hear 请求体不是 JSON：400', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/hear', 'POST', 'nope'),
  );
  assert.equal(result?.kind === 'json' ? result.status : 0, 400);
});

test('POST /voice/hear 把断开信号交给识别服务', async () => {
  let received: AbortSignal | undefined;
  const abort = new AbortController();
  await handleVoiceRoutes(
    makeDeps(
      async () => ({ ok: true, file: '/x.mp3' }),
      async (_raw, signal) => {
        received = signal;
        return { ok: true, text: '好' };
      },
    ),
    { ...input('voice/hear', 'POST', '{"audio":"AAAA"}'), signal: abort.signal },
  );
  assert.equal(received, abort.signal, '调用方断开时识别应能中止');
});

test('方法不对：四个端点都是 405', async () => {
  const speak = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/speak', 'GET'),
  );
  assert.equal(speak?.kind === 'json' ? speak.status : 0, 405);
  const voices = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/voices', 'POST'),
  );
  assert.equal(voices?.kind === 'json' ? voices.status : 0, 405);
  const providers = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/hear-providers', 'POST'),
  );
  assert.equal(providers?.kind === 'json' ? providers.status : 0, 405);
  const hear = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/hear', 'GET'),
  );
  assert.equal(hear?.kind === 'json' ? hear.status : 0, 405);
});

test('不相干的路径：交回 undefined，让下一个处理器接手', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('state', 'GET'),
  );
  assert.equal(result, undefined);
});
