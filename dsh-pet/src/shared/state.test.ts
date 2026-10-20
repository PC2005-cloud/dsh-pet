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

import {
  flattenCounters,
  readAnim,
  readBalance,
  readPosition,
  readSay,
  readThrow,
  takeChanged,
  type PollState,
} from './state.ts';

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

describe('readAnim —— 点播动画叶子（名字或地址 + 回执编号）', () => {
  test('名字与 playbackId 都取到（渲染端据此在四个时机上报真实状态）', () => {
    const hit = readAnim({ counter: 1, data: { name: '拉侧栏-拉拽', playbackId: 'pb-abc-1' } });
    assert.deepEqual(hit, { name: '拉侧栏-拉拽', url: undefined, playbackId: 'pb-abc-1', facing: undefined });
  });

  test('url 形态（issue #122 第 1 条）：地址取到、name 缺席', () => {
    const hit = readAnim({ counter: 1, data: { url: 'https://cdn.example.com/拉侧栏.webm' } });
    assert.deepEqual(hit, {
      name: undefined,
      url: 'https://cdn.example.com/拉侧栏.webm',
      playbackId: undefined,
      facing: undefined,
    });
  });

  test('url 形态一样带 playbackId（两条路的回执语义相同）', () => {
    const hit = readAnim({ counter: 1, data: { url: 'http://127.0.0.1:8080/a/x.webm', playbackId: 'pb-1' } });
    assert.equal(hit?.url, 'http://127.0.0.1:8080/a/x.webm');
    assert.equal(hit?.playbackId, 'pb-1');
  });

  test('老 host 不写 playbackId → undefined（按"无回执"处理，不是非法数据）', () => {
    const hit = readAnim({ counter: 1, data: { name: '东张西望' } });
    assert.equal(hit?.name, '东张西望');
    assert.equal(hit?.playbackId, undefined);
  });

  test('playbackId 形状非法（非字符串 / 空串）→ 归一成 undefined，不影响名字', () => {
    assert.equal(readAnim({ counter: 1, data: { name: 'A', playbackId: 42 } })?.playbackId, undefined);
    assert.equal(readAnim({ counter: 1, data: { name: 'A', playbackId: '' } })?.playbackId, undefined);
    assert.equal(readAnim({ counter: 1, data: { name: 'A', playbackId: null } })?.name, 'A');
  });

  test('两个都给时两个都取到（host 判定层保证不会这么写；消费端以 url 优先）', () => {
    const hit = readAnim({ counter: 1, data: { name: 'A', url: 'https://x/y.webm' } });
    assert.equal(hit?.name, 'A');
    assert.equal(hit?.url, 'https://x/y.webm');
  });

  test('脏数据 → null（消费端跳过这一拍）', () => {
    assert.equal(readAnim({ counter: 1, data: null }), null);
    assert.equal(readAnim({ counter: 1, data: 'nope' }), null);
    // 两个都缺席 = 形状非法：宿主写端保证恰好一个，读取端不替它猜
    assert.equal(readAnim({ counter: 1, data: { name: '' } }), null);
    assert.equal(readAnim({ counter: 1, data: { name: 42 } }), null);
    assert.equal(readAnim({ counter: 1, data: { url: '' } }), null);
    assert.equal(readAnim({ counter: 1, data: { url: 42 } }), null);
    assert.equal(readAnim({ counter: 1, data: { playbackId: 'pb-1' } }), null, '只有回执编号不算一条指令');
  });

  test('facing（POST /anim 的朝向参数）：合法值取到，name / url 两种形态都适用', () => {
    assert.equal(readAnim({ counter: 1, data: { name: '东张西望', facing: 'right' } })?.facing, 'right');
    assert.equal(readAnim({ counter: 1, data: { url: 'https://x/y.webm', facing: 'left' } })?.facing, 'left');
  });

  test('facing 缺省 → undefined（= **不动朝向**，不是回落 left）', () => {
    assert.equal(readAnim({ counter: 1, data: { name: 'A' } })?.facing, undefined);
    assert.equal(readAnim({ counter: 1, data: { name: 'A', facing: null } })?.facing, undefined);
  });

  test('facing 形状非法 → 归一成 undefined，且不影响这条指令本身', () => {
    for (const bad of ['LEFT', 'Right', 'up', '', '   ', 42, true, {}]) {
      const hit = readAnim({ counter: 1, data: { name: 'A', facing: bad } });
      assert.equal(hit?.facing, undefined, JSON.stringify(bad) + ' 不应被当成朝向');
      assert.equal(hit?.name, 'A', '脏 facing 不该让整条指令作废（照样播，只是不动朝向）');
    }
  });
});

describe('readSay —— 说话叶子（弹气泡 / 清空 两种形态）', () => {
  /** 只取"弹气泡"形态（清空 / 脏数据都归 null），让断言短一点 */
  const say = (data: unknown) => {
    const hit = readSay({ counter: 1, data });
    return hit && hit.kind === 'say' ? hit : null;
  };

  test('弹气泡：文本与配图取到；不带 duration/anim 时两者都 undefined（= 老行为 10s + 联动）', () => {
    assert.deepEqual(say({ text: '主人今天也要加油哦～', image: '可爱' }), {
      kind: 'say',
      text: '主人今天也要加油哦～',
      image: '可爱',
      url: undefined,
      duration: undefined,
      anim: undefined,
    });
  });

  test('配图的 url 形态（issue #122 第 1 条）：地址取到、image 缺席', () => {
    const hit = say({ text: 'x', url: 'https://cdn.example.com/拒绝.png' });
    assert.equal(hit?.url, 'https://cdn.example.com/拒绝.png');
    assert.equal(hit?.image, undefined);
  });

  test('配图两种形态并列、由字段名区分：两个都给时两个都取到（host 判定层保证不会这么写）', () => {
    const hit = say({ text: 'x', image: '可爱', url: 'https://cdn.example.com/拒绝.png' });
    assert.equal(hit?.image, '可爱');
    assert.equal(hit?.url, 'https://cdn.example.com/拒绝.png');
  });

  test('url 脏值当"没给"（非字符串不毁掉整拍），文本照常显示', () => {
    for (const v of [42, {}, null, undefined]) {
      assert.equal(say({ text: 'x', url: v })?.url, undefined, `url=${JSON.stringify(v)} 应归一成 undefined`);
    }
    // 空串与 image 同口径：**原样透传**——读取器只做类型收窄，不做 trim / 非空判定
    //（非空由宿主写端保证）。消费端拿到空串会走纯文本路径，无副作用。
    assert.equal(say({ text: 'x', url: '' })?.url, '');
    assert.equal(say({ text: 'x', url: 42 })?.text, 'x');
  });

  test('duration / anim 原样带出（含 0 与 false 这两个"有含义的假值"）', () => {
    assert.equal(say({ text: 'x', duration: 0, anim: false })?.duration, 0, 'duration=0 不能被兜成缺省');
    assert.equal(say({ text: 'x', duration: 0, anim: false })?.anim, false);
    assert.equal(say({ text: 'x', duration: 3000, anim: true })?.duration, 3000);
    assert.equal(say({ text: 'x', duration: 3000, anim: true })?.anim, true);
  });

  test('清空形态：{ clear: true } → { kind: "clear" }（**空文本表达不了它**）', () => {
    assert.deepEqual(readSay({ counter: 1, data: { clear: true } }), { kind: 'clear' });
    // 空文本被判非法、整拍跳过——这正是"清空"必须有独立形态的原因。
    // 纯空白不归这里管：host 写入前已经 trim 过，readSay 只做形状校验。
    assert.equal(readSay({ counter: 1, data: { text: '' } }), null);
    assert.equal(say({ text: '   ' })?.text, '   ');
  });

  test('clear 优先于 text：两个都在时按清空处理（host 不会这么写，但形状上要确定）', () => {
    assert.deepEqual(readSay({ counter: 1, data: { clear: true, text: 'x' } }), { kind: 'clear' });
  });

  test('clear 只认严格 true（"yes"/1 之类不算，免得脏数据把气泡误清掉）', () => {
    for (const v of ['yes', 1, {}, null]) {
      assert.equal(say({ clear: v, text: 'x' })?.text, 'x', `clear=${JSON.stringify(v)} 不应判成清空`);
    }
  });

  test('duration 脏值当"没给"（负数 / NaN / Infinity / 字符串），不毁掉整拍', () => {
    for (const v of [-1, NaN, Infinity, '3000', {}]) {
      assert.equal(
        say({ text: 'x', duration: v })?.duration,
        undefined,
        `duration=${JSON.stringify(v)} 应归一成 undefined`,
      );
    }
  });

  test('脏数据 → null（消费端跳过这一拍）', () => {
    assert.equal(readSay({ counter: 1, data: null }), null);
    assert.equal(readSay({ counter: 1, data: 'nope' }), null);
    assert.equal(readSay({ counter: 1, data: {} }), null);
    assert.equal(readSay({ counter: 1, data: { text: 42 } }), null);
  });
});

describe('readPosition —— 位置指令叶子（中心归一化坐标 + 运动模式）', () => {
  test('instant / spring：坐标与模式都取到，duration 恒为 0（这两个模式不用时间）', () => {
    assert.deepEqual(readPosition({ counter: 1, data: { x: 0.5, y: 0.35, mode: 'instant' } }), {
      x: 0.5,
      y: 0.35,
      mode: 'instant',
      duration: 0,
    });
    assert.deepEqual(readPosition({ counter: 1, data: { x: 0.5, y: 0.35, mode: 'spring' } }), {
      x: 0.5,
      y: 0.35,
      mode: 'spring',
      duration: 0,
    });
  });

  test('line：duration 一起取到（`0` 也合法 = 立即到位）', () => {
    assert.deepEqual(readPosition({ counter: 1, data: { x: 0.5, y: 0.35, mode: 'line', duration: 1200 } }), {
      x: 0.5,
      y: 0.35,
      mode: 'line',
      duration: 1200,
    });
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.35, mode: 'line', duration: 0 } })?.duration, 0);
  });

  test('边界值 0 与 1 合法（中心可到屏幕边缘）', () => {
    assert.deepEqual(readPosition({ counter: 1, data: { x: 0, y: 1, mode: 'spring' } }), {
      x: 0,
      y: 1,
      mode: 'spring',
      duration: 0,
    });
  });

  test('mode 非法 / 缺失 → null（老叶子的 {x,y,smooth} 不再被接受：不替调用方猜模式）', () => {
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5 } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5, mode: 'ease' } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5, mode: 'LINE' } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5, smooth: true } }), null);
  });

  test('line 缺 duration（或非法）→ null（宿主一定会写；写错宁可跳过这一拍，也不猜一个时间）', () => {
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5, mode: 'line' } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5, mode: 'line', duration: -1 } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5, mode: 'line', duration: NaN } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: 0.5, mode: 'line', duration: '1200' } }), null);
  });

  test('脏数据 → null（缺坐标 / 非数字 / NaN / Infinity 都拒，不把 NaN 送进运动学）', () => {
    assert.equal(readPosition({ counter: 1, data: null }), null);
    assert.equal(readPosition({ counter: 1, data: 'nope' }), null);
    assert.equal(readPosition({ counter: 1, data: { y: 0.5, mode: 'spring' } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, mode: 'spring' } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: '0.5', y: 0.5, mode: 'spring' } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: NaN, y: 0.5, mode: 'spring' } }), null);
    assert.equal(readPosition({ counter: 1, data: { x: 0.5, y: Infinity, mode: 'spring' } }), null);
  });
});

describe('readThrow —— 抛掷指令叶子（角度 + 力度）', () => {
  test('角度与力度都取到（角度不归一化，负值原样保留）', () => {
    assert.deepEqual(readThrow({ counter: 1, data: { angle: 45, power: 1 } }), { angle: 45, power: 1 });
    assert.deepEqual(readThrow({ counter: 1, data: { angle: -90, power: 3 } }), { angle: -90, power: 3 });
  });

  test('脏数据 → null（power ≤ 0 也拒：那不是一个初速度）', () => {
    assert.equal(readThrow({ counter: 1, data: null }), null);
    assert.equal(readThrow({ counter: 1, data: 'nope' }), null);
    assert.equal(readThrow({ counter: 1, data: { angle: 45 } }), null);
    assert.equal(readThrow({ counter: 1, data: { power: 1 } }), null);
    assert.equal(readThrow({ counter: 1, data: { angle: '45', power: 1 } }), null);
    assert.equal(readThrow({ counter: 1, data: { angle: 45, power: 0 } }), null);
    assert.equal(readThrow({ counter: 1, data: { angle: 45, power: -1 } }), null);
    assert.equal(readThrow({ counter: 1, data: { angle: 45, power: NaN } }), null);
  });
});
