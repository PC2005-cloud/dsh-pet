/**
 * 轮询统一状态存储（S）单元测试 —— 钉住整个设计的地基：counter 语义。
 *
 * 为什么单独钉这个：前端**只**靠"counter 变了"决定要不要渲染。
 *   - counter 漏更新 → 写了数据前端也不刷新（静默失效，最难查）；
 *   - counter 用自增（0,1,2…）→ 宿主重启归零，而前端手里还存着旧值，对比永久失效
 *     （改造前的 /notify 就是这个毛病：重启后 seq 归零，`seq <= 旧值` 恒成立 → 通知再也不弹）；
 *   - counter 用 Date.now() 但同一毫秒连写两次 → 第二次被当成"没变化"吞掉。
 * 本文件把这三条都钉死。
 *
 * 跑法：node --experimental-strip-types --test src/host/state.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PollStateStore } from './state.ts';

describe('PollStateStore —— 初始形态', () => {
  test('三个全局叶子都是 {counter:0, data:null}（0 = 从未写过，前端首拉当基线）', () => {
    const s = new PollStateStore().read();
    assert.deepEqual(Object.keys(s.sections).sort(), ['balance', 'notify', 'workStatus']);
    for (const leaf of Object.values(s.sections)) assert.deepEqual(leaf, { counter: 0, data: null });
    assert.deepEqual(s.pets, {});
  });
});

describe('PollStateStore —— 写入与读取', () => {
  test('写全局叶子：counter 变、data 原样', () => {
    const store = new PollStateStore();
    const payload = { ok: true, provider: 'deepseek' };
    store.writeSection('balance', payload);
    const leaf = store.read().sections.balance;
    assert.deepEqual(leaf.data, payload);
    assert.ok(leaf.counter > 0, 'counter 必须是有效时间戳');
  });

  test('写宠物叶子：条目自动建立，互不干扰', () => {
    const store = new PollStateStore();
    store.writePet('main', 'say', { text: '你好' });
    store.writePet('pet-2', 'say', { text: '在呢' });
    const s = store.read();
    assert.deepEqual(s.pets.main.say.data, { text: '你好' });
    assert.deepEqual(s.pets['pet-2'].say.data, { text: '在呢' });
    assert.notEqual(s.pets.main.say.counter, s.pets['pet-2'].say.counter);
  });

  test('data 允许 null（表示"还没有数据"，消费端跳过渲染）', () => {
    const store = new PollStateStore();
    store.writeSection('notify', null);
    assert.equal(store.read().sections.notify.data, null);
  });

  test('叶子整体替换：先读到的引用不会被后续写入改动（半新半旧不可能发生）', () => {
    const store = new PollStateStore();
    store.writeSection('workStatus', { state: 'working' });
    const before = store.read().sections.workStatus;
    store.writeSection('workStatus', { state: null });
    assert.deepEqual(before.data, { state: 'working' }, '旧引用必须保持旧值');
    assert.deepEqual(store.read().sections.workStatus.data, { state: null });
  });

  test('read() 返回的 sections 是副本：外部改动不影响内部状态', () => {
    const store = new PollStateStore();
    const snapshot = store.read();
    delete (snapshot.sections as Record<string, unknown>).balance;
    assert.ok(store.read().sections.balance, '内部状态不该被调用方改坏');
  });
});

describe('PollStateStore —— counter 必须严格递增（前端唯一的渲染判据）', () => {
  test('同一毫秒内连续写同一个叶子，counter 也不同', () => {
    const store = new PollStateStore();
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      store.writeSection('notify', { i });
      seen.add(store.read().sections.notify.counter);
    }
    assert.equal(seen.size, 50, '50 次连写必须拿到 50 个不同的 counter');
  });

  test('跨叶子也单调递增（避免同刻写入被前端按"没变化"吞掉）', () => {
    const store = new PollStateStore();
    store.writeSection('balance', 1);
    const a = store.read().sections.balance.counter;
    store.writePet('main', 'say', 2);
    const b = store.read().pets.main.say.counter;
    store.writeSection('workStatus', 3);
    const c = store.read().sections.workStatus.counter;
    assert.ok(b > a && c > b, `counter 应严格递增：${a} < ${b} < ${c}`);
  });

  test('counter 贴着墙上时间（不是从 0 开始的自增），重启后不会倒退', () => {
    const store = new PollStateStore();
    const before = Date.now();
    store.writeSection('balance', 1);
    const counter = store.read().sections.balance.counter;
    assert.ok(counter >= before, 'counter 应 ≥ 写入前的墙上时间（重启后前端手里的旧值只会更小）');
    assert.ok(counter - before < 1000, 'counter 不该明显超前于墙上时间');
  });
});
