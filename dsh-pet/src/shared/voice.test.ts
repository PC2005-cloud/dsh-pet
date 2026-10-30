/**
 * 端侧语音播报（src/shared/voice.ts）的判定行为测试：这一句到底该不该念。
 *
 * 四条契约：
 *   1. 只有叶子点名本端才念——`voiceTo` 缺省或是另一端，都只弹气泡；
 *   2. 点名了还要总开关开着，否则一样静音；
 *   3. 网页端页面不可见时不念（没人在看就不出声）；
 *   4. 合成失败落到 `failed`，界面留一个静音喇叭而不是什么都没有。
 *
 * 播放本身（Audio / blob）在浏览器里才有意义，这里只钉住「有没有发合成请求」与状态。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { getVoiceState, playSayVoice, setSurface, setVoiceConfig } from './voice.ts';

/** 假的合成端点：记录每次请求，响应默认是一个假音频；`ok: false` 模拟宿主返回失败。 */
function stubFetch(options: { ok?: boolean } = {}): { calls: Array<{ text: string }>; restore: () => void } {
  const ok = options.ok ?? true;
  const calls: Array<{ text: string }> = [];
  const previous = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_url: string, init?: { body?: string }) => {
    calls.push({ text: String((JSON.parse(init?.body ?? '{}') as { text?: unknown }).text ?? '') });
    return {
      ok,
      headers: { get: () => (ok ? 'audio/mpeg' : 'application/json') },
      blob: async () => ({ size: 1 }),
    };
  };
  return {
    calls,
    restore: () => {
      (globalThis as { fetch: unknown }).fetch = previous;
    },
  };
}

/** 补上浏览器才有的两个对象：音频元素与 blob 地址。 */
function stubBrowser(): () => void {
  const previousAudio = (globalThis as { Audio?: unknown }).Audio;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  (globalThis as { Audio?: unknown }).Audio = class {
    play(): Promise<void> {
      return Promise.resolve();
    }
  };
  URL.createObjectURL = () => 'blob:dsh-pet-test';
  URL.revokeObjectURL = () => undefined;
  return () => {
    (globalThis as { Audio?: unknown }).Audio = previousAudio;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  };
}

/** 让排在后面的异步旁路跑完（播放是 void 出去的，不 await）。 */
async function flush(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('playSayVoice —— 这一句该不该念', () => {
  test('叶子没点名（voiceTo 缺省）→ 不发请求，气泡照旧', async () => {
    const fetchStub = stubFetch();
    const restoreBrowser = stubBrowser();
    try {
      setSurface('web');
      setVoiceConfig('', true);
      playSayVoice({ text: '随便一句' });
      await flush();
      assert.equal(fetchStub.calls.length, 0, '没人点名就不该合成，更不该出声');
    } finally {
      restoreBrowser();
      fetchStub.restore();
    }
  });

  test('叶子点名另一端 → 本端不发请求', async () => {
    const fetchStub = stubFetch();
    const restoreBrowser = stubBrowser();
    try {
      setSurface('web');
      setVoiceConfig('', true);
      playSayVoice({ text: '这一句归桌面端', voiceTo: 'desktop' });
      await flush();
      assert.equal(fetchStub.calls.length, 0, '两端不重复播报靠的就是这一条');
    } finally {
      restoreBrowser();
      fetchStub.restore();
    }
  });

  test('点名本端 + 总开关开 → 发一次合成请求，正文原样', async () => {
    const fetchStub = stubFetch();
    const restoreBrowser = stubBrowser();
    try {
      setSurface('desktop');
      setVoiceConfig('', true);
      playSayVoice({ text: '该喝水了', voiceTo: 'desktop' });
      await flush();
      assert.deepEqual(fetchStub.calls, [{ text: '该喝水了' }]);
    } finally {
      restoreBrowser();
      fetchStub.restore();
    }
  });

  test('点名本端但总开关关 → 不发请求', async () => {
    const fetchStub = stubFetch();
    const restoreBrowser = stubBrowser();
    try {
      setSurface('desktop');
      setVoiceConfig('', false);
      playSayVoice({ text: '关了就别念', voiceTo: 'desktop' });
      await flush();
      assert.equal(fetchStub.calls.length, 0, '总开关是最后一道门');
    } finally {
      restoreBrowser();
      fetchStub.restore();
    }
  });

  test('网页端页面不可见 → 不发请求（桌面端不看可见性）', async () => {
    const fetchStub = stubFetch();
    const restoreBrowser = stubBrowser();
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { hidden: true };
    try {
      setSurface('web');
      setVoiceConfig('', true);
      playSayVoice({ text: '后台标签页', voiceTo: 'web' });
      await flush();
      assert.equal(fetchStub.calls.length, 0, '没人在看的页面不该出声');

      // 同一台机器上桌面端不受影响：它没有 document.hidden 这一说
      setSurface('desktop');
      playSayVoice({ text: '桌面端照念', voiceTo: 'desktop' });
      await flush();
      assert.deepEqual(fetchStub.calls, [{ text: '桌面端照念' }]);
    } finally {
      (globalThis as { document?: unknown }).document = previousDocument;
      restoreBrowser();
      fetchStub.restore();
    }
  });

  test('合成失败 → 状态落到 failed（留一个静音喇叭，而不是干脆没图标）', async () => {
    const fetchStub = stubFetch({ ok: false });
    const restoreBrowser = stubBrowser();
    try {
      setSurface('desktop');
      setVoiceConfig('', true);
      playSayVoice({ text: '这句合成不出来', voiceTo: 'desktop' });
      await flush();
      assert.equal(fetchStub.calls.length, 1, '该请求的合成请求照发');
      assert.equal(getVoiceState(), 'failed', '失败要看得见，不能静默回 idle');
    } finally {
      restoreBrowser();
      fetchStub.restore();
    }
  });
});
