/**
 * 网页端播放进度注册表（src/client/progress.ts）的单测 —— issue #122 第 2 条。
 *
 * 三条契约：
 *   1. **按需读**：每次调用都重新取值（不是快照），播放中途读到的是那一刻的位置；
 *   2. 没注册 / 空 id / 非字符串 → `null`，**绝不抛给第三方**；
 *   3. 同一 id 重新挂载时，旧实例的清理函数**不能**摘掉新读函数（否则口子静默失效）。
 *
 * 用 Node 内置 test runner，不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { progressReaderCount, readProgress, registerProgress } from './progress.ts';

const progress = (currentTime: number, playbackId: string | null = null, anim = 'walk') => ({
  playbackId,
  anim,
  currentTime,
  duration: 10,
  paused: false,
  buffering: false,
});

describe('registerProgress / readProgress —— 页面内播放进度', () => {
  test('注册后能读到当前值，且每次调用都重新取值（按需，不是快照）', () => {
    let t = 0.5;
    const off = registerProgress('p1', () => progress(t));
    assert.equal(readProgress('p1')?.currentTime, 0.5);
    t = 3.25; // 模拟播放推进
    assert.equal(readProgress('p1')?.currentTime, 3.25, '按需读：应取到最新值');
    off();
    assert.equal(readProgress('p1'), null, '摘除后读不到');
  });

  test('playbackId 原样透出：点播有值、自播为 null', () => {
    const off1 = registerProgress('pointed', () => progress(1, 'pb_1'));
    assert.equal(readProgress('pointed')?.playbackId, 'pb_1');
    off1();

    const off2 = registerProgress('auto', () => progress(1, null));
    assert.equal(readProgress('auto')?.playbackId, null);
    off2();
  });

  test('anim 原样透出：池内动作给名字，url 点播给地址', () => {
    const off1 = registerProgress('named', () => progress(1, null, 'walk'));
    assert.equal(readProgress('named')?.anim, 'walk');
    off1();

    const off2 = registerProgress('byUrl', () => progress(1, 'pb_2', 'https://example.com/a.webm'));
    assert.equal(readProgress('byUrl')?.anim, 'https://example.com/a.webm');
    off2();
  });

  test('没注册 / 空 id / 非字符串 → null（不抛）', () => {
    assert.equal(readProgress('nope'), null);
    assert.equal(readProgress(''), null);
    assert.equal(readProgress(undefined as unknown as string), null);
    assert.equal(readProgress(42 as unknown as string), null);
  });

  test('同一 id 重新挂载：旧清理函数不能摘掉新读函数', () => {
    const off1 = registerProgress('p2', () => progress(0));
    const off2 = registerProgress('p2', () => progress(9));
    off1(); // 旧实例卸载（晚于新实例挂载）
    assert.equal(readProgress('p2')?.currentTime, 9, '新读函数必须还在');
    off2();
    assert.equal(readProgress('p2'), null);
  });

  test('清理函数重复调用无害，注册数不泄漏', () => {
    const before = progressReaderCount();
    const off = registerProgress('p3', () => progress(0));
    assert.equal(progressReaderCount(), before + 1);
    off();
    off();
    assert.equal(progressReaderCount(), before);
  });
});
