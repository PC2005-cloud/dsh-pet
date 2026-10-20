/**
 * 位置 / 抛掷指令的**纯决策层**单元测试 —— 钉住契约里最容易走样的几处：
 *
 *   - **坐标夹取**：越界夹到 `0~1`，调用方拿响应里的实际值即可，不必自己算边界；
 *   - **模式必填**：只认 `instant` / `spring` / `line` 三个字面量，缺了、拼错、大小写不对一律拒；
 *   - **duration 只在 line 模式要**：line 必填（非负有限数，`0` 合法），另两个模式给了也不看；
 *   - **宠物解析口径**：`?pet=` **必填**且必须真实存在（没给 → `pet-required`，
 *     不存在 → `unknown-pet`——绝不猜、绝不退到列表第一只）；
 *   - **不设死区**：`power` 再小也受理（死区是拖拽语义，接口是明确命令）；
 *   - 参数形状校验：字符串 / `NaN` / `Infinity` 一律拒，且**先于**宠物解析报错。
 *
 * 跑法：node --experimental-strip-types --test src/host/motion-cue.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decidePosition, decideThrow, positionLeafData } from './motion-cue.ts';

/** 最小可用成品配置：两个条目各一只宠物（与 ./anim.test.ts 同一形状） */
const cfg = {
  main: { pets: [{ id: 'main', name: 'A' }] },
  pack1: { pets: [{ id: 'pack1', name: 'B' }] },
};

/** 决策结论 → 失败原因（通过时给 null，方便断言） */
const reasonOf = (d: { ok: boolean } & Record<string, unknown>): unknown => (d.ok ? null : d.reason);

describe('decidePosition —— 参数校验、模式与夹取', () => {
  test('合法坐标与模式原样通过（非 line 模式的 duration 回 null）', () => {
    const d = decidePosition({ cfg, requested: 'main', x: 0.5, y: 0.35, mode: 'spring' });
    assert.deepEqual(d, { ok: true, petId: 'main', x: 0.5, y: 0.35, mode: 'spring', duration: null });
  });

  test('越界夹到 0~1（夹取而不是拒绝）', () => {
    const hi = decidePosition({ cfg, requested: 'main', x: 1.8, y: 99, mode: 'instant' });
    assert.deepEqual(hi, { ok: true, petId: 'main', x: 1, y: 1, mode: 'instant', duration: null });
    const lo = decidePosition({ cfg, requested: 'main', x: -3, y: -0.01, mode: 'instant' });
    assert.deepEqual(lo, { ok: true, petId: 'main', x: 0, y: 0, mode: 'instant', duration: null });
  });

  test('边界值 0 与 1 原样保留（中心可到屏幕边缘，允许半个身体出屏）', () => {
    const d = decidePosition({ cfg, requested: 'main', x: 0, y: 1, mode: 'spring' });
    assert.equal(d.ok && d.x, 0);
    assert.equal(d.ok && d.y, 1);
  });

  test('mode 必填，且只认三个字面量（大小写不对也算错）', () => {
    for (const bad of [undefined, null, '', 'SPRING', 'LINE', 'smooth', 'ease', 'linear', 1, true, {}]) {
      const d = decidePosition({ cfg, requested: 'main', x: 0.5, y: 0.5, mode: bad });
      assert.equal(reasonOf(d), 'bad-request', `mode=${String(bad)}`);
    }
  });

  test('line 模式 duration 必填：非负有限数才受理，`0` 合法（= 立即到位）', () => {
    const ok = decidePosition({ cfg, requested: 'main', x: 0.5, y: 0.5, mode: 'line', duration: 1200 });
    assert.deepEqual(ok, { ok: true, petId: 'main', x: 0.5, y: 0.5, mode: 'line', duration: 1200 });
    const zero = decidePosition({ cfg, requested: 'main', x: 0.5, y: 0.5, mode: 'line', duration: 0 });
    assert.equal(zero.ok && zero.duration, 0, '0 = 立即到位，是合法值而不是"没给"');
    for (const bad of [undefined, null, -1, -0.5, NaN, Infinity, -Infinity, '1200', true, {}]) {
      const d = decidePosition({ cfg, requested: 'main', x: 0.5, y: 0.5, mode: 'line', duration: bad });
      assert.equal(reasonOf(d), 'bad-request', `duration=${String(bad)}`);
    }
  });

  test('instant / spring 给了 duration 也**不看**（调用方复用 body 模板时不必删字段）', () => {
    for (const mode of ['instant', 'spring'] as const) {
      const d = decidePosition({ cfg, requested: 'main', x: 0.5, y: 0.5, mode, duration: 9999 });
      assert.deepEqual(d, { ok: true, petId: 'main', x: 0.5, y: 0.5, mode, duration: null });
    }
    // 连非法值都不看：这两个模式压根不用时间
    const junk = decidePosition({ cfg, requested: 'main', x: 0.5, y: 0.5, mode: 'spring', duration: -1 });
    assert.equal(junk.ok, true);
  });

  test('非有限数字 → bad-request（字符串 / NaN / Infinity / 缺失都拒）', () => {
    for (const bad of ['0.5', NaN, Infinity, -Infinity, null, undefined, {}]) {
      const d = decidePosition({ cfg, requested: 'main', x: bad, y: 0.5, mode: 'spring' });
      assert.equal(reasonOf(d), 'bad-request', `x=${String(bad)}`);
    }
    const dy = decidePosition({ cfg, requested: 'main', x: 0.5, y: NaN, mode: 'spring' });
    assert.equal(reasonOf(dy), 'bad-request');
  });
});

describe('positionLeafData —— 写进 S 叶子的载荷形状', () => {
  test('line 带 duration，其余模式不带（叶子形状本身就是语义）', () => {
    assert.deepEqual(positionLeafData({ x: 0.5, y: 0.35, mode: 'line', duration: 1200 }), {
      x: 0.5,
      y: 0.35,
      mode: 'line',
      duration: 1200,
    });
    assert.deepEqual(positionLeafData({ x: 0.5, y: 0.35, mode: 'spring', duration: null }), {
      x: 0.5,
      y: 0.35,
      mode: 'spring',
    });
    assert.deepEqual(positionLeafData({ x: 0.5, y: 0.35, mode: 'instant', duration: null }), {
      x: 0.5,
      y: 0.35,
      mode: 'instant',
    });
  });

  test('非 line 模式**没有** duration 键（不是写了个 undefined）', () => {
    assert.equal('duration' in positionLeafData({ x: 0, y: 0, mode: 'instant', duration: null }), false);
    assert.equal('duration' in positionLeafData({ x: 0, y: 0, mode: 'spring', duration: null }), false);
  });
});

describe('decideThrow —— 参数校验', () => {
  test('合法角度与力度原样通过（角度不做归一化）', () => {
    const d = decideThrow({ cfg, requested: 'main', angle: 135, power: 3 });
    assert.deepEqual(d, { ok: true, petId: 'main', angle: 135, power: 3 });
    const neg = decideThrow({ cfg, requested: 'main', angle: -90, power: 0.5 });
    assert.equal(neg.ok && neg.angle, -90, '负角度是"正下"，必须原样保留（sin/cos 天然按 360 周期）');
  });

  test('power 必须 > 0 且有限（0 / 负数 / NaN / Infinity / 字符串一律拒）', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, '1', null, undefined]) {
      const d = decideThrow({ cfg, requested: 'main', angle: 45, power: bad });
      assert.equal(reasonOf(d), 'bad-request', `power=${String(bad)}`);
    }
  });

  test('**不设死区**：极小的 power 也照样受理（死区是拖拽语义，接口是明确命令）', () => {
    const d = decideThrow({ cfg, requested: 'main', angle: 45, power: 0.001 });
    assert.equal(d.ok, true);
  });

  test('角度非法 → bad-request', () => {
    for (const bad of ['45', NaN, Infinity, null, undefined]) {
      const d = decideThrow({ cfg, requested: 'main', angle: bad, power: 1 });
      assert.equal(reasonOf(d), 'bad-request', `angle=${String(bad)}`);
    }
  });
});

describe('宠物解析口径（两条接口共用）', () => {
  test('?pet= 必须显式指定：缺省 → pet-required（绝不退到"当前桌宠"/列表第一只）', () => {
    const explicit = decidePosition({ cfg, requested: 'pack1', x: 0, y: 0, mode: 'spring' });
    assert.equal(explicit.ok && explicit.petId, 'pack1');
    for (const empty of ['', '   ']) {
      const p = decidePosition({ cfg, requested: empty, x: 0, y: 0, mode: 'spring' });
      assert.equal(reasonOf(p), 'pet-required');
      const t = decideThrow({ cfg, requested: empty, angle: 0, power: 1 });
      assert.equal(reasonOf(t), 'pet-required');
    }
  });

  test('id 不存在 → unknown-pet（绝不猜、绝不退到列表第一只）', () => {
    const d = decidePosition({ cfg, requested: 'nope', x: 0, y: 0, mode: 'spring' });
    assert.equal(reasonOf(d), 'unknown-pet');
    const t = decideThrow({ cfg, requested: 'nope', angle: 0, power: 1 });
    assert.equal(reasonOf(t), 'unknown-pet');
  });

  test('参数非法**优先**于宠物解析报错（参数是调用方的错，先纠它）', () => {
    const d = decidePosition({ cfg, requested: 'nope', x: 'bad', y: 0, mode: 'spring' });
    assert.equal(reasonOf(d), 'bad-request');
    const m = decidePosition({ cfg, requested: 'nope', x: 0, y: 0, mode: 'nope' });
    assert.equal(reasonOf(m), 'bad-request', 'mode 非法同样先于宠物解析报错');
    const t = decideThrow({ cfg, requested: 'nope', angle: 0, power: -1 });
    assert.equal(reasonOf(t), 'bad-request');
  });
});
