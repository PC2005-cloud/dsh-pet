/**
 * 端侧语音播报（src/shared/voice.ts）的判定行为测试：这一句到底该不该念。
 *
 * 四条契约：
 *   1. 只有叶子点名本端才念——`voiceTo` 缺省或是另一端，都只弹气泡；
 *   2. 网页端页面不可见时不念（没人在看就不出声）；
 *   3. 合成失败落到 `failed`，界面留一个静音喇叭而不是什么都没有；
 *   4. 每句都报一次 `start` 与一次 `end`；`end` 只在播完（或失败、超时）之后发，气泡靠它决定何时收起。
 *
 * 播放本身（Audio / blob）在浏览器里才有意义，这里用假音频钉住「有没有发合成请求」、状态与收尾时机。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYBACK_WAIT_MAX_MS,
  getVoiceState,
  playSayVoice,
  setSurface,
  setVoiceConfig,
  speakNotice,
  subscribeVoiceUtterance,
  type VoiceUtteranceEvent,
} from './voice.ts';

/** 假的合成端点：记录每次请求，响应默认是一个假音频；`ok: false` 模拟宿主返回失败。 */
function stubFetch(options: { ok?: boolean; hold?: boolean } = {}): {
  calls: Array<{ text: string }>;
  pending: Array<{ resolve: () => void; reject: () => void }>;
  restore: () => void;
} {
  const ok = options.ok ?? true;
  const hold = options.hold === true;
  const calls: Array<{ text: string }> = [];
  const pending: Array<{ resolve: () => void; reject: () => void }> = [];
  const previous = globalThis.fetch;
  const respond = () => ({
    ok,
    headers: { get: () => (ok ? 'audio/mpeg' : 'application/json') },
    blob: async () => ({ size: 1 }),
  });
  (globalThis as { fetch: unknown }).fetch = (_url: string, init?: { body?: string }) => {
    calls.push({ text: String((JSON.parse(init?.body ?? '{}') as { text?: unknown }).text ?? '') });
    if (!hold) return Promise.resolve(respond());
    return new Promise((resolve, reject) => {
      pending.push({ resolve: () => resolve(respond()), reject: () => reject(new Error('合成失败')) });
    });
  };
  return {
    calls,
    pending,
    restore: () => {
      (globalThis as { fetch: unknown }).fetch = previous;
    },
  };
}

/** 假音频：测试要能手动触发收尾，才钉得住「播完才发 end」。 */
interface FakeAudio {
  /** 与真实 Audio 同名的音量字段。 */
  volume: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onpause: (() => void) | null;
  /** 是否已被掐断。 */
  paused: boolean;
  play(): Promise<void>;
  /** 掐断（真实 Audio 的方法）。 */
  pause(): void;
  /** 模拟一次收尾事件。 */
  fire(event: 'ended' | 'error' | 'pause'): void;
}

/**
 * 补上浏览器才有的两个对象：音频元素与 blob 地址。
 *
 * @param options - `volumes` 收集每段音频开播时的音量；`autoEnd` 缺省 true，让不关心时长的用例
 *   在开播后自动播完；`playFails` 模拟浏览器拒绝开播。
 * @returns 按播放顺序创建的假音频与还原函数。
 */
function stubBrowser(options: { volumes?: number[]; autoEnd?: boolean; playFails?: boolean } = {}): {
  audios: FakeAudio[];
  restore: () => void;
} {
  const { volumes, autoEnd = true, playFails = false } = options;
  const previousAudio = (globalThis as { Audio?: unknown }).Audio;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const audios: FakeAudio[] = [];
  (globalThis as { Audio?: unknown }).Audio = class {
    /** 与真实 Audio 同名的音量字段：被测代码写它，这里在 play 时取出。 */
    volume = 1;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onpause: (() => void) | null = null;
    /** 被测代码掐断时置位：新的一句接管旧的一句，靠它验证。 */
    paused = false;

    constructor() {
      audios.push(this);
    }

    play(): Promise<void> {
      volumes?.push(this.volume);
      if (playFails) return Promise.reject(new Error('play blocked'));
      // 宏任务而不是微任务：收尾回调由被测代码在 await play() 之后才挂上
      if (autoEnd) setTimeout(() => this.fire('ended'), 0);
      return Promise.resolve();
    }

    pause(): void {
      this.paused = true;
      this.onpause?.();
    }

    fire(event: 'ended' | 'error' | 'pause'): void {
      if (event === 'ended') this.onended?.();
      else if (event === 'error') this.onerror?.();
      else this.onpause?.();
    }
  };
  URL.createObjectURL = () => 'blob:dsh-pet-test';
  URL.revokeObjectURL = () => undefined;
  return {
    audios,
    restore: () => {
      (globalThis as { Audio?: unknown }).Audio = previousAudio;
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
    },
  };
}

/** 让排在后面的异步旁路跑完（播放是 void 出去的，不 await）。 */
async function flush(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 只跑微任务：mock 掉 setTimeout 的用例不能用 {@link flush}，否则会等一个永远不来的定时器。 */
async function microtasks(): Promise<void> {
  for (let round = 0; round < 20; round++) await Promise.resolve();
}

describe('playSayVoice —— 这一句该不该念', () => {
  test('叶子没点名（voiceTo 缺省）→ 不发请求，气泡照旧', async () => {
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      playSayVoice({ text: '随便一句' });
      await flush();
      assert.equal(fetchStub.calls.length, 0, '没人点名就不该合成，更不该出声');
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });

  test('叶子点名另一端 → 本端不发请求', async () => {
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      playSayVoice({ text: '这一句归桌面端', voiceTo: 'desktop' });
      await flush();
      assert.equal(fetchStub.calls.length, 0, '两端不重复播报靠的就是这一条');
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });

  test('点名本端 → 发一次合成请求，正文原样', async () => {
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    try {
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text: '该喝水了', voiceTo: 'desktop' });
      await flush();
      assert.deepEqual(fetchStub.calls, [{ text: '该喝水了' }]);
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });

  test('网页端页面不可见 → 不发请求（桌面端不看可见性）', async () => {
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { hidden: true };
    try {
      setSurface('web');
      setVoiceConfig('', 1);
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
      browser.restore();
      fetchStub.restore();
    }
  });

  test('合成失败 → 状态落到 failed（留一个静音喇叭，而不是干脆没图标）', async () => {
    const fetchStub = stubFetch({ ok: false });
    const browser = stubBrowser();
    try {
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text: '这句合成不出来', voiceTo: 'desktop' });
      await flush();
      assert.equal(fetchStub.calls.length, 1, '该请求的合成请求照发');
      assert.equal(getVoiceState(), 'failed', '失败要看得见，不能静默回 idle');
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });
});

describe('播放事件 —— 气泡靠它决定何时收起', () => {
  test('念一句：报一次 start、一次 end，长句也整句送合成', async () => {
    const events: VoiceUtteranceEvent[] = [];
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    const off = subscribeVoiceUtterance((event) => events.push(event));
    try {
      const text = '很长的一句话。'.repeat(20);
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text, voiceTo: 'desktop' });
      await flush();
      assert.deepEqual(
        events.map((event) => event.kind),
        ['start', 'end'],
      );
      assert.equal(fetchStub.calls[0]?.text, text, '不截断：送合成的是气泡原文全句');
      assert.equal(events[0].text, text, '事件带原文：气泡要按它认句');
      assert.equal(events[0].seq, events[1].seq, '成对的同一句必须同序号');
    } finally {
      off();
      browser.restore();
      fetchStub.restore();
    }
  });

  test('合成失败也报 end：气泡不能因为失败就永远挂着', async () => {
    const events: VoiceUtteranceEvent[] = [];
    const fetchStub = stubFetch({ ok: false });
    const browser = stubBrowser();
    const off = subscribeVoiceUtterance((event) => events.push(event));
    try {
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text: '这句合成不出来', voiceTo: 'desktop' });
      await flush();
      assert.deepEqual(
        events.map((event) => event.kind),
        ['start', 'end'],
      );
    } finally {
      off();
      browser.restore();
      fetchStub.restore();
    }
  });

  test('不该念的句子不报任何事件：没语音就别拖长气泡', async () => {
    const events: VoiceUtteranceEvent[] = [];
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    const off = subscribeVoiceUtterance((event) => events.push(event));
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      playSayVoice({ text: '这一句归桌面端', voiceTo: 'desktop' });
      await flush();
      assert.equal(events.length, 0);
    } finally {
      off();
      browser.restore();
      fetchStub.restore();
    }
  });

  test('退订之后不再收到事件', async () => {
    const events: VoiceUtteranceEvent[] = [];
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    const off = subscribeVoiceUtterance((event) => events.push(event));
    off();
    try {
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text: '没人听了', voiceTo: 'desktop' });
      await flush();
      assert.equal(events.length, 0);
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });

  test('播完才发 end：气泡不会在开播 1.5 秒后就收起', async () => {
    const events: VoiceUtteranceEvent[] = [];
    const fetchStub = stubFetch();
    const browser = stubBrowser({ autoEnd: false });
    const off = subscribeVoiceUtterance((event) => events.push(event));
    try {
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text: '这一句要念一会儿', voiceTo: 'desktop' });
      await flush();
      assert.deepEqual(
        events.map((event) => event.kind),
        ['start'],
        '音频还在播，气泡不能收到收尾信号',
      );
      assert.equal(browser.audios.length, 1, '应该已经开始播放');
      browser.audios[0].fire('ended');
      await flush();
      assert.deepEqual(
        events.map((event) => event.kind),
        ['start', 'end'],
        '播完才允许收起气泡',
      );
    } finally {
      off();
      browser.restore();
      fetchStub.restore();
    }
  });

  test('开播失败也发 end：气泡不能因为浏览器拒绝播放就永久挂着', async () => {
    const events: VoiceUtteranceEvent[] = [];
    const fetchStub = stubFetch();
    const browser = stubBrowser({ playFails: true });
    const off = subscribeVoiceUtterance((event) => events.push(event));
    try {
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text: '播不出来', voiceTo: 'desktop' });
      await flush();
      assert.deepEqual(
        events.map((event) => event.kind),
        ['start', 'end'],
      );
      assert.equal(getVoiceState(), 'failed', '开播失败要看得见');
    } finally {
      off();
      browser.restore();
      fetchStub.restore();
    }
  });

  test('播放卡住：到上限按收尾处理，气泡不会永久挂着', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events: VoiceUtteranceEvent[] = [];
    const fetchStub = stubFetch();
    const browser = stubBrowser({ autoEnd: false });
    const off = subscribeVoiceUtterance((event) => events.push(event));
    try {
      setSurface('desktop');
      setVoiceConfig('', 1);
      playSayVoice({ text: '这句卡住了', voiceTo: 'desktop' });
      await microtasks();
      assert.deepEqual(
        events.map((event) => event.kind),
        ['start'],
        '没到上限就不该收尾',
      );
      t.mock.timers.tick(PLAYBACK_WAIT_MAX_MS);
      await microtasks();
      assert.deepEqual(
        events.map((event) => event.kind),
        ['start', 'end'],
        '到上限必须收尾',
      );
    } finally {
      off();
      browser.restore();
      fetchStub.restore();
    }
  });
});

describe('setVoiceConfig —— 音量系数', () => {
  test('0.35 原样落到播放：audio.volume 就是 0.35', async () => {
    const sink = { volumes: [] as number[] };
    const fetchStub = stubFetch();
    const browser = stubBrowser({ volumes: sink.volumes });
    try {
      setSurface('web');
      setVoiceConfig('', 0.35);
      playSayVoice({ text: '小声说', voiceTo: 'web' });
      await flush();
      assert.deepEqual(sink.volumes, [0.35], '音量要落到真正播放的那段音频上');
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });

  test('越界与脏值收敛到 0–1：2 → 1、-1 → 0、非数值 → 1', async () => {
    const sink = { volumes: [] as number[] };
    const fetchStub = stubFetch();
    const browser = stubBrowser({ volumes: sink.volumes });
    try {
      setSurface('web');
      const cases: ReadonlyArray<readonly [unknown, number]> = [
        [2, 1],
        [-1, 0],
        ['不是数字', 1],
        [0, 0],
      ];
      for (const [input, wanted] of cases) {
        setVoiceConfig('', input);
        playSayVoice({ text: '说一句', voiceTo: 'web' });
        await flush();
        assert.equal(sink.volumes[sink.volumes.length - 1], wanted, `音量 ${String(input)} 应收敛到 ${wanted}`);
      }
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });
});

describe('自动播报互斥 —— 熄屏醒来不叠音', () => {
  test('连续两句：后一句接管，前一句被 pause，不会同时响', async () => {
    const fetchStub = stubFetch();
    const browser = stubBrowser({ autoEnd: false });
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      playSayVoice({ text: '第一句', voiceTo: 'web' });
      await flush();
      playSayVoice({ text: '第二句', voiceTo: 'web' });
      await flush();
      assert.equal(browser.audios.length, 2, '两句各要一段音频');
      assert.equal(browser.audios[0].paused, true, '第一句必须被掐断');
      assert.equal(browser.audios[1].paused, false, '第二句还在响');
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });

  test('合成期间页面被藏起来：这句不播，等不到声音', async () => {
    const sink = { volumes: [] as number[] };
    const fetchStub = stubFetch();
    const browser = stubBrowser({ volumes: sink.volumes, autoEnd: false });
    const previousDocument = (globalThis as { document?: unknown }).document;
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      (globalThis as { document?: unknown }).document = { hidden: true };
      playSayVoice({ text: '息屏时生成的一句', voiceTo: 'web' });
      await flush();
      assert.deepEqual(sink.volumes, [], '隐藏期间合成的句子不该补播');
    } finally {
      (globalThis as { document?: unknown }).document = previousDocument;
      browser.restore();
      fetchStub.restore();
    }
  });

  test('过期的失败：前一句迟到的报错 → 后一句的喇叭仍是 ready', async () => {
    const fetchStub = stubFetch({ hold: true });
    const browser = stubBrowser({ autoEnd: false });
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      playSayVoice({ text: '第一句', voiceTo: 'web' });
      playSayVoice({ text: '第二句', voiceTo: 'web' });
      await flush();
      assert.equal(fetchStub.pending.length, 2, '两句各发一次合成请求');
      // 先让后一句成功、再让前一句失败：失败到得晚，不能把新句的喇叭拉回静音
      fetchStub.pending[1].resolve();
      await flush();
      fetchStub.pending[0].reject();
      await flush();
      assert.equal(getVoiceState(), 'ready', '新句已就绪，旧句的失败不该覆盖它');
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });
});

describe('speakNotice —— 通知类播报允许后台出声', () => {
  test('页面不可见时照常发请求并开播（用户走开时才最需要它响）', async () => {
    const fetchStub = stubFetch();
    const volumes: number[] = [];
    const browser = stubBrowser({ volumes });
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { hidden: true };
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      speakNotice('任务完成啦');
      await flush();
      assert.deepEqual(fetchStub.calls, [{ text: '任务完成啦' }], '通知类不该被可见性门挡掉');
      assert.equal(volumes.length, 1, '要真的开播，而不是合成完就丢掉');
    } finally {
      (globalThis as { document?: unknown }).document = previousDocument;
      browser.restore();
      fetchStub.restore();
    }
  });

  test('空串 → 不发请求', async () => {
    const fetchStub = stubFetch();
    const browser = stubBrowser();
    try {
      setSurface('web');
      setVoiceConfig('', 1);
      speakNotice('');
      await flush();
      assert.equal(fetchStub.calls.length, 0, '空串没有可念的内容');
    } finally {
      browser.restore();
      fetchStub.restore();
    }
  });
});
