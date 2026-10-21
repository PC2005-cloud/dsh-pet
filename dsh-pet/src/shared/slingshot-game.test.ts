/**
 * 弹弓小互动纯逻辑单测 —— 钉住手感、积木垛与会话规则。
 *
 * 为什么单独钉：
 *   1. **弹弓方向**：初速必须与拉伸方向相反（往左下拉 = 往右上飞）；
 *   2. **积木垛**：每块积木要么落在地上、要么压在下面某块的顶上——摆错一点，开局整垛就会自己塌；
 *   3. **会话**：每次进入都是同一份干净的初始状态；木箱两下打碎 / 一下重击直接碎；全倒了才算 cleared；
 *   4. **几何与美术一致**：弹弓叉高（代码）与 sling.json（画出来的素材）对得上，宠物脚正好站在皮兜里。
 *
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs --test src/shared/slingshot-game.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BLOCK_HP,
  BREAK_SPEED,
  CRACK_SPEED,
  DOWN_TOLERANCE,
  GAME_GRAVITY,
  GAME_GROUND_Y,
  GAME_H,
  GAME_PET_SIZE,
  GAME_W,
  SLING_ANCHOR,
  SLING_BASE,
  SLING_FORK_HEIGHT,
  SLING_MAX_PULL,
  SLING_MIN_PULL,
  SLING_POWER,
  STRUCTURE,
  aimPoint,
  blocksLeft,
  damageBlock,
  fireShot,
  impactDamage,
  isFlattened,
  markCleared,
  newSession,
  petBody,
  petBoxAt,
  petCenterOf,
  pileAt,
  sceneFit,
  sceneView,
  settleShot,
  slingVelocity,
  type SlingshotState,
} from './slingshot-game.ts';

const flying = (): SlingshotState => fireShot(newSession());

describe('宠物几何', () => {
  test('petBoxAt / petCenterOf 互逆', () => {
    const c = { x: 333, y: 444 };
    const back = petCenterOf(petBoxAt(c));
    assert.ok(Math.abs(back.x - c.x) < 1e-9 && Math.abs(back.y - c.y) < 1e-9);
  });

  test('身体框以中心点为中心', () => {
    const body = petBody(petBoxAt({ x: 500, y: 300 }));
    assert.ok(Math.abs((body.left + body.right) / 2 - 500) < 1e-9);
    assert.ok(Math.abs((body.top + body.bottom) / 2 - 300) < 1e-9);
  });

  test('待发时宠物脚底站在叉尖高度的皮兜里', () => {
    const feet = petBody(petBoxAt(SLING_ANCHOR)).bottom;
    const tipY = SLING_BASE.y - SLING_FORK_HEIGHT;
    assert.ok(feet > tipY && feet - tipY < 8, `feet=${feet} tipY=${tipY}`);
    assert.equal(SLING_ANCHOR.x, SLING_BASE.x);
  });

  test('代码里的叉高与画出来的弹弓（sling.json）一致', () => {
    const meta = JSON.parse(
      readFileSync(new URL('../../runtime/electron-helper/game-assets/sling.json', import.meta.url), 'utf8'),
    );
    const tipY = (meta.backTip[1] + meta.frontTip[1]) / 2;
    assert.ok(Math.abs(-tipY - SLING_FORK_HEIGHT) < 2, `art tip ${tipY} vs code ${SLING_FORK_HEIGHT}`);
  });

  test('场景比例 16:9', () => assert.equal(GAME_W / GAME_H, 16 / 9));
});

describe('sceneFit —— 宠物在弹弓里与桌面上一样大', () => {
  test('放得下：缩放 = 桌宠大小 / 场景宠物大小（画出来的宠物宽 = 桌宠宽）', () => {
    const fit = sceneFit({ width: 2475, height: 1392, petSize: 462 });
    assert.ok(Math.abs(fit * GAME_PET_SIZE - 462) < 1e-9);
  });

  test('桌宠很大、整个场景放不下：退回「整窗放下」的缩放（宠物才会被缩小）', () => {
    assert.equal(sceneFit({ width: 1280, height: 720, petSize: 600 }), 1);
    assert.equal(sceneFit({ width: 2560, height: 720, petSize: 600 }), 1);
  });

  test('没给 / 非法的桌宠大小：整窗放下', () => {
    for (const petSize of [undefined, 0, -3, Number.NaN, Infinity]) {
      assert.equal(sceneFit({ width: 1920, height: 1080, petSize }), 1.5);
    }
  });
});

describe('sceneView —— 宠物离屏幕左边 1/6、木箱垛离右边 1/6', () => {
  const SCREENS = [
    { width: 2560, height: 1392, petSize: 462 },
    { width: 1920, height: 1040, petSize: 300 },
    { width: 3440, height: 1400, petSize: 462 },
    { width: 1280, height: 720, petSize: 600 }, // 桌宠太大：缩到整屏放下
    { width: 1080, height: 1880, petSize: 462 }, // 竖屏
    { width: 3440, height: 1400, petSize: 150 }, // 带鱼屏 + 很小的桌宠：场景特别宽
  ];
  const client = (v: ReturnType<typeof sceneView>, x: number) => v.offX + x * v.fit;

  test('弹弓（宠物站的位置）在屏宽 1/6 处，木箱垛右边缘在 5/6 处', () => {
    for (const scr of SCREENS) {
      const v = sceneView(scr);
      assert.ok(Math.abs(client(v, SLING_BASE.x) - scr.width / 6) < 1e-6, JSON.stringify(scr));
      assert.ok(Math.abs(client(v, v.pileRight) - (scr.width * 5) / 6) < 1e-6, JSON.stringify(scr));
    }
  });

  test('缩放仍是 sceneFit（宠物与桌面一样大），地面贴窗口底', () => {
    for (const scr of SCREENS) {
      const v = sceneView(scr);
      assert.equal(v.fit, sceneFit(scr));
      assert.ok(Math.abs(v.offY + GAME_GROUND_Y * v.fit - (scr.height - (GAME_H - GAME_GROUND_Y) * v.fit)) < 1e-6);
    }
  });

  test('左右墙就是窗口的左右边', () => {
    for (const scr of SCREENS) {
      const v = sceneView(scr);
      assert.ok(Math.abs(client(v, v.wallLeft)) < 1e-6);
      assert.ok(Math.abs(client(v, v.wallRight) - scr.width) < 1e-6);
    }
  });

  test('再窄的屏：木箱垛离弹弓也有 400 开外，且整垛都在墙内', () => {
    for (const scr of SCREENS) {
      const v = sceneView(scr);
      const pile = pileAt(v.pileRight);
      const left = Math.min(...pile.map((b) => b.x - b.w / 2));
      assert.ok(left - SLING_ANCHOR.x >= 400, `${JSON.stringify(scr)} gap ${left - SLING_ANCHOR.x}`);
      assert.ok(left > v.wallLeft && v.pileRight < v.wallRight);
    }
  });
});

describe('sceneView.power —— 木箱垛再远也打得到', () => {
  test('常见情形（2560 宽、默认 462 的桌宠）：就是 SLING_POWER，手感不变', () => {
    assert.equal(sceneView({ width: 2560, height: 1392, petSize: 462 }).power, SLING_POWER);
  });

  test('任何屏 / 桌宠大小：满拉 45° 的射程都比弹弓到木箱垛最右边还远一截', () => {
    for (const scr of [
      { width: 1280, height: 720, petSize: 600 },
      { width: 2560, height: 1392, petSize: 300 },
      { width: 3440, height: 1400, petSize: 150 },
      { width: 7680, height: 2100, petSize: 120 },
    ]) {
      const v = sceneView(scr);
      assert.ok(v.power >= SLING_POWER);
      const speed = SLING_MAX_PULL * v.power;
      const range = (speed * speed) / GAME_GRAVITY;
      assert.ok(range >= 1.15 * (v.pileRight - SLING_ANCHOR.x), `${JSON.stringify(scr)} range ${range}`);
    }
  });

  test('弹力有上限：最快的一发每个物理子步（1/120 s）也走不到半只木箱，不会穿过木箱', () => {
    for (const scr of [
      { width: 3440, height: 1400, petSize: 150 },
      { width: 7680, height: 2100, petSize: 120 },
      { width: 7680, height: 2100, petSize: 40 },
    ]) {
      const v = sceneView(scr);
      assert.ok((SLING_MAX_PULL * v.power) / 120 < 27 * 1.4, `${JSON.stringify(scr)} power ${v.power}`);
    }
  });

  test('极端情形（屏极宽、桌宠极小）：木箱垛往里收，保证打得到；常见屏仍严格在 5/6 处', () => {
    const v = sceneView({ width: 7680, height: 2100, petSize: 40 });
    const speed = SLING_MAX_PULL * v.power;
    assert.ok((speed * speed) / GAME_GRAVITY >= 1.15 * (v.pileRight - SLING_ANCHOR.x));
    assert.ok(v.offX + v.pileRight * v.fit < (7680 * 5) / 6);
  });

  test('slingVelocity 按传入的 power 计速；不传就是 SLING_POWER', () => {
    const pulled = { x: SLING_ANCHOR.x - 100, y: SLING_ANCHOR.y };
    const base = slingVelocity(pulled);
    const boosted = slingVelocity(pulled, SLING_POWER * 1.5);
    assert.ok(base && boosted);
    assert.ok(Math.abs(boosted.vx - base.vx * 1.5) < 1e-9 && boosted.vy === 0);
  });
});

describe('pileAt —— 把木箱垛整体平移到给定的右边缘', () => {
  test('右边缘对齐、形状不变、id 不变', () => {
    const pile = pileAt(1500);
    assert.ok(Math.abs(Math.max(...pile.map((b) => b.x + b.w / 2)) - 1500) < 1e-9);
    const dx = pile[0].x - STRUCTURE[0].x;
    pile.forEach((b, i) => {
      assert.equal(b.id, STRUCTURE[i].id);
      assert.ok(Math.abs(b.x - STRUCTURE[i].x - dx) < 1e-9);
      assert.equal(b.y, STRUCTURE[i].y);
      assert.equal(b.w, STRUCTURE[i].w);
    });
  });

  test('不改 STRUCTURE，返回冻结的新数组', () => {
    const before = JSON.stringify(STRUCTURE);
    const pile = pileAt(1500);
    assert.equal(JSON.stringify(STRUCTURE), before);
    assert.notEqual(pile, STRUCTURE);
    assert.ok(Object.isFrozen(pile) && Object.isFrozen(pile[0]));
  });
});

describe('aimPoint / slingVelocity', () => {
  test('半径内原样返回；超出夹到圆周', () => {
    const p = { x: SLING_ANCHOR.x - 40, y: SLING_ANCHOR.y + 30 };
    assert.deepEqual(aimPoint(p), p);
    const far = aimPoint({ x: SLING_ANCHOR.x - 1000, y: SLING_ANCHOR.y });
    assert.ok(Math.abs(far.x - (SLING_ANCHOR.x - SLING_MAX_PULL)) < 1e-9);
  });

  test('往下拉不会把身体拉进地面', () => {
    const p = aimPoint({ x: SLING_ANCHOR.x, y: SLING_ANCHOR.y + 1000 });
    assert.ok(petBody(petBoxAt(p)).bottom <= GAME_GROUND_Y + 1e-9);
  });

  test('往左下拉 → 往右上飞，大小与拉伸成正比', () => {
    const v = slingVelocity({ x: SLING_ANCHOR.x - 100, y: SLING_ANCHOR.y });
    assert.ok(v && v.vx > 0);
    assert.ok(Math.abs(Math.hypot(v.vx, v.vy) - 100 * SLING_POWER) < 1e-6);
    const up = slingVelocity({ x: SLING_ANCHOR.x - 80, y: SLING_ANCHOR.y + 60 });
    assert.ok(up && up.vy < 0);
  });

  test('拉得太短 → null；超限按最大拉伸计速', () => {
    assert.equal(slingVelocity({ x: SLING_ANCHOR.x - (SLING_MIN_PULL - 1), y: SLING_ANCHOR.y }), null);
    const v = slingVelocity({ x: SLING_ANCHOR.x - 5000, y: SLING_ANCHOR.y });
    assert.ok(v && Math.abs(Math.hypot(v.vx, v.vy) - SLING_MAX_PULL * SLING_POWER) < 1e-6);
  });
});

describe('积木垛（STRUCTURE）', () => {
  const EPS = 0.01;
  const bottom = (b: (typeof STRUCTURE)[number]) => b.y + b.h / 2;
  const top = (b: (typeof STRUCTURE)[number]) => b.y - b.h / 2;
  const overlapX = (a: (typeof STRUCTURE)[number], b: (typeof STRUCTURE)[number]) =>
    Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);

  test('id 唯一且就是下标；全是木箱（没有长木板）', () => {
    STRUCTURE.forEach((b, i) => assert.equal(b.id, i));
    assert.ok(STRUCTURE.every((b) => b.kind === 'crate' && b.w === b.h));
  });

  test('分几摞站成一排：至少 4 摞，相邻两摞之间留出空当（不挤成一整块，撞哪摞倒哪摞）', () => {
    const stacks = [...new Set(STRUCTURE.map((b) => b.x))].sort((a, b) => a - b);
    assert.ok(stacks.length >= 4, `stacks ${stacks.length}`);
    for (let i = 1; i < stacks.length; i++) {
      assert.ok(stacks[i] - stacks[i - 1] - 54 >= 30, `gap between stacks ${i - 1}/${i}`);
    }
    // 每摞都是正正地摞在同一列上：同一摞里的木箱 x 完全一样，自下而上一只压一只
    for (const x of stacks) {
      const col = STRUCTURE.filter((b) => b.x === x).sort((a, b) => b.y - a.y);
      col.forEach((b, i) => assert.ok(Math.abs(bottom(b) - (GAME_GROUND_Y - i * 54)) < EPS, `stack at ${x}`));
    }
  });

  test('码得够高：垛顶离地至少 260（比宠物高出一截）', () => {
    const peak = Math.min(...STRUCTURE.map(top));
    assert.ok(GAME_GROUND_Y - peak >= 260, `height ${GAME_GROUND_Y - peak}`);
  });

  test('每块要么落地，要么底边正好压在下面某块的顶上（且有足够的支撑面）', () => {
    for (const b of STRUCTURE) {
      if (Math.abs(bottom(b) - GAME_GROUND_Y) < EPS) continue;
      const support = STRUCTURE.filter((s) => s !== b && Math.abs(top(s) - bottom(b)) < EPS && overlapX(s, b) > 0);
      assert.ok(support.length > 0, `block ${b.id} floats`);
      // 重心落在支撑范围内（不会一开局就往下翻）
      const lo = Math.min(...support.map((s) => s.x - s.w / 2));
      const hi = Math.max(...support.map((s) => s.x + s.w / 2));
      assert.ok(b.x >= lo && b.x <= hi, `block ${b.id} overhangs`);
    }
  });

  test('互不穿插、都在场景内、离弹弓足够远', () => {
    for (const b of STRUCTURE) {
      assert.ok(b.x - b.w / 2 >= 0 && b.x + b.w / 2 <= GAME_W, `x ${b.id}`);
      // 参考摆法里也离弹弓够远（实际摆在哪见 sceneView / pileAt）
      assert.ok(b.x - b.w / 2 >= SLING_ANCHOR.x + SLING_MAX_PULL + 300, `near sling ${b.id}`);
      for (const o of STRUCTURE) {
        if (o === b) continue;
        const ox = overlapX(o, b);
        const oy = Math.min(bottom(o), bottom(b)) - Math.max(top(o), top(b));
        assert.ok(!(ox > EPS && oy > EPS), `${b.id} overlaps ${o.id}`);
      }
    }
  });

  test('开局时并没有「全倒」', () => {
    const blocks = STRUCTURE.map((b) => ({ id: b.id, bottom: bottom(b), top: top(b) }));
    assert.equal(isFlattened(blocks, new Set()), false);
  });
});

describe('impactDamage —— 撞得多狠扣多少', () => {
  test('轻碰不扣、中等扣 1、重击扣满', () => {
    assert.equal(impactDamage(CRACK_SPEED - 1), 0);
    assert.equal(impactDamage(CRACK_SPEED), 1);
    assert.equal(impactDamage(BREAK_SPEED - 1), 1);
    assert.equal(impactDamage(BREAK_SPEED), BLOCK_HP);
  });
  test('非法速度按 0', () => {
    assert.equal(impactDamage(Number.NaN), 0);
    assert.equal(impactDamage(-500), 0);
  });
});

describe('newSession —— 每次进入都是同一份干净的初始状态', () => {
  test('瞄准阶段、积木满血、一块没碎', () => {
    const s = newSession();
    assert.equal(s.phase, 'aiming');
    assert.equal(blocksLeft(s), STRUCTURE.length);
    for (const b of s.blocks) {
      assert.equal(b.hp, BLOCK_HP);
      assert.equal(b.broken, false);
    }
  });

  test('两次开局完全相同、互不共享对象', () => {
    const a = newSession();
    const b = newSession();
    assert.deepEqual(a, b);
    assert.notEqual(a.blocks, b.blocks);
  });

  test('上一局打碎的木箱不会带进新一局', () => {
    let s = flying();
    s = damageBlock(s, 0, BLOCK_HP).state;
    assert.equal(blocksLeft(s), STRUCTURE.length - 1);
    assert.equal(blocksLeft(newSession()), STRUCTURE.length);
  });
});

describe('damageBlock —— 裂开 / 碎掉', () => {
  test('第一下中等撞击：裂开（cracked），不碎；不改原状态', () => {
    const s0 = flying();
    const r = damageBlock(s0, 2, 1);
    assert.equal(r.cracked, true);
    assert.equal(r.broke, false);
    assert.equal(r.state.blocks[2].hp, BLOCK_HP - 1);
    assert.equal(s0.blocks[2].hp, BLOCK_HP);
  });

  test('第二下：碎掉（broke）', () => {
    const r = damageBlock(damageBlock(flying(), 2, 1).state, 2, 1);
    assert.equal(r.broke, true);
    assert.equal(r.state.blocks[2].broken, true);
  });

  test('一下重击直接碎', () => {
    const r = damageBlock(flying(), 3, BLOCK_HP);
    assert.equal(r.broke, true);
  });

  test('0 伤害 / 已碎 / 未知 id：原样返回', () => {
    const s = flying();
    assert.equal(damageBlock(s, 1, 0).state, s);
    assert.equal(damageBlock(s, 999, 2).state, s);
    const broken = damageBlock(s, 1, BLOCK_HP).state;
    assert.equal(damageBlock(broken, 1, 1).state, broken);
  });

  test('宠物还在弹弓里时（瞄准阶段）积木也照样会被砸坏——后续倒塌的连锁不分阶段', () => {
    const r = damageBlock(newSession(), 0, 1);
    assert.equal(r.cracked, true);
  });
});

describe('isFlattened —— 「全倒」判定', () => {
  test('剩下的积木都贴着地面 → 全倒', () => {
    const blocks = [
      { id: 0, bottom: GAME_GROUND_Y, top: GAME_GROUND_Y - 54 },
      { id: 1, bottom: GAME_GROUND_Y - DOWN_TOLERANCE + 1, top: GAME_GROUND_Y - 60 },
    ];
    assert.equal(isFlattened(blocks, new Set()), true);
  });

  test('还有一块垫在别的上面 → 没倒完', () => {
    const blocks = [
      { id: 0, bottom: GAME_GROUND_Y, top: GAME_GROUND_Y - 54 },
      { id: 1, bottom: GAME_GROUND_Y - 54, top: GAME_GROUND_Y - 108 },
    ];
    assert.equal(isFlattened(blocks, new Set()), false);
  });

  test('碎掉的不算；全碎了也算全倒', () => {
    const blocks = [{ id: 1, bottom: GAME_GROUND_Y - 54, top: GAME_GROUND_Y - 108 }];
    assert.equal(isFlattened(blocks, new Set([1])), true);
    assert.equal(isFlattened([], new Set()), true);
  });
});

describe('fireShot / settleShot / markCleared', () => {
  test('发射：瞄准 → 飞行；非瞄准阶段无效', () => {
    const s = flying();
    assert.equal(s.phase, 'flying');
    assert.equal(fireShot(s), s);
  });

  test('落定：飞行 → 瞄准（没有次数限制）', () => {
    let s = newSession();
    for (let i = 0; i < 20; i++) s = settleShot(fireShot(s));
    assert.equal(s.phase, 'aiming');
    assert.equal(settleShot(newSession()).phase, 'aiming');
  });

  test('cleared 之后不再发射 / 落定', () => {
    const c = markCleared(flying());
    assert.equal(c.phase, 'cleared');
    assert.equal(fireShot(c), c);
    assert.equal(settleShot(c), c);
    assert.equal(markCleared(c), c);
  });
});
