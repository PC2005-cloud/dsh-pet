/**
 * 语音服务的行为测试（src/host/voice/speak.ts）。
 * 合成实现由用例注册的假 provider 提供：默认套件不联网，只钉编排与边界。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resetVoiceProviders, registerVoiceProvider } from './registry.ts';
import { MAX_TEXT_CHARS, createVoiceService, isQueueStale, type VoiceService } from './speak.ts';
import type { SynthInput, VoiceFormat, VoiceProvider } from './types.ts';

/** 一次用例要装的实现选项。 */
interface ServiceOptions {
  /** 合成行为；缺省返回一字节占位音频。 */
  synthesize?: (input: SynthInput) => Promise<Uint8Array>;
  format?: VoiceFormat;
  timeoutMs?: number;
  /** 请求不带 voice 时读到的配置值；缺省 `demo/v1`。 */
  configuredVoice?: () => string | undefined;
  staleWaitMs?: number;
}

/** 造一个隔离的语音服务：注册一个 id 为 `demo` 的假实现，用完复位注册表。 */
async function withService(
  run: (voice: VoiceService, root: string) => Promise<void>,
  options: ServiceOptions = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-svc-'));
  const provider: VoiceProvider = {
    id: 'demo',
    name: '演示',
    voices: [
      { id: 'v1', name: '音色一' },
      { id: 'v2', name: '音色二' },
    ],
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    synthesize: options.synthesize ?? (async () => new Uint8Array([1])),
  };
  registerVoiceProvider(provider);
  try {
    const voice = createVoiceService({
      userRoot: root,
      configuredVoice: options.configuredVoice ?? (() => 'demo/v1'),
      ...(options.staleWaitMs === undefined ? {} : { staleWaitMs: options.staleWaitMs }),
    });
    await run(voice, root);
  } finally {
    resetVoiceProviders();
    // 排队用例里可能有合成仍在写盘：带重试的删除，否则偶发 ENOTEMPTY
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/** 轮询直到条件成立；用 setImmediate 推进，不依赖固定睡眠时长。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('等待条件超时');
}

test('text 为空或全空白：判 bad-request 且不调用合成', () =>
  withService(
    async (voice) => {
      const result = await voice.speak({ text: '   ' });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'bad-request');
    },
    {
      synthesize: async () => {
        assert.fail('非法请求不能进入合成流程');
      },
    },
  ));

test('text 超过上限：判 bad-request，不做截断', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '中'.repeat(MAX_TEXT_CHARS + 1) });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /too long/);
  }));

test('voice 解析不到：判 bad-request，消息里带原值', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '你好', voice: 'demo/nope' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'bad-request');
    assert.match(result.ok === false ? result.message : '', /voice not found: demo\/nope/);
  }));

test('voice 是裸 id（没有 provider 前缀）：判 bad-request，不做隐式归属', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '你好', voice: 'v1' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /voice not found: v1/);
  }));

test('voice 不是字符串：判 bad-request', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '你好', voice: 1 });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /voice must be a string/);
  }));

test('请求和配置都没有音色：判 bad-request', () =>
  withService(
    async (voice) => {
      const result = await voice.speak({ text: '你好' });
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.message : '', /voice is required/);
    },
    { configuredVoice: () => undefined },
  ));

test('rate 格式不合法：判 bad-request', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '你好', rate: '10%' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /rate/);
  }));

for (const rate of ['-51%', '-60%', '-100%', '-101%', '-999%', '+101%', '+999%']) {
  test(`rate 超出 -50%..+100%：${rate} 判 bad-request 且不调用合成`, () =>
    withService(
      async (voice) => {
        const result = await voice.speak({ text: '你好', rate });
        assert.equal(result.ok, false);
        assert.match(result.ok === false ? result.message : '', /rate out of range/);
      },
      {
        synthesize: async () => {
          assert.fail('非法语速不能进入合成流程');
        },
      },
    ));
}

for (const [rate, expected] of [
  ['-50%', -50],
  ['-10%', -10],
  ['-0%', 0],
  ['+0%', 0],
  ['+100%', 100],
] as const) {
  test(`rate 位于允许范围：${rate} 解析成 ${expected} 交给实现`, async () => {
    let received: number | undefined;
    await withService(
      async (voice) => {
        const result = await voice.speak({ text: '你好', rate });
        assert.equal(result.ok, true);
        assert.equal(received, expected);
      },
      {
        synthesize: async (input) => {
          received = input.rate;
          return new Uint8Array([1]);
        },
      },
    );
  });
}

test('合法请求：mp3 落盘在 voice-cache 下，应答 MIME 由实现格式决定', () =>
  withService(async (voice, root) => {
    const result = await voice.speak({ text: '今天也要加油哦' });
    assert.equal(result.ok, true);
    const file = result.ok ? result.file : '';
    assert.ok(file.startsWith(join(root, 'voice-cache')), '必须落在 voice-cache 下');
    assert.ok(file.endsWith('.mp3'));
    assert.equal(result.ok ? result.contentType : '', 'audio/mpeg');
  }));

test('声明 WAV 的实现：扩展名与 MIME 跟着换，不写死 mp3', () =>
  withService(
    async (voice) => {
      const result = await voice.speak({ text: '你好' });
      const file = result.ok ? result.file : '';
      assert.ok(file.endsWith('.wav'));
      assert.equal(result.ok ? result.contentType : '', 'audio/wav');
    },
    { format: 'wav' },
  ));

test('不传 voice 时用配置值；传了就以请求为准', async () => {
  const seen: string[] = [];
  await withService(
    async (voice) => {
      await voice.speak({ text: '配置值' });
      await voice.speak({ text: '显式值', voice: 'demo/v2' });
      assert.deepEqual(seen, ['v1', 'v2'], '先按配置取 v1，再按请求取 v2');
    },
    {
      synthesize: async (input) => {
        seen.push(input.voice);
        return new Uint8Array([1]);
      },
    },
  );
});

test('传给实现的 text 已 trim、voice 去掉了 provider 前缀', async () => {
  let received: { text: string; voice: string } | undefined;
  await withService(
    async (voice) => {
      await voice.speak({ text: '  你好  ', voice: 'demo/v2' });
      assert.deepEqual(received, { text: '你好', voice: 'v2' });
    },
    {
      synthesize: async (input) => {
        received = { text: input.text, voice: input.voice };
        return new Uint8Array([1]);
      },
    },
  );
});

test('同一输入第二次：命中缓存，不再调用实现', async () => {
  let calls = 0;
  await withService(
    async (voice) => {
      await voice.speak({ text: '同一句话' });
      const second = await voice.speak({ text: '同一句话' });
      assert.equal(second.ok, true);
      assert.equal(calls, 1, '第二次必须命中缓存');
    },
    {
      synthesize: async () => {
        calls += 1;
        return new Uint8Array([1, 2, 3]);
      },
    },
  );
});

test('不同音色不共享缓存：换音色会重新合成', async () => {
  let calls = 0;
  await withService(
    async (voice) => {
      await voice.speak({ text: '同一句话', voice: 'demo/v1' });
      await voice.speak({ text: '同一句话', voice: 'demo/v2' });
      assert.equal(calls, 2, '音频内容不同，不能复用同一个文件');
    },
    {
      synthesize: async () => {
        calls += 1;
        return new Uint8Array([1]);
      },
    },
  );
});

test('实现抛错：判 generate-error，不把上游细节回给调用方', () =>
  withService(
    async (voice) => {
      const result = await voice.speak({ text: '你好' });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'generate-error');
      assert.doesNotMatch(result.ok === false ? result.message : '', /https?:/, '不许回显上游地址');
    },
    {
      synthesize: async () => {
        throw new Error('upstream 403 from https://example.invalid');
      },
    },
  ));

test('实现返回空字节：判 generate-error，且不留下半截文件', () =>
  withService(
    async (voice, root) => {
      const result = await voice.speak({ text: '你好' });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'generate-error');
      const files = await readdir(join(root, 'voice-cache')).catch(() => [] as string[]);
      assert.deepEqual(files, [], '失败不该留下 0 字节文件或 .part');
    },
    { synthesize: async () => new Uint8Array() },
  ));

test('实现超过 timeoutMs 不返回：判 generate-error', () =>
  withService(
    async (voice) => {
      const result = await voice.speak({ text: '卡住' });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'generate-error');
    },
    {
      timeoutMs: 20,
      synthesize: () => new Promise<Uint8Array>(() => undefined),
    },
  ));

test('队列已满：后续请求判 voice-busy，而不是无限排队', () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return withService(
    async (voice) => {
      let settled = 0;
      const calls = ['a', 'b', 'c', 'd', 'e'].map((text) =>
        voice.speak({ text }).then((result) => {
          settled += 1;
          return result;
        }),
      );
      await waitFor(() => settled >= 2);
      release();
      const results = await Promise.all(calls);
      const busy = results.filter((result) => !result.ok && result.reason === 'voice-busy');
      assert.ok(busy.length >= 1, '至少有一个请求应被判为 voice-busy');
    },
    {
      synthesize: async () => {
        await gate;
        return new Uint8Array([1]);
      },
    },
  );
});

test('isQueueStale —— 排队久了就丢弃', () => {
  assert.equal(isQueueStale(1_000, 1_000), false, '刚轮到自己不算久');
  assert.equal(isQueueStale(1_000, 1_000 + 28_000), false, '正好到上限仍在容许范围内');
  assert.equal(isQueueStale(1_000, 1_000 + 28_001), true, '超过上限就该丢');
});

test('排队等到客户端早已放弃：直接丢弃，不再白合成一次', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await withService(
    async (voice) => {
      try {
        const first = voice.speak({ text: '第一句' });
        await waitFor(() => calls === 1);
        const second = voice.speak({ text: '第二句' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        const [kept, dropped] = await Promise.all([first, second]);
        assert.equal(kept.ok, true, '排在第一的照常合成');
        assert.equal(dropped.ok === false ? dropped.reason : '', 'voice-busy');
        assert.match(dropped.ok === false ? dropped.message : '', /queued too long/);
        assert.equal(calls, 1, '被丢弃的那句不能再合成');
      } finally {
        release();
      }
    },
    {
      staleWaitMs: 0,
      synthesize: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return new Uint8Array([1]);
      },
    },
  );
});
