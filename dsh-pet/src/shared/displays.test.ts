/**
 * 多显示器几何单元测试 —— 用**实测的不规则布局**钉住边界行为。
 *
 * 布局：右倒 T 型双屏（副屏竖置在右，上下都超出主屏），两屏 DIP 空间严丝合缝（缝隙 0）：
 *   主屏 DELL P2721Q  workArea 0,0 2560×1392      scaleFactor 1.5
 *   副屏 DELL P2721Q  workArea 2560,-532 1235×2147 scaleFactor 1.75  rotation 90
 * 关键性质：外接矩形 0,-532 3795×2147 里有 23.7% 的面积不属于任何显示器——
 * 主屏正上方 y∈[-532,0) 与正下方 y∈[1392,1615) 两块空洞。旧实现以外接矩形为边界，
 * 宠物会走进/飞进这两块区域并停在那里，用户完全看不到它。
 *
 * 坐标系：本文件直接用屏幕坐标（含负 y），验证这些函数不假定原点在 0。
 *
 * 跑法：node --experimental-strip-types --test src/shared/displays.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  boundingRect,
  clampPointToRegion,
  indexAtPoint,
  nearestIndex,
  rectAtPoint,
  regionHoleRatio,
  translateRects,
} from './displays.ts';
import { anchorPixel, planMove } from './motion.ts';
import { DEFAULT_PHYSICS, throwBounds, throwStep, throwStepRegion, throwSpace, screenOfBox } from './physics.ts';
import { HIT_BOX } from './constants.ts';
import type { PhysicsParams, Rect } from './types.ts';

const MAIN: Rect = { x: 0, y: 0, width: 2560, height: 1392 };
const SIDE: Rect = { x: 2560, y: -532, width: 1235, height: 2147 };
const AREAS = [MAIN, SIDE];

/** 实测宠物几何：size 462 的基准宠物 */
const SIZE = 462;
const PET_H = (SIZE * 9) / 16; // 259.875
const SIDE_ALLOW = (HIT_BOX.x0 / 640) * SIZE; // 144.375

const SPACE = throwSpace({ areas: AREAS, size: SIZE, sideAllow: SIDE_ALLOW });

/** 抛掷步进跑到静止（或到步数上限），返回终态。dt 固定 1/60。space 默认用双屏布局，可覆盖 */
function settle(
  start: { x: number; y: number; vx: number; vy: number },
  physics: PhysicsParams = DEFAULT_PHYSICS,
  maxSteps = 4000,
  space: ReturnType<typeof throwSpace> = SPACE,
): { x: number; y: number; vx: number; vy: number; screen: number; steps: number } {
  let s = { ...start };
  let screen = screenOfBox(space, start.x, start.y);
  for (let i = 0; i < maxSteps; i++) {
    const r = throwStepRegion(s, 1 / 60, space, physics);
    s = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
    screen = r.screen;
    if (r.atRest) return { ...s, screen, steps: i + 1 };
  }
  return { ...s, screen, steps: maxSteps };
}

/** 身体（包围盒内缩 sideAllow）是否被某块屏完整盖住 = 用户看得见 */
function bodyVisible(x: number, y: number): boolean {
  const cy = y + PET_H / 2;
  return rectAtPoint(AREAS, x + SIDE_ALLOW, cy) !== null && rectAtPoint(AREAS, x + SIZE - SIDE_ALLOW - 1, cy) !== null;
}

describe('displays —— 并集几何', () => {
  test('外接矩形与实测一致，且含 23.7% 空洞', () => {
    assert.deepEqual(boundingRect(AREAS), { x: 0, y: -532, width: 3795, height: 2147 });
    const ratio = regionHoleRatio(AREAS);
    assert.ok(Math.abs(ratio - 0.237) < 0.001, `hole ratio ${ratio}`);
  });

  test('主屏上方/下方的空洞不属于任何显示器', () => {
    assert.equal(rectAtPoint(AREAS, 1000, -100), null); // 主屏正上方
    assert.equal(rectAtPoint(AREAS, 1000, 1500), null); // 主屏正下方
    assert.equal(rectAtPoint(AREAS, 3000, -100), SIDE); // 同高度但在副屏 x 范围内：有屏
    assert.equal(rectAtPoint(AREAS, 1000, 700), MAIN);
  });

  test('缝隙为 0：主屏右缘的下一像素就是副屏', () => {
    assert.equal(indexAtPoint(AREAS, 2559, 700), 0);
    assert.equal(indexAtPoint(AREAS, 2560, 700), 1);
  });

  test('空洞里的点被拉回最近的屏', () => {
    assert.equal(nearestIndex(AREAS, 1000, -100), 0);
    const p = clampPointToRegion(AREAS, 1000, -100);
    assert.ok(rectAtPoint(AREAS, p.x, p.y), '夹取结果必须落在某块屏上');
    assert.deepEqual(p, { x: 1000, y: 0 });
    // 已在并集内的点原样返回
    assert.deepEqual(clampPointToRegion(AREAS, 3000, -400), { x: 3000, y: -400 });
  });

  test('translateRects 把屏幕坐标搬到视口相对坐标', () => {
    const hull = boundingRect(AREAS);
    const local = translateRects(AREAS, -hull.x, -hull.y);
    assert.deepEqual(local[0], { x: 0, y: 532, width: 2560, height: 1392 });
    assert.deepEqual(local[1], { x: 2560, y: 0, width: 1235, height: 2147 });
  });
});

describe('throwStepRegion —— 空洞是墙，屏缝不是', () => {
  test('单块屏时与 throwStep 逐位一致', () => {
    const only = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const space = throwSpace({ areas: only, size: SIZE, sideAllow: SIDE_ALLOW });
    const bounds = throwBounds({ W: 1920, H: 1080, size: SIZE, sideAllow: SIDE_ALLOW });
    let a = { x: 300, y: 200, vx: 1700, vy: -900 };
    let b = { ...a };
    for (let i = 0; i < 600; i++) {
      const ra = throwStep(a, 1 / 60, bounds, DEFAULT_PHYSICS);
      const rb = throwStepRegion(b, 1 / 60, space, DEFAULT_PHYSICS);
      assert.equal(rb.x, ra.x, `step ${i} x`);
      assert.equal(rb.y, ra.y, `step ${i} y`);
      assert.equal(rb.vx, ra.vx, `step ${i} vx`);
      assert.equal(rb.vy, ra.vy, `step ${i} vy`);
      assert.equal(rb.bounced, ra.bounced, `step ${i} bounced`);
      assert.equal(rb.atRest, ra.atRest, `step ${i} atRest`);
      a = { x: ra.x, y: ra.y, vx: ra.vx, vy: ra.vy };
      b = { x: rb.x, y: rb.y, vx: rb.vx, vy: rb.vy };
    }
  });

  test('主屏内向上甩：撞主屏天花板反弹，不飞进上方空洞', () => {
    let cur = { x: 1000, y: 200, vx: 0, vy: -2500 };
    let minY = Infinity;
    for (let i = 0; i < 240; i++) {
      const r = throwStepRegion(cur, 1 / 60, SPACE, DEFAULT_PHYSICS);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
      minY = Math.min(minY, r.y);
      assert.equal(r.screen, 0, `step ${i} 不该离开主屏`);
    }
    assert.ok(minY >= MAIN.y, `顶到 ${minY}，不得越过主屏工作区上缘 ${MAIN.y}`);
  });

  test('主屏内向右甩（高度在副屏范围内）：跨过屏缝进副屏，不被挡住', () => {
    let cur = { x: 1800, y: 600, vx: 4200, vy: -900 };
    let reachedSide = false;
    for (let i = 0; i < 600 && !reachedSide; i++) {
      const r = throwStepRegion(cur, 1 / 60, SPACE, DEFAULT_PHYSICS);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
      if (r.screen === 1) reachedSide = true;
    }
    assert.ok(reachedSide, '宠物应当能飞进副屏（屏缝不是墙）');
    // 之后随便怎么弹，最终落点仍须可见
    const end = settle({ x: 1800, y: 600, vx: 4200, vy: -900 });
    assert.ok(bodyVisible(end.x, end.y), `落点 ${end.x},${end.y} 必须可见`);
  });

  test('骑缝时不在两屏 AABB 的重叠盲区里逐帧对跳', () => {
    // x ∈ (主屏 maxX, 副屏 minX) 这段宽 2×sideAllow 的区间，两块屏的 AABB 都不接受它。
    // 越界即切屏的写法会在这里来回横跳；无状态判定必须让宠物匀速穿过去。
    const lo = SPACE.bounds[0].maxX;
    const hi = SPACE.bounds[1].minX;
    assert.ok(hi > lo, `盲区应存在：主屏 maxX=${lo} < 副屏 minX=${hi}`);
    let cur = { x: lo - 20, y: 600, vx: 600, vy: 0 };
    const noGravity: PhysicsParams = { ...DEFAULT_PHYSICS, gravity: 0 };
    for (let i = 0; i < 40; i++) {
      const r = throwStepRegion(cur, 1 / 60, SPACE, noGravity);
      assert.equal(r.bounced, false, `step ${i}（x=${r.x | 0}）不该在屏缝处反弹`);
      assert.equal(r.vx, 600, `step ${i} 速度不该被改动`);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
    }
    assert.ok(cur.x > hi, `40 帧后应已穿过盲区，实际 x=${cur.x}`);
  });

  test('副屏「超出主屏的上半段」向左甩：撞空洞的墙弹回，不飞进虚空', () => {
    // y=-400 时身体中心 ≈ -270，主屏 y 范围 [0,1392) 不含它 ⇒ 左侧无屏 ⇒ 反弹
    let cur = { x: 2700, y: -400, vx: -2600, vy: 0 };
    const noGravity: PhysicsParams = { ...DEFAULT_PHYSICS, gravity: 0 };
    let minX = Infinity;
    for (let i = 0; i < 60; i++) {
      const r = throwStepRegion(cur, 1 / 60, SPACE, noGravity);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
      minX = Math.min(minX, r.x);
      assert.ok(bodyVisible(r.x, r.y), `step ${i}：${r.x | 0},${r.y | 0} 飞进了虚空`);
    }
    assert.ok(minX >= SPACE.bounds[1].minX, `最左到 ${minX}，不得越过副屏左边界 ${SPACE.bounds[1].minX}`);
  });

  test('任意方向乱甩 200 次，落点恒可见（旧实现会落进空洞）', () => {
    let rng = 20260910;
    const rand = (): number => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 200; i++) {
      const fromSide = rand() < 0.5;
      const a = fromSide ? SIDE : MAIN;
      const x = a.x + rand() * (a.width - SIZE);
      const y = a.y + rand() * (a.height - PET_H);
      const end = settle({ x, y, vx: (rand() - 0.5) * 7000, vy: (rand() - 0.5) * 7000 });
      assert.ok(
        bodyVisible(end.x, end.y),
        `第 ${i} 次：起点 ${x | 0},${y | 0} → 落点 ${end.x | 0},${end.y | 0} 不可见`,
      );
    }
  });

  test('ceilingBounce=false 时顶部仍可飞出，但只在有屏的一侧', () => {
    const noCeil: PhysicsParams = { ...DEFAULT_PHYSICS, ceilingBounce: false };
    const end = settle({ x: 1000, y: 100, vx: 0, vy: -3000 }, noCeil);
    assert.ok(bodyVisible(end.x, end.y), `落点 ${end.x},${end.y} 必须回到可见区`);
  });
});

describe('throwStepRegion —— 任务栏条带不是墙，空洞仍是墙（面板探测）', () => {
  // 上下叠放双屏，任务栏在上屏底边（高 48）：上屏 workArea 底 1392 ≠ 下屏顶 1440，
  // 两块工作区之间隔一条 48px 条带——它属于上屏**面板**、不属于任何工作区。
  const A = { x: 0, y: 0, width: 2560, height: 1392 };
  const B = { x: 0, y: 1440, width: 2560, height: 1392 };
  const AREAS_TB = [A, B];
  const PANELS_TB = [
    { x: 0, y: 0, width: 2560, height: 1440 },
    { x: 0, y: 1440, width: 2560, height: 1440 },
  ];
  const SPACE_TB = throwSpace({ areas: AREAS_TB, panels: PANELS_TB, size: SIZE, sideAllow: SIDE_ALLOW });

  test('向下甩能穿过任务栏条带落到下屏', () => {
    let cur = { x: 1000, y: 800, vx: 0, vy: 1300 };
    let reachedBottom = false;
    for (let i = 0; i < 900 && !reachedBottom; i++) {
      const r = throwStepRegion(cur, 1 / 60, SPACE_TB, DEFAULT_PHYSICS);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
      if (r.screen === 1) reachedBottom = true;
    }
    assert.ok(reachedBottom, '应当穿过任务栏条带落到下屏');
    const end = settle({ x: 1000, y: 800, vx: 0, vy: 1300 }, DEFAULT_PHYSICS, 2400, SPACE_TB);
    assert.equal(end.screen, 1, '最终应歇在下屏');
    assert.ok(
      end.y <= B.y + B.height - PET_H + 0.001 && end.y >= B.y,
      `落点 ${end.y} 应在下屏内（贴下屏工作区底）`,
    );
  });

  test('向上甩能穿过任务栏条带飞进上屏', () => {
    let cur = { x: 1000, y: 2100, vx: 0, vy: -2300 };
    let reachedTop = false;
    for (let i = 0; i < 900 && !reachedTop; i++) {
      const r = throwStepRegion(cur, 1 / 60, SPACE_TB, DEFAULT_PHYSICS);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
      if (r.screen === 0) reachedTop = true;
    }
    assert.ok(reachedTop, '应当穿过任务栏条带飞进上屏');
  });

  test('同一布局但不传 panels（退化）：任务栏条带仍是墙（旧行为）', () => {
    const spaceNoPanels = throwSpace({ areas: AREAS_TB, size: SIZE, sideAllow: SIDE_ALLOW });
    let cur = { x: 1000, y: 800, vx: 0, vy: 1300 };
    let reachedBottom = false;
    for (let i = 0; i < 400 && !reachedBottom; i++) {
      const r = throwStepRegion(cur, 1 / 60, spaceNoPanels, DEFAULT_PHYSICS);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
      if (r.screen === 1) reachedBottom = true;
    }
    assert.equal(reachedBottom, false, '无 panels 时任务栏条带应按墙处理（旧行为）');
    assert.ok(cur.y <= A.y + A.height - PET_H + 1, `应停在任务栏上方，实际 ${cur.y}`);
  });

  test('单屏 + 底部任务栏：面板探测不造成无限下坠，仍在工作区底反弹', () => {
    const onlyPanel = [{ x: 0, y: 0, width: 2560, height: 1440 }];
    const onlyArea = [{ x: 0, y: 0, width: 2560, height: 1392 }];
    const sp = throwSpace({ areas: onlyArea, panels: onlyPanel, size: SIZE, sideAllow: SIDE_ALLOW });
    const end = settle({ x: 1000, y: 500, vx: 0, vy: 900 }, DEFAULT_PHYSICS, 2400, sp);
    assert.equal(end.screen, 0);
    assert.ok(end.y <= onlyArea[0].height - PET_H + 1, `应停在任务栏上方（工作区底），实际 y=${end.y}`);
  });

  test('T 形布局（有 panels 但仍与工作区同形）：空洞仍然是墙', () => {
    // 主屏（无任务栏）面板 == 工作区：探测结果与旧行为一致，空洞处照判无屏
    const sp = throwSpace({ areas: AREAS, panels: AREAS, size: SIZE, sideAllow: SIDE_ALLOW });
    let cur = { x: 2700, y: -400, vx: -2600, vy: 0 };
    const noGravity: PhysicsParams = { ...DEFAULT_PHYSICS, gravity: 0 };
    let minX = Infinity;
    for (let i = 0; i < 60; i++) {
      const r = throwStepRegion(cur, 1 / 60, sp, noGravity);
      cur = { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
      minX = Math.min(minX, r.x);
    }
    assert.ok(minX >= sp.bounds[1].minX, `空洞侧必须仍是墙，最左 ${minX}`);
  });
});

describe('anchorPixel / planMove —— 角落与漫游不进空洞', () => {
  test('角落按外接矩形算会掉进空洞（旧行为），按主屏算则落在主屏内', () => {
    const hull = boundingRect(AREAS);
    const common = { corner: 'top-left' as const, marginX: 24, marginY: 24, size: SIZE, W: hull.width, H: hull.height };
    // 旧行为：以外接矩形为准（视口坐标 0,0 开始）——换算回屏幕坐标就是 y = -532 + 24
    const old = anchorPixel(common);
    assert.deepEqual(old, { x: 24, y: 24 });
    assert.equal(rectAtPoint(AREAS, old.x + hull.x + SIDE_ALLOW, old.y + hull.y + PET_H / 2), null, '旧角落在空洞里');
    // 新行为：传主屏工作区
    const fixed = anchorPixel({ ...common, area: MAIN });
    assert.deepEqual(fixed, { x: 24, y: 24 });
    assert.ok(bodyVisible(fixed.x, fixed.y), '新角落必须可见');
  });

  test('四个角落传主屏后都落在主屏内', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const p = anchorPixel({ corner, marginX: 24, marginY: 24, size: SIZE, W: 0, H: 0, area: MAIN });
      assert.ok(bodyVisible(p.x, p.y), `${corner} → ${p.x},${p.y} 不可见`);
    }
  });

  test('漫游落点落在空洞里时返回 null', () => {
    const common = {
      cy: -300, // 主屏上方的高度：只有副屏在这条线上有像素
      W: 3795,
      H: 2147,
      minDist: 600,
      maxDist: 600,
      margin: 24,
      halfW: SIZE / 2,
      sideAllow: SIDE_ALLOW,
      areas: AREAS,
    };
    // 从副屏往左走 600：会走出副屏左缘进入空洞 ⇒ 不可达
    assert.equal(planMove({ ...common, cx: 2900, dir: -1 }), null);
    // 往右走 600 仍在副屏内 ⇒ 可达
    assert.ok(planMove({ ...common, cx: 2900, dir: 1 }));
  });

  test('同高度跨屏漫游允许（屏缝两侧都有屏，可以骑缝走过去）', () => {
    const plan = planMove({
      cx: 2300,
      cy: 700, // 主屏与副屏都覆盖这条线
      W: 3795,
      H: 2147,
      dir: 1,
      minDist: 500,
      maxDist: 500,
      margin: 24,
      halfW: SIZE / 2,
      sideAllow: SIDE_ALLOW,
      areas: AREAS,
    });
    assert.ok(plan, '跨屏漫游不该被屏缝挡住');
    assert.ok(Math.abs(plan.targetRatio * 3795 - 2800) < 1);
  });

  test('不传 areas 时退化为旧的单矩形判定', () => {
    const base = {
      cx: 500,
      cy: 500,
      W: 1920,
      H: 1080,
      minDist: 300,
      maxDist: 300,
      margin: 24,
      halfW: SIZE / 2,
      sideAllow: SIDE_ALLOW,
    };
    assert.ok(planMove({ ...base, dir: 1 }));
    assert.equal(planMove({ ...base, cx: 100, dir: -1 }), null);
  });
});
