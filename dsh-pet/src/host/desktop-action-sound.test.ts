/**
 * 桌面 Helper 的动作音效接线（runtime/electron-helper/sprite/playback.js）：新动画翻到前台时
 * 以 BASE 素材通道、该宠物条目的 actionSounds 调 shared-core 的 playActionSound；被覆盖的换源不响。
 * playback.js 是经典 script（往 PetSprite 原型挂方法），这里用 vm 注入最小全局跑它，不碰真实 DOM。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const playback = readFileSync(new URL('../../runtime/electron-helper/sprite/playback.js', import.meta.url), 'utf8');

/** 假 video：只实现 switchTo 用到的成员，loadeddata 由用例手动派发。 */
class FakeVideo {
  readyState = 0;
  src = '';
  loop = false;
  muted = false;
  autoplay = false;
  playsInline = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  style: Record<string, string> = {};
  listeners: Array<() => void> = [];
  classList = { add: () => {}, remove: () => {} };
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners = this.listeners.filter((entry) => entry !== listener);
  }
  fire(): void {
    for (const listener of [...this.listeners]) listener();
  }
  load(): void {}
  pause(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
}

function fixture(actionSounds: Record<string, string> | undefined) {
  const calls: Array<{ base: string; sounds: unknown; anim: string }> = [];
  class PetSprite {}
  runInNewContext(playback, {
    PetSprite,
    BASE: 'dsh-pet-bridge://dsh-pet/dsh-pet-7340',
    S: {
      ANIMATION_EXT: '.webm',
      playActionSound: (base: string, sounds: unknown, anim: string) => calls.push({ base, sounds, anim }),
    },
    window: { setTimeout: () => 0, clearTimeout: () => {} },
    console,
  });
  const sprite = Object.assign(Object.create(PetSprite.prototype), {
    pet: { id: 'main', actionSounds },
    front: 0,
    gen: 0,
    pending: null,
    playback: null,
    facing: 'left',
    assetBase: 'x/',
    videoA: new FakeVideo(),
    videoB: new FakeVideo(),
  }) as { switchTo(next: string, once: boolean): void; videoB: FakeVideo };
  return { sprite, calls };
}

test('新动画翻到前台：以 BASE 与该宠物的 actionSounds 调 playActionSound', () => {
  const sounds = { 点击: 'click-happy.wav' };
  const { sprite, calls } = fixture(sounds);
  sprite.switchTo('点击', true);
  assert.equal(calls.length, 0, '首帧到达前不响');
  sprite.videoB.fire();
  assert.deepEqual(calls, [{ base: 'dsh-pet-bridge://dsh-pet/dsh-pet-7340', sounds, anim: '点击' }]);
});

test('被新切换覆盖的那一段不响：只响真正出画的动画', () => {
  const { sprite, calls } = fixture({});
  sprite.switchTo('点击', true);
  sprite.switchTo('拖拽', false);
  sprite.videoB.fire();
  assert.deepEqual(
    calls.map((call) => call.anim),
    ['拖拽'],
  );
});
