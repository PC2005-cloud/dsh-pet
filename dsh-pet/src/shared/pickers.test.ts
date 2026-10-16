/**
 * pickers 事件档位逻辑单元测试 —— 钉住「数组槽位 = 档内随机 + 避免连续重复」与
 * 「成员判断必须穿透数组槽位」（直接 includes 会漏掉嵌套候选）两套语义，
 * 以及随机链掷骰 rollKind（含宠物固定 fixedEnabled）与「双端必须都传该开关」的源码守卫。
 *
 * 跑法：node --experimental-strip-types --test src/shared/pickers.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isEventAnim, nextWorkStatusAnim, pickSlot, poolIncludes, rollKind, slotIncludes } from './pickers.ts';

describe('pickSlot —— 事件档位取值', () => {
  test('字符串槽位原样返回（原行为不变），exclude 不影响字符串', () => {
    assert.equal(pickSlot('工作思考'), '工作思考');
    assert.equal(pickSlot('工作思考', '工作思考'), '工作思考');
  });

  test('数组槽位档内随机抽 1', () => {
    const saved = Math.random;
    try {
      Math.random = () => 0.1;
      assert.equal(pickSlot(['A', 'B']), 'A');
      Math.random = () => 0.9;
      assert.equal(pickSlot(['A', 'B']), 'B');
    } finally {
      Math.random = saved;
    }
  });

  test('exclude 优先避开：排除后池非空时不抽被排除项', () => {
    const saved = Math.random;
    try {
      // 排除 'B' 后只剩 ['C']：无论随机数多大都只能抽到 'C'
      Math.random = () => 0.999;
      assert.equal(pickSlot(['B', 'C'], 'B'), 'C');
    } finally {
      Math.random = saved;
    }
  });

  test('单候选 + 排除自己：退回原数组，宁可重复也不返回 undefined', () => {
    const saved = Math.random;
    try {
      Math.random = () => 0.0;
      assert.equal(pickSlot(['Solo'], 'Solo'), 'Solo');
    } finally {
      Math.random = saved;
    }
  });
});

describe('成员判断 —— 数组槽位成员也要命中', () => {
  // 与 config.jsonc 同构：balance / whisper / workStatus，其中部分档位是候选数组
  const events = {
    balance: ['余额-钱袋满溢', ['余额-金袋叮当', '余额-金袋叮当2']],
    workStatus: [['工作思考', '开始工作'], '认真工作'],
  };

  test('slotIncludes：字符串按名比，数组查成员', () => {
    assert.equal(slotIncludes('认真工作', '认真工作'), true);
    assert.equal(slotIncludes('认真工作', '开始工作'), false);
    assert.equal(slotIncludes(['工作思考', '开始工作'], '开始工作'), true);
    assert.equal(slotIncludes(['工作思考', '开始工作'], '认真工作'), false);
  });

  test('poolIncludes：档位数组（含嵌套候选）命中', () => {
    assert.equal(poolIncludes(events.workStatus, '工作思考'), true);
    assert.equal(poolIncludes(events.workStatus, '开始工作'), true);
    assert.equal(poolIncludes(events.workStatus, '认真工作'), true);
    assert.equal(poolIncludes(events.workStatus, '余额-钱袋满溢'), false);
  });

  test('isEventAnim：整个 events 段（含嵌套候选）命中；未定义返回 false', () => {
    assert.equal(isEventAnim(events, '余额-钱袋满溢'), true);
    assert.equal(isEventAnim(events, '余额-金袋叮当2'), true);
    assert.equal(isEventAnim(events, '开始工作'), true);
    assert.equal(isEventAnim(events, '不存在'), false);
    assert.equal(isEventAnim(undefined, '开始工作'), false);
  });
});

describe('nextWorkStatusAnim —— workStatus 播完续播决策（档内轮换）', () => {
  // 与 config.jsonc 同构：档 0 双候选、档 1 单动画、其余单动画
  const wsPool = [['工作思考', '开始工作'], '认真工作', '长时间工作看表', '工作被打扰', '工作结束', '摸鱼被抓'];

  test('多候选档位：排除当前段，返回另一候选（不连抽同一个）', () => {
    const saved = Math.random;
    try {
      Math.random = () => 0.999; // 若排除失效会抽到 工作思考
      assert.equal(nextWorkStatusAnim(wsPool, '工作思考'), '开始工作');
      Math.random = () => 0.0;
      assert.equal(nextWorkStatusAnim(wsPool, '开始工作'), '工作思考');
    } finally {
      Math.random = saved;
    }
  });

  test('轮换必然换来换去：双候选下连续两次轮换必为不同段', () => {
    const pool = [['A', 'B']];
    assert.equal(nextWorkStatusAnim(pool, 'A'), 'B');
    assert.equal(nextWorkStatusAnim(pool, 'B'), 'A');
  });

  test('单动画/单候选档位 → null（原样续播，不轮换）', () => {
    assert.equal(nextWorkStatusAnim(wsPool, '认真工作'), null);
    assert.equal(nextWorkStatusAnim(wsPool, '长时间工作看表'), null);
    assert.equal(nextWorkStatusAnim([['Solo']], 'Solo'), null);
  });

  test('动画不属于 workStatus 池 → null（按原语义处理，如回 idle）', () => {
    assert.equal(nextWorkStatusAnim(wsPool, '余额-钱袋满溢'), null);
    assert.equal(nextWorkStatusAnim([], '认真工作'), null);
  });
});

describe('rollKind —— 随机链掷骰（含宠物固定 fixedEnabled）', () => {
  /** 与内置 config.jsonc 同形的顶层权重（idle 10 / turn 5 / move 5 / 余量 80 = 随机动作） */
  const w = { idle: 10, turn: 5, move: 5 };

  test('默认：三档边界（idle / turn / move / 余量 action）', () => {
    assert.equal(rollKind(0, w), 'idle');
    assert.equal(rollKind(0.0999, w), 'idle');
    assert.equal(rollKind(0.1, w), 'turn');
    assert.equal(rollKind(0.1499, w), 'turn');
    assert.equal(rollKind(0.15, w), 'move');
    assert.equal(rollKind(0.1999, w), 'move');
    assert.equal(rollKind(0.2, w), 'action');
    assert.equal(rollKind(0.9999, w), 'action');
  });

  test('宠物固定：turn / move 两档按 0 算，只可能 idle 或 action', () => {
    // idle 的绝对边界原样不动（不做归一化：turn/move 的份额直接并入 action）
    assert.equal(rollKind(0, w, { fixed: true }), 'idle');
    assert.equal(rollKind(0.0999, w, { fixed: true }), 'idle');
    // 原本落 turn / move 的两个区间，现在全部归 action
    assert.equal(rollKind(0.1, w, { fixed: true }), 'action');
    assert.equal(rollKind(0.15, w, { fixed: true }), 'action');
    assert.equal(rollKind(0.1999, w, { fixed: true }), 'action');
    assert.equal(rollKind(0.9999, w, { fixed: true }), 'action');
  });

  test('宠物固定 + 全区间扫描：绝不返回 turn / move', () => {
    for (let i = 0; i < 1000; i++) {
      const roll = i / 1000;
      const k = rollKind(roll, w, { fixed: true });
      assert.ok(k === 'idle' || k === 'action', `roll=${roll} 抽到了 ${k}（宠物固定后不该出现）`);
    }
  });

  test('宠物固定 + idle = 0：退化为只会播原地随机动作（不除零、不落空）', () => {
    const zero = { idle: 0, turn: 5, move: 5 };
    assert.equal(rollKind(0, zero, { fixed: true }), 'action');
    assert.equal(rollKind(0.9999, zero, { fixed: true }), 'action');
  });

  test('缺省 / 显式 false = 原行为（开关关闭时随机链逐位不变）', () => {
    for (const roll of [0, 0.05, 0.12, 0.17, 0.5, 0.9999]) {
      assert.equal(rollKind(roll, w, {}), rollKind(roll, w), `roll=${roll}：空选项应等价于不传`);
      assert.equal(rollKind(roll, w, { fixed: false }), rollKind(roll, w), `roll=${roll}：false 应等价于不传`);
    }
  });
});

describe('宠物固定 —— 双端一致守卫（两端必须都把这个开关传进掷骰）', () => {
  // 背景：随机链在两端各有一层薄壳（浏览器 React 组件 / 桌面 DOM sprite），掷骰本身共用
  // src/shared/pickers 的 rollKind。若只在其中一端传 fixed，另一端的宠物照样自己走/自己翻，
  // 表现为「设置页勾了没用」——而且只在一种显示模式下复现，极难排查。这里把两侧钉住。
  const browserShell = readFileSync(fileURLToPath(new URL('../client/pet.ts', import.meta.url)), 'utf8');
  const desktopShell = readFileSync(
    fileURLToPath(new URL('../../runtime/electron-helper/sprite.js', import.meta.url)),
    'utf8',
  );

  test('浏览器壳（client/pet.ts 的 pickNext）传了 fixed', () => {
    assert.ok(
      /rollKind\([^)]*fixed:/.test(browserShell),
      'client/pet.ts 的 pickNext 必须把 fixed 传进 rollKind（否则浏览器里的宠物照旧乱走）',
    );
  });

  test('桌面壳（sprite.js 的 playIdle）传了 fixed', () => {
    assert.ok(
      /rollKind\([^)]*fixed:/.test(desktopShell),
      'runtime/electron-helper/sprite.js 的 playIdle 必须把 fixed 传进 rollKind（否则桌面里的宠物照旧乱走）',
    );
  });

  test('两端传的都是该宠物自己的配置项（不是写死的 true/false）', () => {
    assert.ok(/fixed:\s*cfg\.fixedEnabled/.test(browserShell), '浏览器壳必须传 cfg.fixedEnabled');
    assert.ok(/fixed:\s*this\.pet\.fixedEnabled/.test(desktopShell), '桌面壳必须传 this.pet.fixedEnabled');
  });
});
