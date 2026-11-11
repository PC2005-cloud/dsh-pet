/** 独立挂载共用标签页存储时，旧场收尾不能接管或清除新场的锁。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLock } from './lock.ts';
import type { Transport } from './transport.ts';

test('延迟放锁前撤销旧接管标记，回执不能清除新挂载的锁', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k),
  } });
  let finishRelease!: () => void;
  const released = new Promise<void>((resolve) => { finishRelease = resolve; });
  const acquisitions: unknown[] = [];
  let count = 0;
  const transport = { call: async (_method: string, path: string, body: unknown) => {
    if (path.startsWith('/lock/release')) { await released; return { ok: true }; }
    acquisitions.push(body);
    count += 1;
    return { ok: true, lockId: count === 1 ? 'old' : 'new' };
  } } as unknown as Transport;
  const old = createLock(transport, 'pet', () => true, () => {});
  const replacement = createLock(transport, 'pet', () => true, () => {});
  await old.acquire();
  const pending = old.release();
  await replacement.acquire();
  assert.deepEqual(acquisitions[1], { ttl: 30000 }, '新挂载不得复用正在释放的旧锁');
  assert.equal(data.get('dsh-pet-baifan/lock/pet'), 'new');
  finishRelease();
  await pending;
  assert.equal(data.get('dsh-pet-baifan/lock/pet'), 'new', '旧回执不得清除新锁');
});

test('旧接管失败的迟到回执不得删除其他挂载已保存的锁', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const data = new Map<string, string>([['dsh-pet-baifan/lock/pet', 'old']]);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k),
  } });
  let finish!: (result: Record<string, unknown>) => void;
  const wait = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const transport = { call: async (_method: string, _path: string, body: unknown) => {
    if ((body as { lockId?: string }).lockId === 'old') return wait;
    return { ok: false, reason: 'pet-not-displayed' };
  } } as unknown as Transport;
  const lock = createLock(transport, 'pet', () => true, () => {});
  const pending = lock.acquire();
  data.set('dsh-pet-baifan/lock/pet', 'new');
  finish({ ok: false });
  await assert.rejects(pending);
  assert.equal(data.get('dsh-pet-baifan/lock/pet'), 'new');
});

test('旧接管成功但标记已变更时不得继续使用旧租约', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const data = new Map<string, string>([['dsh-pet-baifan/lock/pet', 'old']]);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k),
  } });
  let finish!: (result: Record<string, unknown>) => void;
  const wait = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const transport = { call: async () => wait } as unknown as Transport;
  const lock = createLock(transport, 'pet', () => true, () => {});
  const pending = lock.acquire();
  data.set('dsh-pet-baifan/lock/pet', 'new');
  finish({ ok: true, lockId: 'old' });
  await assert.rejects(pending);
  assert.equal(lock.id(), null);
  assert.equal(data.get('dsh-pet-baifan/lock/pet'), 'new');
});

test('旧新建锁回执迟到时不得覆盖另一挂载保存的新锁', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k),
  } });
  let finish!: (result: Record<string, unknown>) => void;
  const wait = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const releases: unknown[] = [];
  const transport = { call: async (_method: string, path: string, body: unknown) => {
    if (path.startsWith('/lock/release')) { releases.push(body); return { ok: true }; }
    return wait;
  } } as unknown as Transport;
  const old = createLock(transport, 'pet', () => true, () => {});
  const pending = old.acquire();
  data.set('dsh-pet-baifan/lock/pet', 'new');
  finish({ ok: true, lockId: 'old' });
  await assert.rejects(pending);
  assert.equal(data.get('dsh-pet-baifan/lock/pet'), 'new');
  assert.equal(old.id(), null);
  assert.deepEqual(releases, [{ lockId: 'old' }]);
});

test('卸载后新建锁回执迟到，即使无新标记也只释放旧租约', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k),
  } });
  let finish!: (result: Record<string, unknown>) => void;
  const wait = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const releases: unknown[] = [];
  const transport = { call: async (_method: string, path: string, body: unknown) => {
    if (path.startsWith('/lock/release')) { releases.push(body); return { ok: true }; }
    return wait;
  } } as unknown as Transport;
  let alive = true;
  const lock = createLock(transport, 'pet', () => alive, () => {});
  const pending = lock.acquire();
  alive = false;
  finish({ ok: true, lockId: 'old' });
  await assert.rejects(pending);
  assert.equal(data.size, 0);
  assert.deepEqual(releases, [{ lockId: 'old' }]);
});

test('迟到租约已被新实例保存同一 ID 时不能释放新实例的锁', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k),
  } });
  let finish!: (result: Record<string, unknown>) => void;
  const wait = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const releases: unknown[] = [];
  const transport = { call: async (_method: string, path: string, body: unknown) => {
    if (path.startsWith('/lock/release')) { releases.push(body); return { ok: true }; }
    return wait;
  } } as unknown as Transport;
  const lock = createLock(transport, 'pet', () => true, () => {});
  const pending = lock.acquire();
  data.set('dsh-pet-baifan/lock/pet', 'same-id');
  finish({ ok: true, lockId: 'same-id' });
  await assert.rejects(pending);
  assert.equal(data.get('dsh-pet-baifan/lock/pet'), 'same-id');
  assert.deepEqual(releases, []);
});

test('等锁重试的迟到成功回执不会覆盖或释放新实例租约', async (t) => {
  const saved = ['sessionStorage', 'window'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (fn: () => void) => { queueMicrotask(fn); return 1; } } });
  let finish!: (result: Record<string, unknown>) => void;
  let retryStarted!: () => void;
  const entered = new Promise<void>((resolve) => { retryStarted = resolve; });
  const wait = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const releases: unknown[] = [];
  let count = 0;
  const transport = { call: async (_method: string, path: string, body: unknown) => {
    if (path.startsWith('/lock/release')) { releases.push(body); return { ok: true }; }
    count += 1;
    if (count === 1) return { ok: false, reason: 'locked', expiresAt: 0 };
    retryStarted();
    return wait;
  } } as unknown as Transport;
  const lock = createLock(transport, 'pet', () => true, () => {});
  const pending = lock.acquire();
  await entered;
  data.set('dsh-pet-baifan/lock/pet', 'new');
  finish({ ok: true, lockId: 'old' });
  await assert.rejects(pending);
  assert.equal(data.get('dsh-pet-baifan/lock/pet'), 'new');
  assert.deepEqual(releases, [{ lockId: 'old' }]);
});
