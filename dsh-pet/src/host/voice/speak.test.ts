/**
 * 语音服务的行为测试（src/host/voice/speak.ts）。
 * 合成实现由用例注入：默认套件不联网，只有边界与编排逻辑被钉住。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BreezeSynthInput } from './breeze.ts';
import { VoiceSynthError, type SynthInput } from './edge.ts';
import { registerVoiceProvider } from './registry.ts';
import { MAX_TEXT_CHARS, createVoiceService, isQueueStale, type BreezeSettings, type VoiceService } from './speak.ts';

/** 造一个隔离的语音服务；`synthesize` 缺省写一个假 mp3。 */
async function withService(
  run: (voice: VoiceService, root: string) => Promise<void>,
  synthesize?: (input: SynthInput) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-svc-'));
  try {
    const voice = createVoiceService({
      userRoot: root,
      synthesize: synthesize ?? ((input) => writeFile(input.target, Buffer.from('mp3'))),
    });
    await run(voice, root);
  } finally {
    await rm(root, { recursive: true, force: true });
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
  withService(async (voice) => {
    const result = await voice.speak({ text: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'bad-request');
  }));

test('text 超过上限：判 bad-request，不做截断', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '中'.repeat(MAX_TEXT_CHARS + 1) });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'bad-request');
    assert.match(result.ok === false ? result.message : '', /too long/);
  }));

test('voice 不在白名单：判 bad-request 并列出合法值', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '你好', voice: 'zh-CN-NopeNeural' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /zh-CN-XiaoxiaoNeural/);
  }));

test('rate 格式不合法：判 bad-request', () =>
  withService(async (voice) => {
    const result = await voice.speak({ text: '你好', rate: '10%' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /rate/);
  }));

test('合法请求：返回 mp3 路径，文件确实落盘', () =>
  withService(async (voice, root) => {
    const result = await voice.speak({ text: '今天也要加油哦' });
    assert.equal(result.ok, true);
    const file = result.ok ? result.file : '';
    assert.ok(file.startsWith(join(root, 'voice-cache')), '必须落在 voice-cache 下');
    assert.ok(file.endsWith('.mp3'));
  }));

test('同一输入第二次：命中缓存，不再调用合成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-hit-'));
  try {
    let calls = 0;
    const voice = createVoiceService({
      userRoot: root,
      synthesize: async (input) => {
        calls += 1;
        await writeFile(input.target, Buffer.from('mp3'));
      },
    });
    await voice.speak({ text: '同一句话' });
    const second = await voice.speak({ text: '同一句话' });
    assert.equal(second.ok, true);
    assert.equal(calls, 1, '第二次必须命中缓存');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('合成失败：判 generate-error，不把上游细节回给调用方', () =>
  withService(
    async (voice) => {
      const result = await voice.speak({ text: '你好' });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'generate-error');
      assert.doesNotMatch(result.ok === false ? result.message : '', /https?:/, '不许回显上游地址');
    },
    async () => {
      throw new VoiceSynthError('upstream 403 from https://example.invalid');
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
    () => gate,
  );
});

test('isQueueStale —— 排队久了就丢弃', () => {
  assert.equal(isQueueStale(1_000, 1_000), false, '刚轮到自己不算久');
  assert.equal(isQueueStale(1_000, 1_000 + 28_000), false, '正好到上限仍在容许范围内');
  assert.equal(isQueueStale(1_000, 1_000 + 28_001), true, '超过上限就该丢');
});

test('排队等到客户端早已放弃：直接丢弃，不再白合成一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-stale-'));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const voice = createVoiceService({
    userRoot: root,
    staleWaitMs: 0,
    synthesize: async (input) => {
      calls += 1;
      if (calls === 1) await gate; // 第一句占住串行链，第二句才排得上队
      await writeFile(input.target, Buffer.from('mp3'));
    },
  });
  try {
    const first = voice.speak({ text: '第一句' }); // 拿着队列不放
    await waitFor(() => calls === 1);
    const second = voice.speak({ text: '第二句' }); // 排在它后面
    await new Promise((resolve) => setTimeout(resolve, 10)); // 让排队时间真的过去一点
    release();
    const [kept, dropped] = await Promise.all([first, second]);
    assert.equal(kept.ok, true, '排在第一的照常合成');
    assert.equal(dropped.ok === false ? dropped.reason : '', 'voice-busy');
    assert.match(dropped.ok === false ? dropped.message : '', /queued too long/);
    assert.equal(calls, 1, '被丢弃的那句不能再调合成');
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test('注册了第三方实现：合成走它，内置一次都不调', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-provider-'));
  let edgeCalls = 0;
  let providerCalls = 0;
  const dispose = registerVoiceProvider({
    id: 'my-tts',
    name: '我的语音',
    synthesize: async () => {
      providerCalls += 1;
      return new Uint8Array([1, 2, 3]);
    },
  });
  try {
    const voice = createVoiceService({
      userRoot: root,
      synthesize: async () => {
        edgeCalls += 1;
      },
    });
    const result = await voice.speak({ text: '你好' });
    assert.equal(result.ok, true);
    assert.equal(providerCalls, 1, '应该走第三方实现');
    assert.equal(edgeCalls, 0, '注册之后不该再调内置');
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('第三方返回空字节：判 generate-error，不留下 0 字节文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-empty-'));
  const dispose = registerVoiceProvider({ id: 'my-tts', name: '我的语音', synthesize: async () => new Uint8Array() });
  try {
    const voice = createVoiceService({ userRoot: root, synthesize: async () => undefined });
    const result = await voice.speak({ text: '你好' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'generate-error');
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
  }
});

/** 一份可用的 Breeze 配置。 */
const BREEZE: BreezeSettings = { apiKey: 'brz_test', voiceId: 'voc_8yud7hz7c9q2', languageCode: 'zh' };

test('Breeze 来源：按配置传音色、密钥、语种，并把语速换算成倍率', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-breeze-'));
  const seen: BreezeSynthInput[] = [];
  try {
    const voice = createVoiceService({
      userRoot: root,
      breeze: () => BREEZE,
      synthesizeBreeze: async (input) => {
        seen.push(input);
        await writeFile(input.target, Buffer.from('mp3'));
      },
      synthesize: async () => {
        assert.fail('选了 breeze 就不该再走 edge');
      },
    });
    const result = await voice.speak({ text: '你好', rate: '+50%' });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].voiceId, 'voc_8yud7hz7c9q2');
    assert.equal(seen[0].apiKey, 'brz_test');
    assert.equal(seen[0].languageCode, 'zh');
    assert.equal(seen[0].speed, 1.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Breeze 来源：voice 合法域是 voc_ 形状；收到 edge 音色名时按「未指定」处理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-breeze-voice-'));
  const seen: BreezeSynthInput[] = [];
  try {
    const voice = createVoiceService({
      userRoot: root,
      breeze: () => BREEZE,
      synthesizeBreeze: async (input) => {
        seen.push(input);
        await writeFile(input.target, Buffer.from('mp3'));
      },
    });
    const custom = await voice.speak({ text: '你好', voice: 'voc_other1234' });
    assert.equal(custom.ok, true, '自建音色应当放行');
    assert.equal(seen[0].voiceId, 'voc_other1234');
    // 端上会把配置里的 voiceName（edge 白名单音色）原样回传；breeze 下它不算错误，
    // 否则切到 breeze 后每句都会被判 bad-request，表现为「配了但完全没声音」。
    const edgeName = await voice.speak({ text: '你好', voice: 'zh-CN-XiaoxiaoNeural' });
    assert.equal(edgeName.ok, true);
    assert.equal(seen[1].voiceId, BREEZE.voiceId, 'edge 音色名应回落配置里的 Breeze 音色');
    const nonsense = await voice.speak({ text: '你好', voice: 'not-a-voice' });
    assert.equal(nonsense.ok, false);
    assert.equal(nonsense.ok === false ? nonsense.reason : '', 'bad-request');
    assert.match(nonsense.ok === false ? nonsense.message : '', /voc_/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('选了 breeze 但没配密钥：回落 edge，且告警只打一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-nokey-'));
  const warns: string[] = [];
  let edgeCalls = 0;
  let breezeCalls = 0;
  try {
    const voice = createVoiceService({
      userRoot: root,
      log: { warn: (message) => warns.push(message) },
      breeze: () => ({ apiKey: '', voiceId: 'voc_8yud7hz7c9q2' }),
      synthesize: async (input) => {
        edgeCalls += 1;
        await writeFile(input.target, Buffer.from('mp3'));
      },
      synthesizeBreeze: async () => {
        breezeCalls += 1;
      },
    });
    assert.equal((await voice.speak({ text: '第一句' })).ok, true);
    assert.equal((await voice.speak({ text: '第二句' })).ok, true);
    assert.equal(breezeCalls, 0, '没有密钥不能打上游');
    assert.equal(edgeCalls, 2, '两次都必须走 edge');
    assert.equal(warns.filter((line) => line.includes('Breeze API key')).length, 1, '告警应节流到一次');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缓存隔离：同一句话在 edge 与 breeze 下是两份文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-iso-'));
  try {
    const edgeOnly = createVoiceService({
      userRoot: root,
      synthesize: async (input) => {
        await writeFile(input.target, Buffer.from('edge-mp3'));
      },
    });
    const breezeOnly = createVoiceService({
      userRoot: root,
      breeze: () => BREEZE,
      synthesizeBreeze: async (input) => {
        await writeFile(input.target, Buffer.from('breeze-mp3'));
      },
    });
    const fromEdge = await edgeOnly.speak({ text: '同一句话' });
    const fromBreeze = await breezeOnly.speak({ text: '同一句话' });
    assert.equal(fromEdge.ok, true);
    assert.equal(fromBreeze.ok, true);
    assert.notEqual(
      fromEdge.ok ? fromEdge.file : '',
      fromBreeze.ok ? fromBreeze.file : '',
      '换来源不能命中上一家的旧音频',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Breeze 与 edge 的互不干扰：第三方注册后仍优先于 breeze', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-order-'));
  let providerCalls = 0;
  const dispose = registerVoiceProvider({
    id: 'my-tts',
    name: '我的语音',
    synthesize: async () => {
      providerCalls += 1;
      return new Uint8Array([1, 2, 3]);
    },
  });
  try {
    const voice = createVoiceService({
      userRoot: root,
      breeze: () => BREEZE,
      synthesizeBreeze: async () => assert.fail('第三方注册后不该走 breeze'),
    });
    assert.equal((await voice.speak({ text: '你好' })).ok, true);
    assert.equal(providerCalls, 1, '第三方仍然最先接管');
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
  }
});
