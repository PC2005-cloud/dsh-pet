/**
 * 动作音效（src/shared/action-sound.ts）的契约测试：总开关没开时什么都不响；没配的动作不构造不播放；
 * 配了的按素材通道拼地址、文件名转义；同一文件节流窗口内只响一次（同页多只同播不叠音），
 * 不同文件互不影响；音频失败不外抛。
 * 用假的 Audio 与假时钟，不碰真实设备。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

import { playActionSound, resetActionSoundsForTest, setActionSoundsEnabled } from './action-sound.ts';

/** 假 Audio：记录地址、播放次数与播放前被重置的进度。 */
class FakeAudio {
  static created: FakeAudio[] = [];
  static failure: 'construct' | 'play' | 'reject' | null = null;
  url: string;
  plays = 0;
  volume = 1;
  currentTime = 7;

  constructor(url: string) {
    if (FakeAudio.failure === 'construct') throw new Error('audio unavailable');
    this.url = url;
    FakeAudio.created.push(this);
  }

  play(): Promise<void> {
    this.plays += 1;
    if (FakeAudio.failure === 'play') throw new Error('play unavailable');
    return FakeAudio.failure === 'reject' ? Promise.reject(new Error('autoplay rejected')) : Promise.resolve();
  }
}

/** 假时钟；用例直接改 `now` 推进时间。 */
interface Clock {
  now: number;
}

/** 换掉 Audio 与 Date.now 并打开总开关，跑完还原并清空模块缓存。 */
async function withFakeAudio(run: (clock: Clock) => void | Promise<void>): Promise<void> {
  const previousAudio = globalThis.Audio;
  const previousNow = Date.now;
  const clock: Clock = { now: 10_000 };
  FakeAudio.created = [];
  FakeAudio.failure = null;
  resetActionSoundsForTest();
  setActionSoundsEnabled(true);
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  Date.now = () => clock.now;
  try {
    await run(clock);
  } finally {
    (globalThis as { Audio?: unknown }).Audio = previousAudio;
    Date.now = previousNow;
    resetActionSoundsForTest();
  }
}

const BASE = 'http://127.0.0.1:3080/dsh-pet-7340';
const SOUNDS = { 点击回应: 'click happy.wav', 拖拽: 'drag-lift.wav' };

describe('playActionSound —— 动作音效', () => {
  test('总开关关闭：配了也不构造、不播放；重新打开后照常响', async () => {
    await withFakeAudio(() => {
      setActionSoundsEnabled(false);
      playActionSound(BASE, SOUNDS, '点击回应');
      assert.equal(FakeAudio.created.length, 0);
      setActionSoundsEnabled(true);
      playActionSound(BASE, SOUNDS, '点击回应');
      assert.equal(FakeAudio.created.length, 1);
    });
  });

  test('没配音效表 / 动作不在表里 / 原型链上的同名键：不构造、不播放', async () => {
    await withFakeAudio(() => {
      playActionSound(BASE, undefined, '点击回应');
      playActionSound(BASE, SOUNDS, '待机');
      playActionSound(BASE, SOUNDS, 'constructor');
      playActionSound(BASE, SOUNDS, 'toString');
      assert.equal(FakeAudio.created.length, 0);
    });
  });

  test('命中：按素材通道拼地址、文件名转义，音量 0.5 且从头播', async () => {
    await withFakeAudio(() => {
      playActionSound(BASE, SOUNDS, '点击回应');
      const [audio] = FakeAudio.created;
      assert.equal(audio.url, BASE + '/sound/click%20happy.wav');
      assert.equal(audio.plays, 1);
      assert.equal(audio.volume, 0.5);
      assert.equal(audio.currentTime, 0);
    });
  });

  test('桌面 bridge 通道同样适用', async () => {
    await withFakeAudio(() => {
      playActionSound('dsh-pet-bridge://dsh-pet/dsh-pet-7340', SOUNDS, '拖拽');
      assert.equal(FakeAudio.created[0].url, 'dsh-pet-bridge://dsh-pet/dsh-pet-7340/sound/drag-lift.wav');
    });
  });

  test('同一文件 100ms 内只响一次并复用元素；不同文件互不节流', async () => {
    await withFakeAudio((clock) => {
      playActionSound(BASE, SOUNDS, '点击回应');
      clock.now += 99;
      playActionSound(BASE, SOUNDS, '点击回应');
      playActionSound(BASE, SOUNDS, '拖拽');
      assert.equal(FakeAudio.created.length, 2);
      assert.equal(FakeAudio.created[0].plays, 1);
      assert.equal(FakeAudio.created[1].plays, 1);
      clock.now += 1;
      playActionSound(BASE, SOUNDS, '点击回应');
      assert.equal(FakeAudio.created.length, 2);
      assert.equal(FakeAudio.created[0].plays, 2);
    });
  });

  for (const failure of ['construct', 'play', 'reject'] as const) {
    test(`音频 ${failure} 失败不外抛`, async () => {
      await withFakeAudio(async () => {
        FakeAudio.failure = failure;
        assert.doesNotThrow(() => playActionSound(BASE, SOUNDS, '点击回应'));
        await setImmediate();
      });
    });
  }
});
