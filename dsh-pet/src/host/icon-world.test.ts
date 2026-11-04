/**
 * 桌面图标碰撞的物理核心（runtime/electron-helper/main/icon-world.js）的单测。
 *
 * icon-world 是纯计算：时钟、挪图标、回推桌宠速度、音效全部走注入的 hooks，这里用假时钟逐帧驱动。
 * 钉住的行为：飞行中的宠物撞得动图标且自己会被弹慢；自主走位 / 站着压着的宠物不碰图标；
 * 你在桌面上操作（busy）、开着自动排列（blocked）、全屏（paused）时一律不动；图标不出工作区；
 * 被拖着的宠物质量无穷大（不回推速度）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IconWorld, bodyRect } = require('../../runtime/electron-helper/main/icon-world.js');

/** 1920×1040 工作区、76×96 的图标格子。 */
const AREA = [0, 0, 1920, 1040];
const SIZE = 300;

function makeWorld() {
  let t = 0;
  const moves: number[][] = [];
  const hits: Array<{ id: string; vx: number; vy: number }> = [];
  const fx: unknown[] = [];
  const world = new IconWorld({
    now: () => t,
    move: (list: number[]) => moves.push(list),
    petHit: (id: string, vx: number, vy: number) => hits.push({ id, vx, vy }),
    fx: (p: unknown) => fx.push(p),
  });
  return {
    world,
    moves,
    hits,
    fx,
    advance(dt: number) {
      t += dt;
    },
  };
}

/** 一个图标格子左上角在 (x, y)。 */
const icons = (...items: Array<[number, number]>) => ({ cw: 76, ch: 96, items, areas: [AREA] });

/** 让宠物身体的左边缘在 bodyLeft、上边缘在 bodyTop：反推包围盒左上角。 */
function boxFor(bodyLeft: number, bodyTop: number) {
  const r0 = bodyRect(0, 0, SIZE, 0);
  return { bx: bodyLeft - r0.l, by: bodyTop - r0.t };
}

/** 宠物以 vx 水平飞（每帧 1/60 s），从 x0 起飞，飞 frames 帧。 */
function fly(
  h: ReturnType<typeof makeWorld>,
  id: string,
  x0: number,
  y: number,
  vx: number,
  frames: number,
  opts: { flying?: boolean; held?: boolean } = { flying: true },
) {
  for (let k = 0; k < frames; k++) {
    const { bx, by } = boxFor(x0 + vx * (k / 60), y);
    h.world.updatePet(id, {
      bx,
      by,
      size: SIZE,
      bottomPad: 0,
      vx: opts.flying ? vx : 0,
      vy: 0,
      flying: !!opts.flying,
      held: !!opts.held,
    });
    h.advance(1 / 60);
    h.world.tick();
  }
}

/** 图标 i 当前的格子左上角（最后一次 move 里的值；没动过 = undefined）。 */
function lastPos(moves: number[][], i: number): [number, number] | undefined {
  let pos: [number, number] | undefined;
  for (const list of moves) {
    for (let k = 0; k + 2 < list.length; k += 3) if (list[k] === i) pos = [list[k + 1], list[k + 2]];
  }
  return pos;
}

describe('icon-world：宠物与桌面图标的双向碰撞', () => {
  test('飞行中的宠物撞上图标：图标被打向前方，宠物收到减速后的新速度', () => {
    const h = makeWorld();
    h.world.setIcons(icons([1000, 500]));
    fly(h, 'a', 500, 460, 1800, 30);
    const pos = lastPos(h.moves, 0);
    assert.ok(pos, '图标应该被挪动');
    assert.ok(pos[0] > 1000, '图标应沿宠物飞行方向（+x）被打出去');
    assert.ok(h.hits.length >= 1, '宠物应收到 pet:hit');
    assert.equal(h.hits[0].id, 'a');
    assert.ok(h.hits[0].vx < 1800 && h.hits[0].vx > 0, '宠物被弹慢但不反向（图标比宠物轻）');
    assert.ok(h.fx.some((p) => (p as { sound?: boolean }).sound === true), '应有撞击音效');
  });

  test('自主走位（不在飞、没被拖）的宠物从图标上方滑过，不挪图标', () => {
    const h = makeWorld();
    h.world.setIcons(icons([1000, 500]));
    fly(h, 'a', 500, 460, 1800, 30, { flying: false });
    assert.equal(lastPos(h.moves, 0), undefined);
    assert.equal(h.hits.length, 0);
  });

  test('一出现就压着图标、慢慢蹭上去都算「盖」，不算撞', () => {
    const h = makeWorld();
    h.world.setIcons(icons([1000, 500]));
    fly(h, 'a', 900, 460, 60, 30); // 60 px/s 远低于撞击阈值
    assert.equal(lastPos(h.moves, 0), undefined);
  });

  test('被拖着的宠物质量无穷大：图标被推开，宠物不收到回推速度', () => {
    const h = makeWorld();
    h.world.setIcons(icons([1000, 500]));
    fly(h, 'a', 500, 460, 1800, 30, { held: true });
    const pos = lastPos(h.moves, 0);
    assert.ok(pos && pos[0] > 1000, '图标应被推开');
    assert.equal(h.hits.length, 0, '拖拽中不回推宠物');
  });

  test('busy / blocked / paused 期间整体不动', () => {
    for (const set of ['setBusy', 'setBlocked', 'setPaused'] as const) {
      const h = makeWorld();
      h.world.setIcons(icons([1000, 500]));
      h.world[set](true);
      fly(h, 'a', 500, 460, 1800, 30);
      assert.equal(lastPos(h.moves, 0), undefined, set + ' 期间不该挪图标');
      assert.equal(h.hits.length, 0, set + ' 期间不该回推宠物');
    }
  });

  test('图标被打飞后停在工作区里，不出屏幕', () => {
    const h = makeWorld();
    h.world.setIcons(icons([1700, 500], [1780, 500]));
    fly(h, 'a', 1200, 460, 3000, 20);
    for (let k = 0; k < 600 && h.world.anyMoving(); k++) {
      h.advance(1 / 120);
      h.world.tick();
    }
    assert.equal(h.world.anyMoving(), false, '图标最终应停下');
    for (const i of [0, 1]) {
      const pos = lastPos(h.moves, i);
      if (!pos) continue;
      assert.ok(pos[0] >= AREA[0] && pos[0] + 76 <= AREA[2], `图标 ${i} 的 x 出界：${pos[0]}`);
      assert.ok(pos[1] >= AREA[1] && pos[1] + 96 <= AREA[3], `图标 ${i} 的 y 出界：${pos[1]}`);
    }
  });

  test('图标之间互撞传递动量：前面那个被打得动', () => {
    const h = makeWorld();
    h.world.setIcons(icons([1000, 500], [1076, 500]));
    fly(h, 'a', 500, 460, 2400, 30);
    for (let k = 0; k < 120 && h.world.anyMoving(); k++) {
      h.advance(1 / 120);
      h.world.tick();
    }
    const second = lastPos(h.moves, 1);
    assert.ok(second && second[0] > 1076, '第二个图标应被第一个撞出去');
  });

  test('移除宠物后不再参与碰撞', () => {
    const h = makeWorld();
    h.world.setIcons(icons([1000, 500]));
    fly(h, 'a', 500, 460, 1800, 5);
    h.world.removePet('a');
    assert.equal(h.world.pets.has('a'), false);
  });
});
