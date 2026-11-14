/**
 * 内置 dsh 识别实现的契约测试（src/host/voice/builtin-dsh.ts）。
 *
 * 只钉「它怎么读宿主服务、三种不可用怎么分类、返回什么」——真实识别不在默认套件里跑。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createDshSpeechProvider, DSH_SPEECH_PROVIDER_ID, ensureDshSpeechProvider } from './builtin-dsh.ts';
import { resetSpeechProviders, resolveSpeechProvider } from './speech-registry.ts';
import { SpeechUnavailableError, validateSpeechProvider, type SpeechProvider } from './speech-types.ts';

/** 一段假音频：实现不做格式校验。 */
const AUDIO = new Uint8Array([1, 2, 3]);

/** 一次 resolve 的实参记录。 */
interface ResolveCall {
  readonly audio: Uint8Array;
}

/** 造假宿主服务：登记表、就绪状态与转写都可替身。 */
function makeSpeech(
  overrides: {
    providers?: readonly unknown[];
    phase?: string;
    transcribe?: (spec: unknown, signal: AbortSignal) => Promise<{ text?: unknown }>;
  } = {},
): { service: unknown; calls: ResolveCall[] } {
  const calls: ResolveCall[] = [];
  const service = {
    listProviders: () => overrides.providers ?? [{ id: 'sensevoice' }],
    snapshot: () => ({
      providers: [{ id: 'sensevoice', preparation: { phase: overrides.phase ?? 'ready' } }],
    }),
    resolve: (request: ResolveCall) => {
      calls.push(request);
      return { pinned: request };
    },
    transcribe: overrides.transcribe ?? (async () => ({ text: '你好' })),
  };
  return { service, calls };
}

/** 用给定宿主服务造一个实现。 */
function providerWith(service: unknown): SpeechProvider {
  return createDshSpeechProvider({ speechToText: () => service });
}

afterEach(() => {
  resetSpeechProviders();
});

test('声明：通过注册校验，id 是 dsh，展示名带来源', () => {
  const provider = providerWith(makeSpeech().service);
  assert.doesNotThrow(() => validateSpeechProvider(provider));
  assert.equal(provider.id, DSH_SPEECH_PROVIDER_ID);
  assert.equal(provider.name, 'DSH 语音插件');
});

test('成功：返回宿主给的文字', async () => {
  const { service } = makeSpeech();
  assert.equal(await providerWith(service).transcribe({ audio: AUDIO }), '你好');
});

test('成功：把整段音频交给宿主的 resolve，不做切片', async () => {
  const { service, calls } = makeSpeech();
  await providerWith(service).transcribe({ audio: AUDIO });
  assert.deepEqual(calls[0]?.audio, AUDIO);
});

test('空串是合法结果：这段没人说话', async () => {
  const { service } = makeSpeech({ transcribe: async () => ({ text: '' }) });
  assert.equal(await providerWith(service).transcribe({ audio: AUDIO }), '');
});

test('宿主没有识别服务：抛 SpeechUnavailableError', async () => {
  const provider = createDshSpeechProvider({ speechToText: () => undefined });
  await assert.rejects(() => provider.transcribe({ audio: AUDIO }), SpeechUnavailableError);
});

test('宿主没有启用识别插件：抛 SpeechUnavailableError', async () => {
  const { service } = makeSpeech({ providers: [] });
  await assert.rejects(() => providerWith(service).transcribe({ audio: AUDIO }), SpeechUnavailableError);
});

test('识别器待机（资源就绪、录音时才唤醒）：可用', async () => {
  const { service } = makeSpeech({ phase: 'standby' });
  assert.equal(await providerWith(service).transcribe({ audio: AUDIO }), '你好');
});

test('识别器未就绪（首次使用要下模型）：抛 SpeechUnavailableError', async () => {
  const { service } = makeSpeech({ phase: 'downloading' });
  await assert.rejects(() => providerWith(service).transcribe({ audio: AUDIO }), SpeechUnavailableError);
});

test('宿主返回非字符串：普通错误，交给上层归成 generate-error', async () => {
  const { service } = makeSpeech({ transcribe: async () => ({ text: 42 }) });
  await assert.rejects(
    () => providerWith(service).transcribe({ audio: AUDIO }),
    (error: unknown) => error instanceof Error && !(error instanceof SpeechUnavailableError),
  );
});

test('宿主转写抛错：原样向上抛，不吞成成功', async () => {
  const { service } = makeSpeech({
    transcribe: async () => {
      throw new Error('worker crashed');
    },
  });
  await assert.rejects(() => providerWith(service).transcribe({ audio: AUDIO }), /worker crashed/);
});

test('ensureDshSpeechProvider：注册一次，重复调用不覆盖也不抛错', () => {
  const { service } = makeSpeech();
  ensureDshSpeechProvider({ speechToText: () => service });
  const first = resolveSpeechProvider(DSH_SPEECH_PROVIDER_ID);
  assert.equal(first?.name, 'DSH 语音插件');

  ensureDshSpeechProvider({ speechToText: () => makeSpeech().service });
  assert.equal(resolveSpeechProvider(DSH_SPEECH_PROVIDER_ID), first, '第二次调用不该换掉已有实现');
});

test('ensureDshSpeechProvider：复位后可重新登记', () => {
  ensureDshSpeechProvider({ speechToText: () => makeSpeech().service });
  resetSpeechProviders();
  assert.equal(resolveSpeechProvider(DSH_SPEECH_PROVIDER_ID), undefined);
  ensureDshSpeechProvider({ speechToText: () => makeSpeech().service });
  assert.equal(resolveSpeechProvider(DSH_SPEECH_PROVIDER_ID)?.id, DSH_SPEECH_PROVIDER_ID);
});
