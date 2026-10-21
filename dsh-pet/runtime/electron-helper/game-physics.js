/**
 * 「弹弓」刚体物理 —— matter-js 之上的一层薄封装（木箱 / 飞出去的宠物）。
 *
 * 同一份文件两处用：弹弓页面（经典 script，window.Matter → window.GamePhysics）与 Node 单测
 * （module.exports，require('matter-js')；见 src/host/game-physics.test.ts）。不碰 DOM。
 *
 * 约定：
 *   - 坐标 = 逻辑场景像素（与 src/shared/slingshot-game.ts 一致），y 向下；
 *   - 对外速度一律 px/s；matter 内部速度单位是「每个基准步长（1000/60 ms）多少 px」，只在本文件换算；
 *   - 固定子步 1/120 s：宠物最快约 4100 px/s（远屏加大弹力的上限，见 slingshot-game.ts 的 MAX_POWER_BOOST），一个子步走 ~35px，
 *     不到 54px 的木箱宽，穿不过去（matter 没有连续碰撞）；
 *   - 积木一开始全部「睡着」：整垛静止、不会自己晃塌，直到被撞醒（matter 的 sleeping）。
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('matter-js'));
  else root.GamePhysics = factory(root.Matter);
})(typeof self !== 'undefined' ? self : this, function (Matter) {
  const { Engine, Bodies, Body, Composite, Events, Sleeping } = Matter;

  /** matter 的基准步长（ms）：setVelocity / velocity 都以它为单位 */
  const BASE_MS = 1000 / 60;
  /** 物理子步（ms） */
  const SUB_MS = 1000 / 120;
  /** 宠物刚体：比身体命中框略小一圈的圆角矩形，不转动（倾斜只在画面上做） */
  const PET_BODY = { w: 96, h: 124, chamfer: 26, density: 0.0034, friction: 0.6, restitution: 0.22 };
  /**
   * 木箱材质：空木箱，轻（一只约是宠物的 1/8 重）、摩擦适中、几乎不弹——宠物撞上去整摞会被撞翻，
   * 而不是只蹭掉最上面一只（摩擦 / 密度再大，摞起来的木箱就像粘在一起推不动）
   */
  const WOOD = { density: 0.0016, friction: 0.5, frictionStatic: 0.6, restitution: 0.08, slop: 0.03 };

  function engineOptions(gravity) {
    return {
      enableSleeping: true,
      positionIterations: 10,
      velocityIterations: 8,
      gravity: { x: 0, y: gravity / 1000, scale: 0.001 },
    };
  }

  /**
   * 墙的高度（场景像素）：远高于任何一发能飞到的顶点（最快约 4100 px/s 竖直上抛 ≈ 7000），
   * 宠物再陡再猛也翻不过墙飞出屏幕；墙一直伸到地面以下，墙脚不留缝
   */
  const WALL_H = 100000;

  /** 地面 + 左右两堵墙。墙在 opts.left / opts.right（缺省 0 / width）：渲染端把它们放在窗口左右边上 */
  function addFrame(engine, opts) {
    const thick = 200;
    const groundY = opts.groundY;
    const leftX = Number.isFinite(opts.left) ? opts.left : 0;
    const rightX = Number.isFinite(opts.right) ? opts.right : opts.width;
    const span = rightX - leftX;
    const ground = Bodies.rectangle((leftX + rightX) / 2, groundY + thick / 2, span * 4, thick, {
      isStatic: true,
      friction: 1,
      label: 'ground',
    });
    const wallY = groundY + thick - (WALL_H + thick) / 2; // 从地面下 thick 处一直往上 WALL_H
    const left = Bodies.rectangle(leftX - thick / 2, wallY, thick, WALL_H + thick, {
      isStatic: true,
      label: 'wall',
    });
    const right = Bodies.rectangle(rightX + thick / 2, wallY, thick, WALL_H + thick, {
      isStatic: true,
      label: 'wall',
    });
    Composite.add(engine.world, [ground, left, right]);
  }

  function makePet(center) {
    return Bodies.rectangle(center.x, center.y, PET_BODY.w, PET_BODY.h, {
      chamfer: { radius: PET_BODY.chamfer },
      density: PET_BODY.density,
      friction: PET_BODY.friction,
      frictionAir: 0,
      restitution: PET_BODY.restitution,
      inertia: Infinity,
      sleepThreshold: Infinity,
      label: 'pet',
    });
  }

  const toStep = (v) => ({ x: v.vx / 60, y: v.vy / 60 });

  /**
   * 建一个物理世界：width × groundY 的场景，左右有墙（opts.left / opts.right，缺省 0 / width）、底下是地面、顶上不封口。
   * 返回的对象持有自己的 engine；页面一局用一个，重开局 = reset()。
   */
  function createWorld(opts) {
    const engine = Engine.create(engineOptions(opts.gravity));
    addFrame(engine, opts);
    /** id -> matter body */
    const blocks = new Map();
    let pet = null;
    let impacts = [];

    // 碰撞开始那一刻的法向相对速度（px/s）= 撞得多狠：木箱掉血、宠物落地 Q 弹都看它
    Events.on(engine, 'collisionStart', (ev) => {
      for (const pair of ev.pairs) {
        const a = pair.bodyA.parent;
        const b = pair.bodyB.parent;
        const n = pair.collision.normal;
        const rv = { x: a.velocity.x - b.velocity.x, y: a.velocity.y - b.velocity.y };
        const speed = Math.abs(rv.x * n.x + rv.y * n.y) * 60;
        const sup = pair.collision.supports && pair.collision.supports[0];
        impacts.push({
          a: a.label === 'block' ? a.plugin.blockId : a.label,
          b: b.label === 'block' ? b.plugin.blockId : b.label,
          speed,
          x: sup ? sup.x : (a.position.x + b.position.x) / 2,
          y: sup ? sup.y : (a.position.y + b.position.y) / 2,
        });
      }
    });

    return {
      engine,
      /** 摆一垛积木（全部睡着）。layout: [{id, kind, x, y, w, h}] */
      addBlocks(layout) {
        for (const b of layout) {
          const body = Bodies.rectangle(b.x, b.y, b.w, b.h, {
            ...WOOD,
            chamfer: { radius: Math.min(2, b.h / 6) },
            label: 'block',
          });
          body.plugin.blockId = b.id;
          Composite.add(engine.world, body);
          Sleeping.set(body, true);
          blocks.set(b.id, body);
        }
      },
      removeBlock(id) {
        const body = blocks.get(id);
        if (!body) return;
        Composite.remove(engine.world, body);
        blocks.delete(id);
      },
      clearBlocks() {
        for (const id of [...blocks.keys()]) this.removeBlock(id);
      },
      /** 宠物从 center 以 v（px/s）飞出去 */
      launchPet(center, v) {
        this.removePet();
        pet = makePet(center);
        Composite.add(engine.world, pet);
        Body.setVelocity(pet, toStep(v));
      },
      removePet() {
        if (pet) Composite.remove(engine.world, pet);
        pet = null;
      },
      /** 宠物当前状态（中心 px / 速度 px/s）；不在场返回 null */
      petState() {
        if (!pet) return null;
        return { x: pet.position.x, y: pet.position.y, vx: pet.velocity.x * 60, vy: pet.velocity.y * 60 };
      },
      /** 给宠物一点阻尼（穿过木箱时「顶了一下」的手感）：k ∈ (0,1] */
      dampPet(k) {
        if (pet) Body.setVelocity(pet, { x: pet.velocity.x * k, y: pet.velocity.y * k });
      },
      /** 推进 dtMs（按 1/120 s 子步）；返回这段时间里所有新碰撞 */
      step(dtMs) {
        impacts = [];
        const n = Math.max(1, Math.round(dtMs / SUB_MS));
        for (let i = 0; i < n; i++) Engine.update(engine, dtMs / n);
        return impacts;
      },
      /** 每块积木的位置 / 角度 / 速度（px/s）/ 最低点 / 是否睡着 */
      blockStates() {
        const out = [];
        for (const [id, body] of blocks) {
          out.push({
            id,
            x: body.position.x,
            y: body.position.y,
            angle: body.angle,
            speed: Math.hypot(body.velocity.x, body.velocity.y) * 60,
            bottom: body.bounds.max.y,
            sleeping: body.isSleeping,
          });
        }
        return out;
      },
    };
  }

  /**
   * 瞄准轨迹：一个只有宠物和地面的「探针」世界，用与真实飞行**同一套** matter 参数和子步自由飞，
   * 所以在撞到东西之前，预览与实际逐点重合。每 every 个 1/60s 取一点，取满 count 点或落地即停。
   */
  function createProbe(opts) {
    const engine = Engine.create(engineOptions(opts.gravity));
    addFrame(engine, opts);
    const groundTop = opts.groundY;
    return {
      path(center, v, count, every) {
        const pet = makePet(center);
        Composite.add(engine.world, pet);
        Body.setVelocity(pet, toStep(v));
        const out = [];
        const subs = Math.round(BASE_MS / SUB_MS);
        for (let i = 1; i <= count * every && out.length < count; i++) {
          for (let k = 0; k < subs; k++) Engine.update(engine, BASE_MS / subs);
          const grounded = pet.bounds.max.y >= groundTop - 0.5;
          if (i % every === 0 || grounded) out.push({ x: pet.position.x, y: pet.position.y });
          if (grounded) break;
        }
        Composite.remove(engine.world, pet);
        return out;
      },
    };
  }

  return { createWorld, createProbe, PET_BODY, BASE_MS, SUB_MS };
});
