/**
 * BreezeBlue 合成封装的行为测试（src/host/voice/breeze.ts）。
 *
 * 用换了 `globalThis.fetch` 的替身断言请求形状（URL / 认证头 / 体字段），不发真实请求；
 * 落盘走临时目录，结束后删除。语速换算单独钉边界，避免上游返回 402 时才发现在算错。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BREEZE_DEFAULT_BASE_URL, isBreezeVoiceId, rateToSpeed, synthesizeBreeze } from './breeze.ts';
import { VoiceSynthError } from './edge.ts';

/** 一次请求的记录。 */
interface Recorded {
  url: string;
  init?: RequestInit;
}

/** 换掉全局 fetch 跑一段用例；`respond` 决定回什么。 */
async function withFetch(
  respond: (url: string) => Response | Promise<Response>,
  run: (calls: Recorded[]) => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond(String(input)));
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

/** 临时工作目录里跑一次合成，返回目录（供断言落盘结果）。 */
async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pet-breeze-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 10 字节假 mp3。 */
const AUDIO = Buffer.from('ID3fake-mp3');

test('请求形状：URL、认证头与必填体字段', () =>
  withDir(async (dir) => {
    const target = join(dir, 'out.mp3');
    await withFetch(
      () => new Response(AUDIO, { status: 200 }),
      async (calls) => {
        await synthesizeBreeze({ text: '你好，我是桌宠', voiceId: 'voc_8yud7hz7c9q2', apiKey: 'brz_test', target });
        assert.equal(calls.length, 1);
        assert.equal(
          calls[0].url,
          `${BREEZE_DEFAULT_BASE_URL}/v1/text-to-speech/voc_8yud7hz7c9q2?output_format=mp3_24000_128`,
        );
        assert.equal(calls[0].init?.method, 'POST');
        const headers = calls[0].init?.headers as Record<string, string>;
        assert.equal(headers['xi-api-key'], 'brz_test');
        assert.equal(headers['content-type'], 'application/json');
        const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
        assert.equal(body.text, '你好，我是桌宠');
        assert.equal('language_code' in body, false, '没传语种就不该出现这个键');
        assert.equal('voice_settings' in body, false, '语速为 1 时不该出现 voice_settings');
      },
    );
    assert.deepEqual(await readFile(target), AUDIO, '落盘内容必须是响应体原文');
    assert.deepEqual(await readdir(dir), ['out.mp3'], '不能留下 .part 中间文件');
  }));

test('语种与语速：只在显式给出时进请求体', () =>
  withDir(async (dir) => {
    await withFetch(
      () => new Response(AUDIO, { status: 200 }),
      async (calls) => {
        await synthesizeBreeze({
          text: 'hi',
          voiceId: 'voc_8yud7hz7c9q2',
          apiKey: 'brz_test',
          languageCode: 'en',
          speed: 1.5,
          target: join(dir, 'a.mp3'),
        });
        const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
        assert.equal(body.language_code, 'en');
        assert.deepEqual(body.voice_settings, { speed: 1.5 });
      },
    );
  }));

test('自定义 baseUrl：路径照拼，便于本地替身与自建网关', () =>
  withDir(async (dir) => {
    await withFetch(
      () => new Response(AUDIO, { status: 200 }),
      async (calls) => {
        await synthesizeBreeze({
          text: 'hi',
          voiceId: 'voc_abc12345',
          apiKey: 'brz_test',
          target: join(dir, 'b.mp3'),
          baseUrl: 'http://127.0.0.1:9999',
        });
        assert.ok(calls[0].url.startsWith('http://127.0.0.1:9999/v1/text-to-speech/voc_abc12345?'));
      },
    );
  }));

test('非 2xx：抛 VoiceSynthError，错误体压成一行且不含密钥', () =>
  withDir(async (dir) => {
    const target = join(dir, 'c.mp3');
    await withFetch(
      () => new Response('{"detail":{"code":"AUTH_REQUIRED"}}\n\n', { status: 401 }),
      async () => {
        await assert.rejects(
          synthesizeBreeze({ text: 'hi', voiceId: 'voc_8yud7hz7c9q2', apiKey: 'brz_secret', target }),
          (error: unknown) => {
            assert.ok(error instanceof VoiceSynthError);
            assert.match(error.message, /breeze 401/);
            assert.match(error.message, /AUTH_REQUIRED/);
            assert.doesNotMatch(error.message, /brz_secret/, '错误信息不能带出密钥');
            assert.doesNotMatch(error.message, /\n/, '错误摘要必须是一行');
            return true;
          },
        );
      },
    );
    assert.deepEqual(await readdir(dir), [], '失败不能留下任何文件');
  }));

test('空响应体：按失败处理，不留 0 字节 mp3', () =>
  withDir(async (dir) => {
    await withFetch(
      () => new Response(new Uint8Array(), { status: 200 }),
      async () => {
        await assert.rejects(
          synthesizeBreeze({ text: 'hi', voiceId: 'voc_8yud7hz7c9q2', apiKey: 'k', target: join(dir, 'd.mp3') }),
          /empty audio/,
        );
      },
    );
    assert.deepEqual(await readdir(dir), []);
  }));

test('网络异常：归一成 VoiceSynthError，保留原始信息', () =>
  withDir(async (dir) => {
    await withFetch(
      () => {
        throw new TypeError('fetch failed');
      },
      async () => {
        await assert.rejects(
          synthesizeBreeze({ text: 'hi', voiceId: 'voc_8yud7hz7c9q2', apiKey: 'k', target: join(dir, 'e.mp3') }),
          (error: unknown) => error instanceof VoiceSynthError && /fetch failed/.test(error.message),
        );
      },
    );
  }));

test('isBreezeVoiceId —— 只认 voc_ + 字母数字的形状', () => {
  assert.equal(isBreezeVoiceId('voc_8yud7hz7c9q2'), true);
  assert.equal(isBreezeVoiceId('voc_ABCD1234'), true, '形状校验不区分大小写');
  assert.equal(isBreezeVoiceId('voc_'), false, '至少要有 4 位');
  assert.equal(isBreezeVoiceId('voc_ab'), false);
  assert.equal(isBreezeVoiceId('zh-CN-XiaoxiaoNeural'), false, 'edge 的音色不是 Breeze id');
  assert.equal(isBreezeVoiceId(''), false);
  assert.equal(isBreezeVoiceId(undefined), false);
  assert.equal(isBreezeVoiceId(42), false);
});

test('rateToSpeed —— +0% → 1，边界夹取，非法表达式回落 1', () => {
  assert.equal(rateToSpeed('+0%'), 1);
  assert.equal(rateToSpeed('-10%'), 0.9);
  assert.equal(rateToSpeed('+100%'), 2, '上游上界');
  assert.equal(rateToSpeed('-50%'), 0.5, '上游下界');
  assert.equal(rateToSpeed('+500%'), 2, '越界夹到上界');
  assert.equal(rateToSpeed('-500%'), 0.5, '越界夹到下界');
  assert.equal(rateToSpeed('+abc%'), 1, '解析不出数字时按原速');
});
