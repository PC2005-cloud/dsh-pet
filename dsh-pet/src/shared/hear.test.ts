/**
 * 语音输入的纯逻辑契约：WAV 头逐字节、PCM 转换、静音判定、base64 与失败归类。
 *
 * 为什么钉这么细：宿主 provider 对 WAV 的校验是逐字段的（`fmt ` 长度、PCM=1、单声道、
 * 16kHz、byteRate 自洽），错一个字段就整段音频被拒；而这类错误在界面上只表现为「没听清」，
 * 根本看不出是头写错了。录音本身（getUserMedia）没法在 Node 里跑，见文件末尾说明。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { HEAR_SAMPLE_RATE, encodeWave, floatToPcm16, hearAudio, peakOf, toBase64 } from './hear.ts';

/** 从字节里取一段 ASCII 标记，按 WAV 头的 4 字节块比对。 */
function tag(bytes: Uint8Array, offset: number): string {
  let text = '';
  for (let i = offset; i < offset + 4; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

describe('encodeWave', () => {
  test('44 字节头逐字段符合宿主校验口径', () => {
    const pcm = Int16Array.from([0, 1000, -1000]);
    const wave = encodeWave(pcm);
    const view = new DataView(wave.buffer);

    assert.equal(tag(wave, 0), 'RIFF');
    assert.equal(tag(wave, 8), 'WAVE');
    assert.equal(tag(wave, 12), 'fmt ');
    assert.equal(tag(wave, 36), 'data');
    assert.equal(view.getUint32(16, true), 16, 'fmt 块长度必须是 16');
    assert.equal(view.getUint16(20, true), 1, '格式必须是 PCM');
    assert.equal(view.getUint16(22, true), 1, '必须单声道');
    assert.equal(view.getUint32(24, true), HEAR_SAMPLE_RATE, '必须 16kHz');
    assert.equal(view.getUint32(28, true), HEAR_SAMPLE_RATE * 2, 'byteRate 必须与采样率自洽');
    assert.equal(view.getUint16(32, true), 2, 'blockAlign = 声道 × 位深/8');
    assert.equal(view.getUint16(34, true), 16, '必须 16bit');
  });

  test('两处长度自洽，且样本原样写回', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const wave = encodeWave(pcm);
    const view = new DataView(wave.buffer);

    assert.equal(view.getUint32(4, true), 36 + pcm.length * 2, 'RIFF 长度 = 36 + 数据长度');
    assert.equal(view.getUint32(40, true), pcm.length * 2);
    assert.equal(wave.byteLength, 44 + pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) {
      assert.equal(view.getInt16(44 + i * 2, true), pcm[i], `第 ${i} 个样本`);
    }
  });

  test('一个样本时也有 46 字节（宿主要求最短 46，空音频会被拒）', () => {
    assert.equal(encodeWave(Int16Array.from([0])).byteLength, 46);
  });

  test('采样率可换，byteRate 跟着变', () => {
    const wave = encodeWave(Int16Array.from([0]), 8000);
    assert.equal(new DataView(wave.buffer).getUint32(24, true), 8000);
    assert.equal(new DataView(wave.buffer).getUint32(28, true), 16000);
  });
});

describe('floatToPcm16', () => {
  test('正负半轴分别按 32767 / 32768 缩放，超范围夹紧', () => {
    const out = floatToPcm16(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -2]));
    assert.equal(out[0], 0);
    assert.equal(out[1], 32767);
    assert.equal(out[2], -32768);
    assert.equal(out[3], 16383);
    assert.equal(out[4], -16384);
    assert.equal(out[5], 32767, '大于 1 夹到 1');
    assert.equal(out[6], -32768, '小于 -1 夹到 -1');
  });
});

describe('peakOf', () => {
  test('全零是 0，满幅是 1，负数取绝对值', () => {
    assert.equal(peakOf(new Int16Array(128)), 0);
    assert.equal(peakOf(Int16Array.from([-32768, 0, 1])), 1);
    assert.equal(peakOf(Int16Array.from([0, 16384, -16384])), 0.5);
  });
});

describe('toBase64', () => {
  test('与 Buffer 逐字节一致（跨过分段边界）', () => {
    const bytes = new Uint8Array(8192 * 2 + 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  });

  test('空字节给空串', () => {
    assert.equal(toBase64(new Uint8Array(0)), '');
  });
});

/** 用桩替换全局 fetch，收集请求体。 */
function stubFetch(make: () => Response): { bodies: string[]; urls: string[]; restore: () => void } {
  const bodies: string[] = [];
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(String(init?.body ?? ''));
    return make();
  }) as typeof fetch;
  return {
    bodies,
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** 造一个 JSON 响应。 */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('hearAudio', () => {
  test('成功：请求体只有 audio，文字原样返回（含空串）', async () => {
    const stub = stubFetch(() => json({ ok: true, text: '你好' }));
    try {
      const outcome = await hearAudio('http://127.0.0.1/dsh-pet-7340/voice/hear', 'AAAA');
      assert.deepEqual(outcome, { ok: true, text: '你好' });
      assert.equal(stub.urls[0], 'http://127.0.0.1/dsh-pet-7340/voice/hear');
      assert.deepEqual(JSON.parse(stub.bodies[0]), { audio: 'AAAA' }, '不许顺手多发 language 之类字段');
    } finally {
      stub.restore();
    }
  });

  test('空串也算成功（这段里没人说话是合法结论，不是错误）', async () => {
    const stub = stubFetch(() => json({ ok: true, text: '' }));
    try {
      assert.deepEqual(await hearAudio('http://x/voice/hear', 'AAAA'), { ok: true, text: '' });
    } finally {
      stub.restore();
    }
  });

  test('宿主说 unsupported / bad-request 时原样带回', async () => {
    for (const reason of ['unsupported', 'bad-request']) {
      const stub = stubFetch(() => json({ ok: false, reason, message: '原因' }));
      try {
        const outcome = await hearAudio('http://x/voice/hear', 'AAAA');
        assert.deepEqual(outcome, { ok: false, reason, message: '原因' });
      } finally {
        stub.restore();
      }
    }
  });

  test('不认识的 reason 收敛成 generate-error，message 缺失给空串', async () => {
    const stub = stubFetch(() => json({ ok: false, reason: 'locked' }));
    try {
      assert.deepEqual(await hearAudio('http://x/voice/hear', 'AAAA'), {
        ok: false,
        reason: 'generate-error',
        message: '',
      });
    } finally {
      stub.restore();
    }
  });

  test('响应不是 JSON 时算网络失败，不抛异常', async () => {
    const stub = stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    try {
      const outcome = await hearAudio('http://x/voice/hear', 'AAAA');
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason, 'network');
    } finally {
      stub.restore();
    }
  });

  test('fetch 自己抛错也收敛成网络失败', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    try {
      const outcome = await hearAudio('http://x/voice/hear', 'AAAA');
      assert.deepEqual(outcome, { ok: false, reason: 'network', message: 'ECONNREFUSED' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

// startRecording / canRecord 不在这里测：它们只做 getUserMedia + AudioContext 的接线，
// 在 Node 里没有对应实现，mock 出来也只是在测 mock。真实链路由桌面端的一次性探针跑
// （加载 shared-core.js → 按住 → 录 → 打到宿主 /voice/hear），见提交说明。
