/**
 * 「弹弓」刚体物理（runtime/electron-helper/game-physics.js，matter-js 之上）的行为单测——用真的 matter 跑。
 *
 * 为什么要测：
 *   1. 开局那垛木箱必须纹丝不动（睡着），否则用户还没动手它就自己塌了；
 *   2. 瞄准轨迹（探针世界）在撞到东西之前必须与真实飞行逐点重合，否则瞄哪儿飞不到哪儿；
 *   3. 一发正常的弹射要真能把木箱撞动、产生够狠的碰撞（会裂 / 会碎），宠物最后要能停下来；
 *   4. 同样的输入两次结果完全一样——「重新开始」看到的必须是同一场物理。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  CRACK_SPEED,
  GAME_GRAVITY,
  GAME_GROUND_Y,
  GAME_W,
  SLING_ANCHOR,
  STRUCTURE,
  slingVelocity,
} from '../shared/slingshot-game.ts';

const require = createRequire(import.meta.url);
const GP = require('../../runtime/electron-helper/game-physics.js');

/** blockStates() 的一项（game-physics.js 是无类型的 UMD） */
interface BlockPose {
  id: number;
  x: number;
  y: number;
  angle: number;
}

const OPTS = { width: GAME_W, groundY: GAME_GROUND_Y, gravity: GAME_GRAVITY };
const STEP = 1000 / 60;
const PULL = { x: SLING_ANCHOR.x - 140, y: SLING_ANCHOR.y + 50 };

function world() {
  const w = GP.createWorld(OPTS);
  w.addBlocks(STRUCTURE);
  return w;
}

/** 弹一发并推进到宠物停下（或超时），返回全部碰撞与过程 */
function shoot(w: ReturnType<typeof world>, pulled = PULL, maxSec = 9) {
  const v = slingVelocity(pulled);
  assert.ok(v);
  w.launchPet(pulled, v);
  const impacts: { a: unknown; b: unknown; speed: number }[] = [];
  let still = 0;
  let t = 0;
  for (; t < maxSec; t += 1 / 60) {
    impacts.push(...w.step(STEP));
    const p = w.petState();
    still = Math.hypot(p.vx, p.vy) < 15 ? still + 1 : 0;
    if (still > 15) break;
  }
  return { impacts, t };
}

describe('开局：木箱垛静止', () => {
  test('5 秒不碰它：一块都不动，全部睡着', () => {
    const w = world();
    for (let i = 0; i < 300; i++) w.step(STEP);
    for (const b of w.blockStates()) {
      const spot = STRUCTURE[b.id];
      assert.ok(Math.hypot(b.x - spot.x, b.y - spot.y) < 1e-6, `block ${b.id} drifted`);
      assert.equal(b.sleeping, true);
    }
  });

  test('落地的积木底边就在地面上', () => {
    const w = world();
    for (const b of w.blockStates()) {
      const spot = STRUCTURE[b.id];
      if (Math.abs(spot.y + spot.h / 2 - GAME_GROUND_Y) < 0.01) assert.ok(Math.abs(b.bottom - GAME_GROUND_Y) < 0.5);
    }
  });
});

describe('瞄准探针：撞到东西之前与真实飞行逐点重合', () => {
  test('同一发：探针轨迹 = 世界里的实际轨迹', () => {
    const v = slingVelocity(PULL);
    assert.ok(v);
    const every = 3;
    const path = GP.createProbe(OPTS).path(PULL, v, 8, every);
    assert.equal(path.length, 8);
    const w = world();
    w.launchPet(PULL, v);
    for (let i = 0; i < path.length; i++) {
      for (let k = 0; k < every; k++) w.step(STEP);
      const p = w.petState();
      assert.ok(Math.abs(p.x - path[i].x) < 1e-6 && Math.abs(p.y - path[i].y) < 1e-6, `point ${i}`);
    }
  });

  test('探针落地即停、可重复调用（每次都从干净状态起飞）', () => {
    const probe = GP.createProbe(OPTS);
    const v = { vx: 300, vy: 0 };
    const a = probe.path(PULL, v, 400, 1);
    const b = probe.path(PULL, v, 400, 1);
    assert.ok(a.length < 400);
    assert.deepEqual(a, b);
  });
});

describe('弹射：撞得动、撞得狠、停得下', () => {
  test('一发满拉：有宠物参与的碰撞达到「裂开」力度，积木被撞离原位，宠物最后停下', () => {
    const w = world();
    const { impacts, t } = shoot(w);
    assert.ok(t < 9, '宠物应在 9 秒内停下');
    const petHits = impacts.filter(
      (i) => (i.a === 'pet' || i.b === 'pet') && typeof (i.a === 'pet' ? i.b : i.a) === 'number',
    );
    assert.ok(petHits.length > 0, '宠物应撞到木箱');
    assert.ok(Math.max(...petHits.map((i) => i.speed)) >= CRACK_SPEED, '至少有一下够狠');
    const moved = w
      .blockStates()
      .filter((b: BlockPose) => Math.hypot(b.x - STRUCTURE[b.id].x, b.y - STRUCTURE[b.id].y) > 5);
    // 木箱轻、木头不那么「粘」：撞上的那一摞要真被撞翻，而不是只蹭掉一只
    assert.ok(moved.length >= 3, `木箱应被撞翻好几只，只动了 ${moved.length}`);
  });

  test('同样的输入两次结果完全一样（重新开始 = 同一场物理）', () => {
    const run = () => {
      const w = world();
      shoot(w);
      for (let i = 0; i < 120; i++) w.step(STEP);
      return w.blockStates().map((b: BlockPose) => [b.id, b.x.toFixed(6), b.y.toFixed(6), b.angle.toFixed(6)]);
    };
    assert.deepEqual(run(), run());
  });
});

describe('左右墙跟着窗口边走（left / right）', () => {
  test('墙在 right 处：往右平飞的宠物越过场景宽度、停在 right 之内', () => {
    const right = GAME_W + 300;
    const w = GP.createWorld({ ...OPTS, left: -300, right });
    w.launchPet({ x: GAME_W - 100, y: GAME_GROUND_Y - 80 }, { vx: 1500, vy: 0 });
    let maxX = -Infinity;
    for (let i = 0; i < 120; i++) {
      w.step(STEP);
      maxX = Math.max(maxX, w.petState().x);
    }
    assert.ok(maxX > GAME_W, `pet should pass the old wall, max ${maxX}`);
    assert.ok(maxX < right, `pet must stay inside the new wall, max ${maxX}`);
  });

  test('墙够高：再猛再陡的一发（加大弹力后）也翻不过墙飞出屏幕', () => {
    const right = GAME_W + 300;
    const w = GP.createWorld({ ...OPTS, left: -300, right });
    w.launchPet({ x: -200, y: GAME_GROUND_Y - 80 }, { vx: 1000, vy: -6000 }); // 到右墙时已高出地面 8000 多
    let maxX = -Infinity;
    for (let i = 0; i < 900; i++) {
      w.step(STEP);
      maxX = Math.max(maxX, w.petState().x);
    }
    assert.ok(maxX < right, `pet flew over the wall, max x ${maxX}`);
  });

  test('不给 left / right：墙在 0 与 width', () => {
    const w = GP.createWorld(OPTS);
    w.launchPet({ x: GAME_W - 100, y: GAME_GROUND_Y - 80 }, { vx: 1500, vy: 0 });
    let maxX = -Infinity;
    for (let i = 0; i < 120; i++) {
      w.step(STEP);
      maxX = Math.max(maxX, w.petState().x);
    }
    assert.ok(maxX < GAME_W, `max ${maxX}`);
  });
});

describe('增删', () => {
  test('removeBlock / clearBlocks', () => {
    const w = world();
    w.removeBlock(3);
    assert.equal(w.blockStates().length, STRUCTURE.length - 1);
    assert.ok(!w.blockStates().some((b: BlockPose) => b.id === 3));
    w.clearBlocks();
    assert.equal(w.blockStates().length, 0);
  });

  test('再次发射会替换上一只宠物（世界里永远最多一只）', () => {
    const w = world();
    w.launchPet(PULL, { vx: 100, vy: 0 });
    w.launchPet(PULL, { vx: 200, vy: 0 });
    const pets = w.engine.world.bodies.filter((b: { label: string }) => b.label === 'pet');
    assert.equal(pets.length, 1);
    w.removePet();
    assert.equal(w.petState(), null);
  });
});
