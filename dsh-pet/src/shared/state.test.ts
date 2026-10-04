/**
 * 轮询统一状态 S 的客户端侧逻辑单元测试（拉取容错 / 拍平 / 比对 / 余额叶子解析）。
 *
 * 钉住的不变式：
 *   - 首拉只记基线、不产出变化（否则页面刷新会重放旧气泡）；
 *   - counter 没变 → 不产出（同一句话不会被反复渲染）；
 *   - 新增的 section / 宠物自动纳入（将来加叶子不用改这段逻辑）；
 *   - 脏数据（counter 非数字 / 叶子非对象）被丢弃，不把垃圾送进渲染层；
 *   - 余额叶子要解析成客户端视图（raw.data 摊平），并带上 host 标的手动标记。
 *
 * 跑法：node --experimental-strip-types --test src/shared/state.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { flattenCounters, readBalance, takeChanged, type PollState } from './state.ts';

/** 造一份 S：sections / pets 用简写（叶子值 = counter，data 用 data 字段给） */
function makeState(
  sections: Record<string, [number, unknown]>,
  pets: Record<string, Record<string, [number, unknown]>> = {},
): PollState {
  const leaf = ([counter, data]: [number, unknown]) => ({ counter, data });
  return {
    sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, leaf(v)])),
    pets: Object.fromEntries(
      Object.entries(pets).map(([petId, leaves]) => [
        petId,
        Object.fromEntries(Object.entries(leaves).map(([k, v]) => [k, leaf(v)])),
      ]),
    ),
  };
}

describe('flattenCounters —— 首拉基线', () => {
  test('路径为 sections.<名> / pets.<id>.<名>', () => {
    const s = makeState({ balance: [11, {}] }, { main: { say: [22, {}] } });
    assert.deepEqual(flattenCounters(s), { 'sections.balance': 11, 'pets.main.say': 22 });
  });

  test('空 S → 空基线（不抛）', () => {
    assert.deepEqual(flattenCounters({ sections: {}, pets: {} }), {});
  });
});

describe('takeChanged —— counter 变了才算变化', () => {
  test('没变 → 不产出（同一句话不会反复渲染）', () => {
    const baseline = { 'sections.balance': 11 };
    const changes = takeChanged(makeState({ balance: [11, { ok: true }] }), baseline);
    assert.deepEqual(changes, []);
  });

  test('变了 → 产出该叶子，并就地推进基线（下一次同样内容不再产出）', () => {
    const baseline: Record<string, number> = {};
    const s = makeState({ balance: [12, { ok: true }] });
    const first = takeChanged(s, baseline);
    assert.equal(first.length, 1);
    assert.equal(first[0].path, 'sections.balance');
    assert.deepEqual(first[0].leaf.data, { ok: true });
    assert.equal(baseline['sections.balance'], 12, '基线必须被推进');
    assert.deepEqual(takeChanged(s, baseline), [], '同一份 S 再比一次不应再产出');
  });

  test('基线里没有的叶子（新增宠物/section）也算变化', () => {
    const baseline = { 'sections.balance': 11 };
    const changes = takeChanged(
      makeState({ balance: [11, {}] }, { 'pet-9': { say: [7, { text: '新来的' }] } }),
      baseline,
    );
    assert.deepEqual(
      changes.map((c) => c.path),
      ['pets.pet-9.say'],
    );
  });

  test('多个叶子同时变化 → 全部产出（顺序：sections 在前、pets 在后）', () => {
    const baseline = { 'sections.balance': 1, 'pets.main.say': 1 };
    const changes = takeChanged(makeState({ balance: [2, {}] }, { main: { say: [2, {}] } }), baseline);
    assert.deepEqual(
      changes.map((c) => c.path),
      ['sections.balance', 'pets.main.say'],
    );
  });

  test('宠物 id 含点号也能正确区分（路径只当不透明键，绝不解析）', () => {
    const baseline: Record<string, number> = {};
    const changes = takeChanged(makeState({}, { 'a.b': { say: [5, { text: 'x' }] } }), baseline);
    assert.deepEqual(
      changes.map((c) => c.path),
      ['pets.a.b.say'],
    );
  });
});

describe('readBalance —— 余额叶子 → 客户端视图', () => {
  test('money：raw.data 摊平到视图顶层（含数据自带的档位基准与峰谷装饰）', () => {
    const hit = readBalance({
      counter: 1,
      data: {
        ok: true,
        provider: 'deepseek',
        shape: 'money',
        data: { currency: 'CNY', total: '10.00', fullBalance: '20', tier: 'idle' },
      },
    });
    assert.deepEqual(hit, {
      state: {
        provider: 'deepseek',
        shape: 'money',
        ok: true,
        currency: 'CNY',
        total: '10.00',
        granted: undefined,
        toppedUp: undefined,
        fullBalance: '20',
        tier: 'idle',
      },
      manual: false,
    });
  });

  test('windows：三窗口用量是数字才认，非数字 → null（不把 NaN 送进展示层）', () => {
    const good = readBalance({
      counter: 1,
      data: { ok: true, provider: 'opencode', shape: 'windows', data: { rolling: 1, weekly: 2, monthly: 3 } },
    });
    assert.equal(good?.state.ok, true);
    const bad = readBalance({
      counter: 1,
      data: { ok: true, provider: 'opencode', shape: 'windows', data: { rolling: 'x', weekly: 2, monthly: 3 } },
    });
    assert.equal(bad, null);
  });

  test('不可用：reason 原样保留，非法 reason 归一成 fetch-error', () => {
    const hit = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: 'credential-missing' } });
    assert.deepEqual(hit?.state, { provider: 'p', ok: false, reason: 'credential-missing', message: undefined });
    const weird = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: '???' } });
    assert.equal(weird?.state.ok === false && weird.state.reason, 'fetch-error');
  });

  test('manual 标记：host 标的 true 才算手动触发（决定"不可用时要不要必弹"）', () => {
    const manual = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: 'unsupported', manual: true } });
    assert.equal(manual?.manual, true);
    const auto = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: 'unsupported' } });
    assert.equal(auto?.manual, false);
    const notBool = readBalance({
      counter: 1,
      data: { ok: false, provider: 'p', reason: 'unsupported', manual: 'yes' },
    });
    assert.equal(notBool?.manual, false, '只有严格 true 才算');
  });

  test('脏数据 → null（消费端跳过这一拍，不抛）', () => {
    assert.equal(readBalance({ counter: 1, data: null }), null);
    assert.equal(readBalance({ counter: 1, data: 'nope' }), null);
    assert.equal(readBalance({ counter: 1, data: { ok: true, provider: 'p', shape: '未知' } }), null);
    assert.equal(readBalance({ counter: 1, data: { ok: true, provider: 'p', shape: 'money' } }), null, '缺 data 段');
  });
});
