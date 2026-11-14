/**
 * 语音识别服务的行为测试（src/host/voice/hear.ts）。
 *
 * 只断言服务自己的规则：输入校验、provider 解析、超时与失败分类；
 * 不发真实请求、不碰音频格式（格式由实现自己校验）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_AUDIO_BYTES, createHearService, type HearService } from './hear.ts';
import { registerSpeechProvider, resetSpeechProviders } from './speech-registry.ts';
import { SpeechUnavailableError, type SpeechInput } from './speech-types.ts';

/** 一段假音频：服务不做格式校验，内容随意。 */
const AUDIO = new Uint8Array([1, 2, 3, 4]);

/** 按渲染端的形态把字节编成 base64。 */
const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** 一次 transcribe 的实参记录。 */
interface TranscribeCall {
  readonly audio: Uint8Array;
  readonly signal?: AbortSignal;
}

/** 一次用例要装的实现选项。 */
interface ProviderOptions {
  /** 识别行为；缺省返回固定文字。 */
  transcribe?: (input: SpeechInput) => Promise<unknown>;
  /** 实现内声明的超时。 */
  providerTimeoutMs?: number;
  /** 服务级超时（测试注入）。 */
  timeoutMs?: number;
  /** 请求不带 provider 时读到的配置值；缺省 `demo`。 */
  configuredProvider?: () => string | undefined;
  /** 实现 id；缺省 `demo`。 */
  id?: string;
}

/** 造一个隔离的识别服务：注册一个假实现，用完复位注册表。 */
async function withProvider(run: (hear: HearService) => Promise<void>, options: ProviderOptions = {}): Promise<void> {
  const id = options.id ?? 'demo';
  registerSpeechProvider({
    id,
    name: id,
    ...(options.providerTimeoutMs === undefined ? {} : { timeoutMs: options.providerTimeoutMs }),
    transcribe: (options.transcribe ?? (async () => '你好')) as (input: SpeechInput) => Promise<string>,
  });
  try {
    const hear = createHearService({
      configuredProvider: options.configuredProvider ?? (() => id),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    await run(hear);
  } finally {
    resetSpeechProviders();
  }
}

test('缺 audio：bad-request，且不调用实现', () =>
  withProvider(
    async (hear) => {
      const result = await hear.hear({});
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'bad-request');
    },
    {
      transcribe: async () => {
        assert.fail('非法输入不能进入识别流程');
      },
    },
  ));

test('audio 不是 base64：bad-request', () =>
  withProvider(async (hear) => {
    const result = await hear.hear({ audio: 'not base64!!' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /base64/);
  }));

test('audio 超过上限：bad-request，不做截断', () =>
  withProvider(async (hear) => {
    const result = await hear.hear({ audio: encode(new Uint8Array(MAX_AUDIO_BYTES + 1)) });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /too large/);
  }));

test('provider 不是字符串：bad-request', () =>
  withProvider(async (hear) => {
    const result = await hear.hear({ audio: encode(AUDIO), provider: 1 });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /provider must be/);
  }));

test('请求和配置都没有 provider：bad-request', () =>
  withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.message : '', /provider is required/);
    },
    { configuredProvider: () => undefined },
  ));

test('provider 解析不到：bad-request，消息里带原值，不做隐式兜底', () =>
  withProvider(async (hear) => {
    const result = await hear.hear({ audio: encode(AUDIO), provider: 'missing' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'bad-request');
    assert.match(result.ok === false ? result.message : '', /provider not found: missing/);
  }));

test('不传 provider 时用配置值；传了就以请求为准', async () => {
  const calls: string[] = [];
  for (const id of ['from-config', 'from-request']) {
    registerSpeechProvider({
      id,
      name: id,
      transcribe: async () => {
        calls.push(id);
        return '好';
      },
    });
  }
  try {
    const hear = createHearService({ configuredProvider: () => 'from-config' });
    await hear.hear({ audio: encode(AUDIO) });
    await hear.hear({ audio: encode(AUDIO), provider: 'from-request' });
    assert.deepEqual(calls, ['from-config', 'from-request'], '第一次走配置，第二次走请求');
  } finally {
    resetSpeechProviders();
  }
});

test('传给实现的 audio 是解码后的字节，signal 是宿主给的', async () => {
  let received: TranscribeCall | undefined;
  await withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.equal(result.ok, true);
      assert.deepEqual(received?.audio, AUDIO);
      assert.equal(received?.signal instanceof AbortSignal, true, '实现应能拿到中止信号');
    },
    {
      transcribe: async (input) => {
        received = { audio: input.audio, signal: input.signal };
        return '好';
      },
    },
  );
});

test('成功：原样返回实现给的文字，空串也是合法结果', async () => {
  await withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.deepEqual(result, { ok: true, text: '' }, '空串表示这段没人说话');
    },
    { transcribe: async () => '' },
  );
});

test('实现抛 SpeechUnavailableError：unsupported，而不是识别失败', () =>
  withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'unsupported');
    },
    {
      transcribe: async () => {
        throw new SpeechUnavailableError('host has no speech-to-text service');
      },
    },
  ));

test('实现抛普通错误：generate-error', () =>
  withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'generate-error');
    },
    {
      transcribe: async () => {
        throw new Error('model crashed');
      },
    },
  ));

test('实现返回非字符串：generate-error，不把对象当文字发出去', () =>
  withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'generate-error');
      assert.match(result.ok === false ? result.message : '', /invalid transcript/);
    },
    { transcribe: async () => ({ text: '好' }) },
  ));

test('实现超过超时：generate-error，且 signal 被 abort', async () => {
  let aborted = false;
  await withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'generate-error');
      assert.equal(aborted, true, '超时应当中止实现');
    },
    {
      timeoutMs: 20,
      transcribe: (input) =>
        new Promise(() => {
          input.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    },
  );
});

test('实现声明的 timeoutMs 优先于服务缺省', async () => {
  let aborted = false;
  const startedMs = Date.now();
  await withProvider(
    async (hear) => {
      const result = await hear.hear({ audio: encode(AUDIO) });
      assert.equal(result.ok, false, '20ms 后应判失败');
      assert.ok(Date.now() - startedMs < 1_000, '走的是实现的 20ms，不是服务的 10s');
    },
    {
      providerTimeoutMs: 20,
      timeoutMs: 10_000,
      transcribe: (input) =>
        new Promise(() => {
          input.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    },
  );
  assert.equal(aborted, true);
});

test('list()：返回注册表里的实现目录', () =>
  withProvider(async (hear) => {
    assert.deepEqual(hear.list(), { providers: [{ id: 'demo', name: 'demo' }] });
  }));
