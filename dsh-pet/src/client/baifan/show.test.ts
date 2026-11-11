/** 活动停止、替换和卸载必须先收回本场租约与回调。 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createShow, type ShowDeps } from './show.ts';

const assets = { descend: 'a', chase: 'b', expect: 'c', eatBowl: 'd', eatBall: 'e' };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 固定外部回执顺序，不取消迟到响应，也不运行真实 HTTP 或定时器。 */
function fixture(t: TestContext) {
  const previous = ['window', 'document', 'sessionStorage'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  let sequence = 0;
  const intervals = new Set<number>();
  const timeouts = new Set<number>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1280,
      innerHeight: 720,
      setInterval: () => {
        const id = ++sequence;
        intervals.add(id);
        return id;
      },
      clearInterval: (id: number) => intervals.delete(id),
      setTimeout: () => {
        const id = ++sequence;
        timeouts.add(id);
        return id;
      },
      clearTimeout: (id: number) => timeouts.delete(id),
    },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const acquisitions: { pet: string; resolve: (value: Record<string, unknown>) => void }[] = [];
  const calls: { path: string; body: unknown }[] = [];
  const transport: ShowDeps['transport'] = {
    attach: () => {},
    call: async (_method, path, body) => {
      calls.push({ path, body });
      if (!path.startsWith('/lock?')) return { ok: true };
      let resolve!: (value: Record<string, unknown>) => void;
      const pending = new Promise<Record<string, unknown>>((accept) => {
        resolve = accept;
      });
      acquisitions.push({ pet: new URL(path, 'https://example.test').searchParams.get('pet') ?? '', resolve });
      return pending;
    },
    pose: () => ({ x: 0.5, y: 0.5, facing: 'left' }),
    progress: () => null,
    waitPlayback: async () => ({ status: 'ended' }),
  };
  const scene: ShowDeps['scene'] = {
    clear: () => {},
    toast: () => {},
    detach: () => {},
    dropEmptyBowl: () => {},
    flyToMouth: () => {},
    kick: () => {},
    nearest: () => null,
    popScore: () => {},
    count: () => 0,
    scaleOf: () => 1,
    spawn: () => null,
  };
  const released = () => calls.filter(({ path }) => path.startsWith('/lock/release')).map(({ body }) => body);
  return { show: createShow({ transport, scene }), acquisitions, calls, intervals, timeouts, released };
}

test('停止后迟到的取锁回执不再移动宠物或注册续期', async (t) => {
  const f = fixture(t);
  f.show.start('pet-a', assets);
  await settle();
  const stopping = f.show.halt();
  f.acquisitions[0]!.resolve({ ok: true, lockId: 'lease-a' });
  await stopping;
  await settle();
  assert.equal(
    f.calls.some(({ path }) => path.startsWith('/position') || path.startsWith('/anim')),
    false,
  );
  assert.equal(f.intervals.size, 0);
  assert.equal(f.show.isRunning(), false);
  assert.deepEqual(f.released(), [{ lockId: 'lease-a' }]);
});

test('快速切换仅由最后一场接管，旧回执不释放新租约', async (t) => {
  const f = fixture(t);
  f.show.start('pet-a', assets);
  await settle();
  f.show.start('pet-b', assets);
  f.show.start('pet-c', assets);
  f.acquisitions[0]!.resolve({ ok: true, lockId: 'lease-a' });
  await settle();
  assert.deepEqual(
    f.acquisitions.map(({ pet }) => pet),
    ['pet-a', 'pet-c'],
  );
  f.acquisitions[1]!.resolve({ ok: true, lockId: 'lease-c' });
  await settle();
  assert.equal(f.show.isRunning(), true);
  assert.deepEqual(f.released(), [{ lockId: 'lease-a' }]);
  await f.show.halt();
  assert.deepEqual(f.released(), [{ lockId: 'lease-a' }, { lockId: 'lease-c' }]);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timeouts.size, 0);
});

test('卸载撤销排队的重开，迟到回执只释放原租约', async (t) => {
  const f = fixture(t);
  f.show.start('pet-a', assets);
  await settle();
  f.show.start('pet-b', assets);
  const disposing = f.show.dispose();
  f.acquisitions[0]!.resolve({ ok: true, lockId: 'lease-a' });
  await disposing;
  f.show.start('pet-c', assets);
  await settle();
  assert.deepEqual(
    f.acquisitions.map(({ pet }) => pet),
    ['pet-a'],
  );
  assert.deepEqual(f.released(), [{ lockId: 'lease-a' }]);
  assert.equal(f.show.isRunning(), false);
  assert.equal(f.intervals.size, 0);
});

test('收场取消动画等待并允许随后重新开演', async (t) => {
  const f = fixture(t);
  f.show.start('pet-a', assets);
  await settle();
  f.acquisitions[0]!.resolve({ ok: true, lockId: 'lease-a' });
  await settle();
  assert.equal(f.intervals.size, 1);
  assert.equal(f.timeouts.size, 1);
  await f.show.halt();
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timeouts.size, 0);
  f.show.start('pet-b', assets);
  await settle();
  assert.deepEqual(
    f.acquisitions.map(({ pet }) => pet),
    ['pet-a', 'pet-b'],
  );
  const stopping = f.show.halt();
  f.acquisitions[1]!.resolve({ ok: true, lockId: 'lease-b' });
  await stopping;
  assert.deepEqual(f.released(), [{ lockId: 'lease-a' }, { lockId: 'lease-b' }]);
});
