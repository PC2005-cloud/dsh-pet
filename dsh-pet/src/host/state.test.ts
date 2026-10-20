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

import { MAX_STATE_WAIT_MS, parseStateWaitQuery, PollStateStore } from './state.ts';

describe('PollStateStore —— 初始形态', () => {
  test('四个全局叶子都是 {counter:0, data:null}（0 = 从未写过，前端首拉当基线）', () => {
    const s = new PollStateStore().read();
    assert.deepEqual(Object.keys(s.sections).sort(), ['balance', 'config', 'notify', 'workStatus']);
    for (const leaf of Object.values(s.sections)) assert.deepEqual(leaf, { counter: 0, data: null });
    assert.deepEqual(s.pets, {});
  });
});

describe('PollStateStore —— 配置变更信号（sections.config）', () => {
  test('纯信号叶子：data 恒为 {}，只有 counter 是有效信息', () => {
    const store = new PollStateStore();
    store.writeSection('config', {});
    const leaf = store.read().sections.config;
    assert.deepEqual(leaf.data, {});
    assert.ok(leaf.counter > 0);
  });

  test('每次写入都推进 counter（连写两次也必须能分辨出"又变了一次"）', () => {
    const store = new PollStateStore();
    store.writeSection('config', {});
    const a = store.read().sections.config.counter;
    store.writeSection('config', {});
    const b = store.read().sections.config.counter;
    assert.ok(b > a, 'counter 必须严格递增，否则同一毫秒内的第二次改动会被消费端漏掉');
  });

  test('写它不影响别的全局叶子（各叶子计数器互不干扰）', () => {
    const store = new PollStateStore();
    store.writeSection('balance', { ok: true });
    const before = store.read().sections.balance.counter;
    store.writeSection('config', {});
    assert.equal(store.read().sections.balance.counter, before);
    assert.equal(store.read().sections.notify.counter, 0, '没写过的叶子保持 0');
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

  test('宠物条目的五个槽位一起建好（没写过的槽位是 {counter:0, data:null}）', () => {
    const store = new PollStateStore();
    store.writePet('main', 'position', { x: 0.5, y: 0.5, mode: 'spring' });
    const entry = store.read().pets.main;
    // 形状恒定：只要被写过任意一个叶子，五个键就都存在（消费端不必判 undefined）
    assert.deepEqual(Object.keys(entry).sort(), ['anim', 'lock', 'position', 'say', 'throw']);
    assert.deepEqual(entry.position.data, { x: 0.5, y: 0.5, mode: 'spring' });
    assert.deepEqual(entry.say, { counter: 0, data: null }, '没写过的槽位保持空叶子');
    assert.deepEqual(entry.anim, { counter: 0, data: null });
    assert.deepEqual(entry.throw, { counter: 0, data: null });
    assert.deepEqual(entry.lock, { counter: 0, data: null }, '占用锁同样是常驻槽位（issue #122 第 4 项）');
  });

  test('position 与 throw 各自独立更新 counter（两条指令互不吞掉）', () => {
    const store = new PollStateStore();
    store.writePet('main', 'position', { x: 0.1, y: 0.2, mode: 'line', duration: 800 });
    const posCounter = store.read().pets.main.position.counter;
    store.writePet('main', 'throw', { angle: 45, power: 1 });
    const s = store.read();
    assert.ok(s.pets.main.throw.counter > posCounter, 'throw 写入必须推进自己的 counter');
    assert.equal(s.pets.main.position.counter, posCounter, 'position 的 counter 不该被 throw 的写入改动');
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

describe('PollStateStore —— 顶层 counter（整份 S 的版本号）', () => {
  test('从未写过 = 0；写过之后等于最后一次写入的编号', () => {
    const store = new PollStateStore();
    assert.equal(store.read().counter, 0);
    store.writeSection('balance', 1);
    assert.equal(store.read().counter, store.read().sections.balance.counter);
    store.writePet('main', 'say', { text: 'x' });
    assert.equal(store.read().counter, store.read().pets.main.say.counter, 'counter 必须跟着最新那次写入走');
  });
});

describe('parseStateWaitQuery —— ?since=&timeout= 的解析', () => {
  test('两者都没传 → none（立刻返回全量 = 改造前的语义）', () => {
    assert.deepEqual(parseStateWaitQuery(null, null), { kind: 'none' });
  });

  test('只传一个 → error（成对必填，与 /playback 的 wait/timeout 同一套约定）', () => {
    assert.equal(parseStateWaitQuery('5', null).kind, 'error');
    assert.equal(parseStateWaitQuery(null, '1000').kind, 'error');
  });

  test('合法值原样透出；since=0 与 timeout=0 都合法', () => {
    assert.deepEqual(parseStateWaitQuery('0', '0'), { kind: 'ok', since: 0, timeoutMs: 0 });
    assert.deepEqual(parseStateWaitQuery('1755000000000', '1000'), {
      kind: 'ok',
      since: 1755000000000,
      timeoutMs: 1000,
    });
    assert.deepEqual(parseStateWaitQuery('1', String(MAX_STATE_WAIT_MS)), {
      kind: 'ok',
      since: 1,
      timeoutMs: MAX_STATE_WAIT_MS,
    });
  });

  test('非法值一律 error（负数 / 小数 / 非数字 / 超上限 / 空串）', () => {
    const badSince = ['-1', '1.5', 'abc', '', ' ', '1e3', '+5'];
    for (const s of badSince) {
      assert.equal(parseStateWaitQuery(s, '1000').kind, 'error', `since=${JSON.stringify(s)} 应判非法`);
    }
    const badTimeout = [...badSince, String(MAX_STATE_WAIT_MS + 1)];
    for (const t of badTimeout) {
      assert.equal(parseStateWaitQuery('1', t).kind, 'error', `timeout=${JSON.stringify(t)} 应判非法`);
    }
  });
});

describe('PollStateStore.wait —— 挂起等待（长轮询）', () => {
  /** 收集唤醒次数的小工具 */
  const collector = () => {
    const seen: number[] = [];
    return { seen, onWake: () => void seen.push(seen.length) };
  };

  test('叶子被写过 → 立刻唤醒，并摘掉等待者', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const c = collector();
    const cancel = store.wait({ since: store.read().counter, timeoutMs: 10_000, onWake: c.onWake });
    assert.equal(store.waiterCount(), 1);
    store.writeSection('balance', { ok: true });
    assert.deepEqual(c.seen, [0], '写叶子必须唤醒');
    assert.equal(store.waiterCount(), 0, '唤醒后必须摘掉（否则定时器与引用都留着）');
    cancel(); // 幂等：已经摘掉了，再取消不该出事
    assert.equal(store.waiterCount(), 0);
  });

  test('写宠物叶子同样唤醒（等待条件是"任意写入"，不分 section / pets）', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const c = collector();
    store.wait({ since: store.read().counter, timeoutMs: 10_000, onWake: c.onWake });
    store.writePet('main', 'say', { text: 'x' });
    assert.deepEqual(c.seen, [0]);
  });

  test('唤醒时**叶子已经写定**（回调里 read() 必须看到新值，不能看到旧的）', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    let seenText: unknown = 'NOT_WOKEN';
    store.wait({
      since: store.read().counter,
      timeoutMs: 10_000,
      onWake: () => {
        seenText = (store.read().pets.main?.say?.data as { text?: unknown } | undefined)?.text;
      },
    });
    store.writePet('main', 'say', { text: '该喝水了' });
    assert.equal(seenText, '该喝水了', '唤醒必须发生在叶子赋值之后（放在 next() 里就会读到旧状态）');
  });

  test('没有任何写入 → 到点超时才唤醒，且只唤醒一次', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const c = collector();
    store.wait({ since: store.read().counter, timeoutMs: 1000, onWake: c.onWake });
    t.mock.timers.tick(999);
    assert.deepEqual(c.seen, [], '没到点不该醒');
    t.mock.timers.tick(1);
    assert.deepEqual(c.seen, [0]);
    assert.equal(store.waiterCount(), 0);
    t.mock.timers.tick(10_000);
    assert.deepEqual(c.seen, [0], '超时后定时器不能再响第二次');
  });

  test('timeout=0 → 下一拍就醒（等价"立刻返回"，路由不需要特判）', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const c = collector();
    store.wait({ since: store.read().counter, timeoutMs: 0, onWake: c.onWake });
    assert.deepEqual(c.seen, [], '注册时不该同步回调');
    t.mock.timers.tick(1);
    assert.deepEqual(c.seen, [0]);
  });

  test('取消 → 摘掉且不再唤醒（调用方断开走这条）', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const c = collector();
    const cancel = store.wait({ since: store.read().counter, timeoutMs: 1000, onWake: c.onWake });
    cancel();
    assert.equal(store.waiterCount(), 0);
    t.mock.timers.tick(10_000);
    assert.deepEqual(c.seen, [], '取消后定时器必须清掉，不能再回调');
  });

  test('since 已经是最新（没人写）→ 挂起期间不会被空转唤醒', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const c = collector();
    store.writeSection('balance', 1);
    store.wait({ since: store.read().counter, timeoutMs: 10_000, onWake: c.onWake });
    // 再写一次**同一个值**也算写入（counter 变），所以这里必须真的写才会醒
    store.writeSection('balance', 1);
    assert.deepEqual(c.seen, [0], 'counter 变了就是变化，与 data 是否相同无关');
  });

  test('cancelAll（插件卸载路径）→ 全部唤醒并清空', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const a = collector();
    const b = collector();
    store.wait({ since: 0, timeoutMs: 10_000, onWake: a.onWake });
    store.wait({ since: 0, timeoutMs: 10_000, onWake: b.onWake });
    assert.equal(store.waiterCount(), 2);
    store.cancelAll();
    assert.deepEqual([a.seen.length, b.seen.length], [1, 1]);
    assert.equal(store.waiterCount(), 0);
    t.mock.timers.tick(10_000);
    assert.deepEqual([a.seen.length, b.seen.length], [1, 1], 'cancelAll 之后定时器不能再响');
  });

  test('一次写入唤醒**所有**等待者（全局计数器 = 唤醒所有人，有意为之）', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new PollStateStore();
    const a = collector();
    const b = collector();
    store.wait({ since: 0, timeoutMs: 10_000, onWake: a.onWake });
    store.wait({ since: 0, timeoutMs: 10_000, onWake: b.onWake });
    store.writeSection('notify', { x: 1 });
    assert.deepEqual([a.seen.length, b.seen.length], [1, 1], '两个等待者都该醒');
    assert.equal(store.waiterCount(), 0, '不泄漏');
  });
});
