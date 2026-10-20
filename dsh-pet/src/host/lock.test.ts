/**
 * 占用锁（issue #122 第 4 项）单元测试 —— 钉住真值表、墓碑与「无锁时按有无编号分流」。
 *
 * 为什么单独钉这些：锁是**唯一一个会拒绝别人调用**的东西（占用期间 5 个动作端点必须带 lockId），
 * 一旦判错就是"第三方联动演到一半被拒"或"宠物被锁住谁也动不了"。而它的边界又全在时间上
 * （过期、续期、抢占），所以这里注入假时钟——过期语义不用真的等 30 秒。
 *
 * 四条要钉死的口径：
 *   ① 无锁 + 没带编号 → 放行（既有调用方一个字都不用改）；无锁 + 带了编号 → `lock-lost`
 *      （旧租约不能继续执行迟到请求）；
 *   ② 「带 id + 当前无锁」一律报错，**不复活**（否则"我丢了锁"会被悄悄抹掉）；
 *   ③ 释放幂等，但**不许误放别人的锁**（有锁而 id 不匹配 → 报错）；
 *   ④ cause 分得清（过期 / 自己释放 / 被用户抢走 / 认不出），靠墓碑。
 *
 * 跑法：node --experimental-strip-types --test src/host/lock.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCK_DEFAULT_TTL_MS,
  LOCK_MAX_TTL_MS,
  LOCK_MIN_TTL_MS,
  LockStore,
  normalizeLockTtl,
  type LockLeafData,
} from './lock.ts';

/** 假时钟 + 叶子回调记录：过期语义全靠它，测试不用真的等 */
function makeStore(): {
  store: LockStore;
  advance: (ms: number) => void;
  leaves: { petId: string; data: LockLeafData }[];
} {
  let now = 1_000_000;
  const leaves: { petId: string; data: LockLeafData }[] = [];
  const store = new LockStore({
    now: () => now,
    onChange: (petId, data) => leaves.push({ petId, data }),
  });
  return { store, advance: (ms) => (now += ms), leaves };
}

describe('LockStore —— 取锁 / 续期（二合一）真值表', () => {
  test('无锁 + 不带 lockId → 新建，回 lockId / expiresAt，并写叶子 {locked:true}', () => {
    const { store, leaves } = makeStore();
    const d = store.acquire({ petId: 'main' });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.petId, 'main');
    assert.equal(d.renewed, false);
    assert.ok(d.lockId.length > 0);
    assert.equal(d.expiresAt, 1_000_000 + LOCK_DEFAULT_TTL_MS, '缺省 TTL 是 2min');
    assert.deepEqual(leaves, [{ petId: 'main', data: { locked: true, expiresAt: d.expiresAt } }]);
  });

  test('叶子**不含 lockId**：那是持锁者的凭证，不能放进人人可读的 /state', () => {
    const { store, leaves } = makeStore();
    const d = store.acquire({ petId: 'main' });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const data = leaves[0].data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), ['expiresAt', 'locked']);
    assert.equal(JSON.stringify(data).includes(d.lockId), false);
  });

  test('有锁 + 不带 lockId → locked + expiresAt（让对方知道何时能重试），不建第二把', () => {
    const { store } = makeStore();
    const first = store.acquire({ petId: 'main' });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = store.acquire({ petId: 'main' });
    assert.equal(second.ok, false);
    if (second.ok || second.reason !== 'locked') throw new Error('应当是 locked');
    assert.equal(second.expiresAt, first.expiresAt);
    assert.equal(store.current('main')?.lockId, first.lockId, '原来的锁必须原封不动');
  });

  test('有锁 + 一致 lockId → 续期：编号不变、expiresAt 推后、renewed=true', () => {
    const { store, advance, leaves } = makeStore();
    const first = store.acquire({ petId: 'main', ttl: 10_000 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    advance(5_000);
    const again = store.acquire({ petId: 'main', lockId: first.lockId });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.renewed, true);
    assert.equal(again.lockId, first.lockId, '续期不换编号');
    assert.equal(again.expiresAt, 1_005_000 + 10_000, '续期不带 ttl → 沿用原来那一个');
    assert.deepEqual(leaves[leaves.length - 1]?.data, { locked: true, expiresAt: again.expiresAt });
  });

  test('有锁 + 不一致 lockId → lock-lost / unknown（认不出这个编号）', () => {
    const { store } = makeStore();
    store.acquire({ petId: 'main' });
    const d = store.acquire({ petId: 'main', lockId: 'lk-nope' });
    assert.equal(d.ok, false);
    if (d.ok || d.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(d.cause, 'unknown');
  });

  test('无锁 + 带 lockId → lock-lost / unknown（从来没有过这把锁），**不复活**', () => {
    const { store } = makeStore();
    const d = store.acquire({ petId: 'main', lockId: 'lk-ghost' });
    assert.equal(d.ok, false);
    if (d.ok || d.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(d.cause, 'unknown');
    assert.equal(store.current('main'), null, '不许借续期把锁重新建起来');
  });

  test('过期后再拿旧编号续期 → lock-lost / expired（不复活），且可以正常建新锁', () => {
    const { store, advance, leaves } = makeStore();
    const first = store.acquire({ petId: 'main', ttl: 1_000 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    advance(1_000);
    const late = store.acquire({ petId: 'main', lockId: first.lockId });
    assert.equal(late.ok, false);
    if (late.ok || late.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(late.cause, 'expired');
    // 过期时顺手同步了一次叶子（宿主侧没有定时器，这是渲染端之外唯一的一处"到点写 S"）
    assert.deepEqual(leaves[leaves.length - 1], { petId: 'main', data: { locked: false } });
    const fresh = store.acquire({ petId: 'main' });
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    assert.notEqual(fresh.lockId, first.lockId);
  });

  test('过期是**懒判**：没人访问时 current 也不返回它，且叶子只补写一次', () => {
    const { store, advance, leaves } = makeStore();
    store.acquire({ petId: 'main', ttl: 1_000 });
    advance(2_000);
    assert.equal(store.current('main'), null);
    assert.equal(store.locked('main'), false);
    const written = leaves.length;
    assert.equal(store.current('main'), null);
    assert.equal(leaves.length, written, '第二次读不该再写一遍叶子');
  });

  test('新锁建立后旧墓碑作废：旧编号从此是 unknown（不是上一轮的 expired）', () => {
    const { store, advance } = makeStore();
    const first = store.acquire({ petId: 'main', ttl: 1_000 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    advance(1_000);
    store.acquire({ petId: 'main' }); // 建新锁
    const d = store.acquire({ petId: 'main', lockId: first.lockId });
    assert.equal(d.ok, false);
    if (d.ok || d.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(d.cause, 'unknown');
  });
});

describe('LockStore —— ttl 校验', () => {
  test('缺省 / null → 2min；边界值合法', () => {
    assert.equal(normalizeLockTtl(undefined, LOCK_DEFAULT_TTL_MS), LOCK_DEFAULT_TTL_MS);
    assert.equal(normalizeLockTtl(null, LOCK_DEFAULT_TTL_MS), LOCK_DEFAULT_TTL_MS);
    assert.equal(normalizeLockTtl(LOCK_MIN_TTL_MS, 0), LOCK_MIN_TTL_MS);
    assert.equal(normalizeLockTtl(LOCK_MAX_TTL_MS, 0), LOCK_MAX_TTL_MS);
    assert.equal(normalizeLockTtl(1_234.5, 0), 1_234.5, '毫秒小数无害，照收');
  });

  test('非法 → null（越界不夹取：调用方写错时长应当立刻知道）', () => {
    for (const bad of [0, -1, LOCK_MIN_TTL_MS - 1, LOCK_MAX_TTL_MS + 1, NaN, Infinity, '30000', {}, []]) {
      assert.equal(normalizeLockTtl(bad, LOCK_DEFAULT_TTL_MS), null, `${String(bad)} 应当非法`);
    }
  });

  test('ttl 非法 → bad-request，且**不建锁**', () => {
    const { store } = makeStore();
    const d = store.acquire({ petId: 'main', ttl: 0 });
    assert.equal(d.ok, false);
    if (d.ok || d.reason !== 'bad-request') throw new Error('应当是 bad-request');
    assert.equal(store.current('main'), null);
  });

  test('lockId 不是字符串 → bad-request（而不是当成"没给"去新建）', () => {
    const { store } = makeStore();
    const d = store.acquire({ petId: 'main', lockId: 123 });
    assert.equal(d.ok, false);
    if (d.ok || d.reason !== 'bad-request') throw new Error('应当是 bad-request');
    assert.equal(store.current('main'), null);
  });
});

describe('LockStore —— 释放', () => {
  test('lockId 匹配 → 撤锁、写叶子 {locked:false}，此后旧编号是 released', () => {
    const { store, leaves } = makeStore();
    const d = store.acquire({ petId: 'main' });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const r = store.release({ petId: 'main', lockId: d.lockId });
    assert.deepEqual(r, { ok: true, petId: 'main', released: true });
    assert.deepEqual(leaves[leaves.length - 1], { petId: 'main', data: { locked: false } });
    const again = store.acquire({ petId: 'main', lockId: d.lockId });
    assert.equal(again.ok, false);
    if (again.ok || again.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(again.cause, 'released');
  });

  test('无锁时释放 → 幂等 ok（released:false），不写叶子', () => {
    const { store, leaves } = makeStore();
    assert.deepEqual(store.release({ petId: 'main', lockId: 'lk-any' }), {
      ok: true,
      petId: 'main',
      released: false,
    });
    assert.deepEqual(leaves, []);
  });

  test('有锁但 lockId 不匹配 → lock-lost，**绝不误放别人的锁**', () => {
    const { store } = makeStore();
    const d = store.acquire({ petId: 'main' });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const r = store.release({ petId: 'main', lockId: 'lk-someone-else' });
    assert.equal(r.ok, false);
    if (r.ok || r.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(r.cause, 'unknown');
    assert.equal(store.current('main')?.lockId, d.lockId, '锁必须还在');
  });

  test('force:true → 无条件撤锁，cause = preempted（用户接管）', () => {
    const { store, leaves } = makeStore();
    const d = store.acquire({ petId: 'main' });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.deepEqual(store.release({ petId: 'main', force: true }), { ok: true, petId: 'main', released: true });
    assert.deepEqual(leaves[leaves.length - 1], { petId: 'main', data: { locked: false } });
    const late = store.acquire({ petId: 'main', lockId: d.lockId });
    assert.equal(late.ok, false);
    if (late.ok || late.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(late.cause, 'preempted', '持锁者要能分清"我自己放的"和"被用户抢走的"');
  });

  test('force 只认严格 true：字符串 "true" 不算（宽松会把误传当真，代价是撤掉别人的锁）', () => {
    const { store } = makeStore();
    store.acquire({ petId: 'main' });
    const r = store.release({ petId: 'main', force: 'true' });
    assert.equal(r.ok, false);
    if (r.ok || r.reason !== 'bad-request') throw new Error('应当是 bad-request');
    assert.notEqual(store.current('main'), null);
  });

  test('lockId 与 force 同给 / 都不给 → bad-request（意图不明，不替调用方猜）', () => {
    const { store } = makeStore();
    store.acquire({ petId: 'main' });
    for (const args of [{ lockId: 'lk-x', force: true }, {}]) {
      const r = store.release({ petId: 'main', ...args });
      assert.equal(r.ok, false);
      if (r.ok || r.reason !== 'bad-request') throw new Error('应当是 bad-request');
    }
    assert.notEqual(store.current('main'), null);
  });

  test('force 释放一个没被占用的宠物 → 幂等 ok', () => {
    const { store } = makeStore();
    assert.deepEqual(store.release({ petId: 'main', force: true }), { ok: true, petId: 'main', released: false });
  });

  test('releaseAll（插件卸载路径）→ 全部撤掉并各写一次叶子', () => {
    const { store, leaves } = makeStore();
    store.acquire({ petId: 'main' });
    store.acquire({ petId: 'pet-2' });
    leaves.length = 0;
    store.releaseAll();
    assert.equal(store.anyLocked(), false);
    assert.deepEqual(leaves, [
      { petId: 'main', data: { locked: false } },
      { petId: 'pet-2', data: { locked: false } },
    ]);
  });
});

describe('LockStore —— 动作端点的门禁（gate）', () => {
  test('无锁 + 没带编号 → 放行（既有调用方一个字都不用改）', () => {
    const { store } = makeStore();
    assert.deepEqual(store.gate('main', ''), { ok: true });
  });

  test('无锁 + 带了编号 → lock-lost（旧租约不能继续执行迟到请求）', () => {
    const { store } = makeStore();
    const g = store.gate('main', 'lk-随便传的');
    assert.equal(g.ok, false);
    if (g.ok || g.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(g.cause, 'unknown', '从没建过锁 → unknown');
  });

  test('有锁 + 没带 → lock-required', () => {
    const { store } = makeStore();
    store.acquire({ petId: 'main' });
    const g = store.gate('main', '');
    assert.equal(g.ok, false);
    if (g.ok || g.reason !== 'lock-required') throw new Error('应当是 lock-required');
  });

  test('有锁 + 带对了 → 放行（持锁者自己的演出不受影响）', () => {
    const { store } = makeStore();
    const d = store.acquire({ petId: 'main' });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.deepEqual(store.gate('main', d.lockId), { ok: true });
  });

  test('有锁 + 带错了 → lock-lost / unknown', () => {
    const { store } = makeStore();
    store.acquire({ petId: 'main' });
    const g = store.gate('main', 'lk-wrong');
    assert.equal(g.ok, false);
    if (g.ok || g.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(g.cause, 'unknown');
  });

  test('锁过期后：没带编号放行，带旧编号 → lock-lost / expired', () => {
    const { store, advance } = makeStore();
    const d = store.acquire({ petId: 'main', ttl: 1_000 });
    advance(1_000);
    assert.deepEqual(store.gate('main', ''), { ok: true });
    if (!d.ok) return;
    const g = store.gate('main', d.lockId);
    assert.equal(g.ok, false);
    if (g.ok || g.reason !== 'lock-lost') throw new Error('应当是 lock-lost');
    assert.equal(g.cause, 'expired', '墓碑记着它为什么没了');
  });

  test('锁是按宠物分开的：占用 main 不影响 pet-2', () => {
    const { store } = makeStore();
    store.acquire({ petId: 'main' });
    assert.equal(store.gate('main', '').ok, false);
    assert.deepEqual(store.gate('pet-2', ''), { ok: true });
    assert.equal(store.anyLocked(), true);
  });
});

describe('LockStore —— 第三方之间不互相抢占', () => {
  test('先到先得：A 持锁时 B 只能拿到 locked + expiresAt，不能顶掉 A', () => {
    const { store } = makeStore();
    const a = store.acquire({ petId: 'main' });
    assert.equal(a.ok, true);
    if (!a.ok) return;
    const b = store.acquire({ petId: 'main' });
    assert.equal(b.ok, false);
    if (b.ok || b.reason !== 'locked') throw new Error('应当是 locked');
    assert.equal(b.expiresAt, a.expiresAt);
    assert.deepEqual(store.gate('main', a.lockId), { ok: true }, 'A 的锁不受影响');
  });
});
