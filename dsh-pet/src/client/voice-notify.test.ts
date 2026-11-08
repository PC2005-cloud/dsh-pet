/**
 * 工作状态播报的判定测试：钉住「哪些档位出声、念哪一句、同一档位不重念」。
 *
 * 只测纯判定；真正发声由 shared/voice.ts 的 speakNotice 负责，不在本文件覆盖范围。
 *
 * 跑法：node --experimental-strip-types --test src/client/voice-notify.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { decideWorkStatusLine, resetSpokenState, speakWorkStatus } from './voice-notify.ts';
import { petBridge } from './settings/bridge.ts';
import { setSurface, setVoiceConfig, setVoiceNotifyEnabled } from '../shared/voice.ts';
import type { WorkStatusSnapshot } from '../shared/work-status.ts';
import type { Pet } from '../shared/types.ts';

/** 六档台词组，顺序与 WORK_STATUS_INDEX 一致。 */
const TEXTS = [['思考中'], ['忙碌中'], ['整理中'], ['等你确认'], ['完成啦'], ['出错了']];

/** 造一只只填了本模块用到的字段的宠物。 */
function mkPet(texts?: string[][]): Pet {
  return { id: 'main', workStatusTexts: texts } as unknown as Pet;
}

/** 造一个工作状态快照。 */
function mkSnap(state: WorkStatusSnapshot['state'], task: string | null = null): WorkStatusSnapshot {
  return { state, task };
}

describe('decideWorkStatusLine —— 工作状态播报的判定', () => {
  test('档位没变 → 不念', () => {
    assert.equal(decideWorkStatusLine(mkSnap('success'), [mkPet(TEXTS)], 'success'), undefined);
  });

  test('非通知档位（thinking / working / result）→ 不念', () => {
    for (const state of ['thinking', 'working', 'result'] as const) {
      assert.equal(decideWorkStatusLine(mkSnap(state), [mkPet(TEXTS)], null), undefined, state);
    }
  });

  test('通知档位（waiting / success / error）→ 念该档位的台词', () => {
    assert.equal(decideWorkStatusLine(mkSnap('waiting'), [mkPet(TEXTS)], null), '等你确认');
    assert.equal(decideWorkStatusLine(mkSnap('success'), [mkPet(TEXTS)], null), '完成啦');
    assert.equal(decideWorkStatusLine(mkSnap('error'), [mkPet(TEXTS)], null), '出错了');
  });

  test('任务详情不参与播报：只念配置台词', () => {
    assert.equal(decideWorkStatusLine(mkSnap('success', 'voice.ts 这里要修一下'), [mkPet(TEXTS)], null), '完成啦');
  });

  test('该档位没配台词 → 不念（哪怕有任务详情）', () => {
    assert.equal(decideWorkStatusLine(mkSnap('success', '改文件'), [mkPet()], null), undefined);
    assert.equal(decideWorkStatusLine(mkSnap('success'), [], null), undefined);
  });

  test('空闲（state 为 null）→ 不念', () => {
    assert.equal(decideWorkStatusLine(mkSnap(null), [mkPet(TEXTS)], 'success'), undefined);
  });
});

/** 等异步链跑完。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 极简浏览器替身：只让发声链路能走完，并记录合成了几次。 */
function stubSpeakEnv(): { count: () => number; restore: () => void } {
  let count = 0;
  const previousFetch = globalThis.fetch;
  const previousAudio = (globalThis as { Audio?: unknown }).Audio;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  (globalThis as { fetch: unknown }).fetch = () => {
    count += 1;
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      blob: async () => ({ size: 1 }),
    });
  };
  (globalThis as { Audio?: unknown }).Audio = class {
    volume = 1;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onpause: (() => void) | null = null;
    play(): Promise<void> {
      setTimeout(() => this.onended?.(), 0);
      return Promise.resolve();
    }
    pause(): void {
      this.onpause?.();
    }
  };
  URL.createObjectURL = () => 'blob:dsh-pet-test';
  URL.revokeObjectURL = () => undefined;
  return {
    count: () => count,
    restore: () => {
      (globalThis as { fetch: unknown }).fetch = previousFetch;
      (globalThis as { Audio?: unknown }).Audio = previousAudio;
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
    },
  };
}

describe('speakWorkStatus —— 播报开关', () => {
  test('开关关闭 → 不发声', async () => {
    const env = stubSpeakEnv();
    try {
      setSurface('web');
      setVoiceConfig('', true);
      setVoiceNotifyEnabled(false);
      resetSpokenState();
      petBridge.current = [mkPet(TEXTS)];
      speakWorkStatus(mkSnap('success'));
      await flush();
      assert.equal(env.count(), 0, '开关关着不该发合成请求');
    } finally {
      env.restore();
    }
  });

  test('开关打开 → 念一句配置台词', async () => {
    const env = stubSpeakEnv();
    try {
      setSurface('web');
      setVoiceConfig('', true);
      setVoiceNotifyEnabled(true);
      resetSpokenState();
      petBridge.current = [mkPet(TEXTS)];
      speakWorkStatus(mkSnap('success'));
      await flush();
      assert.equal(env.count(), 1, '开关打开应发一次合成请求');
    } finally {
      env.restore();
    }
  });
});
