/**
 * cookie 取数层的单元测试 —— 缓存、最小间隔与单飞。
 *
 * 借句柄要扫全机句柄表（约 240ms 同步阻塞），所以「什么时候允许真的再探一次」是这套代码
 * 唯一的规则所在。这里注入假时钟与假探测，不碰真实文件与 Win32。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CookieProbeResult } from './probe.ts';
import { CACHE_MS, MIN_PROBE_GAP_MS, createCookieGuard } from './store.ts';

/** 一次探测的固定结论：条数随调用次数递增，便于断言「到底探了几次」。 */
function makeProbe(): { probe: () => CookieProbeResult; calls: () => number } {
  let calls = 0;
  return {
    probe: () => {
      calls += 1;
      return { ok: true, count: calls, source: 'file', fileSize: 4096, elapsedMs: 1 };
    },
    calls: () => calls,
  };
}

describe('createCookieGuard —— 缓存与最小间隔', () => {
  test('60 秒内连续取数只探测一次', async () => {
    const { probe, calls } = makeProbe();
    const guard = createCookieGuard({ probe, now: () => 0, yieldToLoop: () => Promise.resolve() });
    const first = await guard.inspect(false);
    const second = await guard.inspect(false);
    assert.equal(calls(), 1);
    assert.deepEqual(second, first, '缓存命中返回同一份结论');
  });

  test('超过 60 秒后才重新探测', async () => {
    const { probe, calls } = makeProbe();
    let now = 0;
    const guard = createCookieGuard({ probe, now: () => now, yieldToLoop: () => Promise.resolve() });
    await guard.inspect(false);
    now = CACHE_MS - 1;
    await guard.inspect(false);
    assert.equal(calls(), 1, '还没过期就不该再探');
    now = CACHE_MS;
    await guard.inspect(false);
    assert.equal(calls(), 2);
  });

  test('force 可穿透 60 秒缓存，但仍受 5 秒最小间隔约束', async () => {
    const { probe, calls } = makeProbe();
    let now = 0;
    const guard = createCookieGuard({ probe, now: () => now, yieldToLoop: () => Promise.resolve() });
    await guard.inspect(true);
    now = MIN_PROBE_GAP_MS - 1;
    await guard.inspect(true);
    assert.equal(calls(), 1, '5 秒内连点不该再扫一遍句柄表');
    now = MIN_PROBE_GAP_MS;
    await guard.inspect(true);
    assert.equal(calls(), 2);
  });

  test('两次调用撞在同一拍：只探一次，两边拿同一份结论', async () => {
    const { probe, calls } = makeProbe();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard = createCookieGuard({ probe, now: () => 0, yieldToLoop: () => gate });
    const first = guard.inspect(true);
    const second = guard.inspect(true);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls(), 1, '单飞：同一时刻只允许一次真实探测');
    assert.deepEqual(a, b);
  });

  test('失败结论也会缓存：读不到时不该每点一次都重扫', async () => {
    let calls = 0;
    const guard = createCookieGuard({
      probe: () => {
        calls += 1;
        return { ok: false, reason: '没找到 DSH 自带的 koffi' };
      },
      now: () => 0,
      yieldToLoop: () => Promise.resolve(),
    });
    await guard.inspect(false);
    const again = await guard.inspect(false);
    assert.equal(calls, 1);
    assert.equal(again.ok, false);
  });
});
