'use strict';
/**
 * 桌面图标碰撞的物理核心（纯计算：不碰 Electron、不碰子进程，可直接在 node 里单测）。
 *
 * 桌宠与桌面图标在同一个物理世界里：
 *   - 桌宠身体 = 渲染端的命中框（HIT_BOX，与 bodyPixelBox 同一套几何），位置/速度来自逐帧的 set-bounds；
 *   - 图标 = 圆（半径 = 图标格子宽 × ICON_RADIUS_SCALE），由 icon-bridge 读出位置、按这里的结果移动；
 *   - 碰撞是**双向**的：按质量交换动量（桌宠质量 1、图标质量 ICON_MASS）。飞行中的桌宠撞上图标会被弹开、
 *     减速，结果经既有的「被撞」通道（pet:hit → onDeskHit → startThrow）交回桌宠自己的物理继续飞；
 *     图标飞过来撞到站着的桌宠，速度变化足够大时把它撞飞；
 *   - 拖拽中的桌宠被手抓着：质量视为无穷大，只有图标被弹开；
 *   - 只有「飞行中」和「被拖着」的桌宠会主动撞图标：自主走位 / 回角落 / 位置指令从图标上方滑过；
 *     慢慢蹭上去、或一出现就压着的图标也不算撞击（「盖」而不是「打」）。
 * 俯视台面：图标没有重力，按恒定减速 + 少量粘滞摩擦停下，碰屏幕工作区边缘按 physics.restitution 反弹。
 *
 * 坐标：全部是物理像素的屏幕坐标。
 * @module dsh-pet/runtime/electron-helper/main/icon-world
 */

// 命中盒（640×360 舞台坐标）：用 pointer-target.js 的镜像（已有守卫测试保证它与 src/shared/constants.ts 一致）
const { HIT_BOX } = require('../pointer-target.js');

/** 物理子步长（s）。 */
const SUBSTEP = 0.004;
/** 低于此速度（px/s）图标停下。 */
const STOP_SPEED = 20;
/** 图标质量 / 桌宠质量：越大桌宠撞上去被弹回越狠、图标飞得越慢。 */
const ICON_MASS = 0.15;
/** 静止图标被撞时，相对速度低于它（px/s）按「盖」处理：桌宠从图标上滑过。 */
const MIN_HIT_SPEED = 250;
/** 桌宠与图标之间的恢复系数。 */
const PET_RESTITUTION = 0.85;
/** 图标与图标之间的恢复系数。 */
const ICON_RESTITUTION = 0.92;
/** 站着的桌宠被图标撞到时，速度变化超过它（px/s）才被撞飞。 */
const KNOCK_SPEED = 220;
/** 台面：粘滞摩擦（/s）与恒定减速度（px/s²）。 */
const FRICTION = 0.8;
const LINEAR_DECEL = 1200;
/** 图标最大速度（px/s）。 */
const MAX_SPEED = 3200;
/** 图标碰撞半径 = 图标格子宽 × 本值（0.5 = 相邻格子刚好不重叠）。 */
const ICON_RADIUS_SCALE = 0.48;

const len = (x, y) => Math.sqrt(x * x + y * y);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 包围盒左上角 + size + bottomPad → 身体矩形（与 src/shared/physics 的 bodyPixelBox 同一套几何）。
 *
 * @param {number} bx - 包围盒左上角 x（屏幕坐标）。
 * @param {number} by - 包围盒左上角 y。
 * @param {number} size - 宠物宽。
 * @param {number} bottomPad - 舞台脚底垫高。
 * @returns {{ l: number, t: number, r: number, b: number }}
 */
function bodyRect(bx, by, size, bottomPad) {
  const h = (size * 9) / 16;
  return {
    l: bx + (HIT_BOX.x0 / 640) * size,
    t: by + bottomPad + (HIT_BOX.y0 / 360) * h,
    r: bx + (HIT_BOX.x1 / 640) * size,
    b: by + bottomPad + (HIT_BOX.y1 / 360) * h,
  };
}

/**
 * 图标世界。
 *
 * hooks:
 *   now()                      单调时钟（s）
 *   move(list)                 list = [i, x, y, i, x, y, ...]：把第 i 个图标的格子左上角挪到 (x, y)
 *   petHit(petId, vx, vy)      桌宠被撞后的新速度（物理像素/s）
 *   fx({ sound?, kind, strength, x?, y? })  撞击反馈：sound=true 为音效，否则 x/y 为闪光位置
 */
class IconWorld {
  constructor(hooks) {
    this.hooks = hooks;
    this.restitution = 0.78; // 库边弹性：与桌宠撞墙同一个系数（physics.restitution）
    this.balls = [];
    this.cw = 76;
    this.ch = 96;
    this.areas = [];
    this.pets = new Map();
    this.busy = false;
    this.blocked = false;
    this.paused = false;
    this.lastT = hooks.now();
    this.lastSfx = 0;
    this.lastFlash = 0;
    this.wasMoving = false;
    this.needResync = false;
  }

  get r() {
    return ICON_RADIUS_SCALE * this.cw;
  }
  get offX() {
    return this.cw / 2;
  }
  get offY() {
    return this.ch * 0.38; // 图标在格子上半部分，文字在下面
  }
  get active() {
    return !this.busy && !this.blocked && !this.paused && this.balls.length > 0;
  }

  /** 库边弹性与桌宠同一个 physics.restitution。 */
  setRestitution(r) {
    if (Number.isFinite(Number(r))) this.restitution = clamp(Number(r), 0, 1);
  }

  // ───── 图标 ─────

  /** bridge 上报的图标快照：items[i] = [x, y]（格子左上角）或 null（取不到的占位）；areas = 工作区 [l,t,r,b]。 */
  setIcons(msg) {
    if (this.anyMoving()) {
      this.needResync = true; // 正在飞：这份快照里飞行中的图标位置是旧的，等这一杆打完再要一份
      return;
    }
    this.needResync = false;
    if (msg.cw > 0 && msg.ch > 0) {
      this.cw = msg.cw;
      this.ch = msg.ch;
    }
    if (Array.isArray(msg.areas)) {
      this.areas = msg.areas
        .filter((a) => Array.isArray(a) && a.length === 4)
        .map((a) => ({ l: a[0], t: a[1], r: a[2], b: a[3] }));
    }
    const next = [];
    (msg.items || []).forEach((it, i) => {
      if (!Array.isArray(it)) return;
      next.push({
        i,
        x: it[0] + this.offX,
        y: it[1] + this.offY,
        px: it[0],
        py: it[1],
        vx: 0,
        vy: 0,
        moving: false,
        touched: false,
        slide: new Set(), // 正被哪些桌宠「盖」着（从上面滑过、不推）
        contact: new Set(), // 正贴着哪些桌宠
      });
    });
    this.balls = next;
  }

  /** 你在桌面上按住鼠标（框选/拖图标）或在重命名：暂停。 */
  setBusy(v) {
    this.busy = !!v;
    if (this.busy) this.stopAll();
  }

  /** 桌面开着「自动排列」：暂停。 */
  setBlocked(v) {
    this.blocked = !!v;
    if (this.blocked) this.stopAll();
  }

  /** 前台在跑全屏游戏/视频/演示：暂停。 */
  setPaused(v) {
    this.paused = !!v;
    if (this.paused) this.stopAll();
  }

  anyMoving() {
    for (const b of this.balls) if (b.moving) return true;
    return false;
  }

  stopAll() {
    for (const b of this.balls) {
      b.vx = 0;
      b.vy = 0;
      b.moving = false;
    }
    this.pushMoves();
  }

  // ───── 桌宠 ─────

  /**
   * 渲染端每帧上报一次。s = { bx, by, size, bottomPad, vx, vy, flying, held }（物理像素）。
   * 在这里做「桌宠撞图标」：沿上一帧到这一帧的路径扫过去，第一次接触就结算。
   * @returns {boolean} 本帧是否撞上了图标（调用方据此启动物理循环）
   */
  updatePet(id, s) {
    const now = this.hooks.now();
    const body = bodyRect(s.bx, s.by, s.size, s.bottomPad);
    let p = this.pets.get(id);
    if (!p) {
      p = { id, body, hist: [], vx: 0, vy: 0, flying: false, held: false, dvx: 0, dvy: 0, t: now };
      this.pets.set(id, p);
    }
    const prev = p.body;
    p.body = body;
    p.t = now;
    p.flying = !!s.flying;
    p.held = !!s.held;
    p.hist.push({ t: now, x: body.l, y: body.t });
    while (p.hist.length > 2 && p.hist[0].t < now - 0.12) p.hist.shift();
    if (p.flying && Number.isFinite(s.vx) && Number.isFinite(s.vy)) {
      p.vx = s.vx;
      p.vy = s.vy;
    } else {
      // 拖拽/走路时渲染端报的速度是 0：用最近 ~45ms 的位移差分
      let ref = p.hist[0];
      for (const h of p.hist) if (h.t <= now - 0.045) ref = h;
      const dt = now - ref.t;
      p.vx = dt > 0.008 ? (body.l - ref.x) / dt : 0;
      p.vy = dt > 0.008 ? (body.t - ref.y) / dt : 0;
      if (len(p.vx, p.vy) > MAX_SPEED * 2) {
        p.vx = 0;
        p.vy = 0;
      }
    }
    if (!this.active) return false;
    // 只有被甩出去在飞、或者被你拖着的桌宠才会主动撞图标；其余移动从图标上方滑过
    if (!p.flying && !p.held) {
      for (const b of this.balls) if (!b.moving && this.overlaps(b, body)) b.slide.add(id);
      return false;
    }
    const dx = body.l - prev.l;
    const dy = body.t - prev.t;
    const dist = len(dx, dy);
    if (dist > 1500) return false; // 瞬移（换屏/回角落）：不算撞击
    const n = clamp(Math.ceil(dist / Math.max(4, this.r * 0.5)), 1, 32);
    const stepDisp = dist / n;
    let hit = false;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const bk = { l: prev.l + dx * f, t: prev.t + dy * f, r: prev.r + dx * f, b: prev.b + dy * f };
      for (const b of this.balls) if (this.contact(b, p, bk, stepDisp, 'pet')) hit = true;
      if (hit && (p.dvx !== 0 || p.dvy !== 0)) break; // 桌宠已经被弹开：后半段路径不会再走
    }
    if (hit) {
      this.flushPet(p);
      this.pushMoves(); // 撞上的这一刻就把图标挪出去，不等下一个 tick
    }
    return hit;
  }

  removePet(id) {
    this.pets.delete(id);
    for (const b of this.balls) {
      b.slide.delete(id);
      b.contact.delete(id);
    }
  }

  overlaps(b, body) {
    const dx = b.x - clamp(b.x, body.l, body.r);
    const dy = b.y - clamp(b.y, body.t, body.b);
    return dx * dx + dy * dy < this.r * this.r;
  }

  /**
   * 一个图标与桌宠身体的接触；返回 true = 这一刻发生了碰撞响应。
   * source = 'pet'（桌宠移动触发）/ 'world'（图标移动触发）。
   */
  contact(b, p, body, stepDisp, source) {
    const r = this.r;
    const cx = b.x;
    const cy = b.y;
    const dx = cx - clamp(cx, body.l, body.r);
    const dy = cy - clamp(cy, body.t, body.b);
    const d2 = dx * dx + dy * dy;
    let nx;
    let ny;
    let pen;
    if (d2 > 1e-9) {
      if (d2 >= r * r) {
        b.slide.delete(p.id);
        b.contact.delete(p.id);
        return false;
      }
      const d = Math.sqrt(d2);
      nx = dx / d;
      ny = dy / d;
      pen = r - d;
    } else {
      // 圆心已经在身体里：从最近的一条边推出去
      const edges = [
        [cx - body.l, -1, 0],
        [body.r - cx, 1, 0],
        [cy - body.t, 0, -1],
        [body.b - cy, 0, 1],
      ];
      let best = edges[0];
      for (const e of edges) if (e[0] < best[0]) best = e;
      nx = best[1];
      ny = best[2];
      pen = best[0] + r;
    }
    if (b.slide.has(p.id)) return false;

    const stale = this.hooks.now() - p.t > 0.1; // 很久没上报 = 桌宠静止
    const pvx = (stale ? 0 : p.vx) + p.dvx;
    const pvy = (stale ? 0 : p.vy) + p.dvy;
    const vn = (b.vx - pvx) * nx + (b.vy - pvy) * ny; // < 0 = 正在靠近
    const approach = -vn;
    let fresh = false;
    if (!b.contact.has(p.id)) {
      if (!b.moving && source === 'pet') {
        const gentle = approach < MIN_HIT_SPEED;
        const alreadyUnder = pen > stepDisp * 1.5 + 4; // 这一步走不了这么深：本来就压着
        if (gentle || alreadyUnder) {
          b.slide.add(p.id);
          return false;
        }
      }
      b.contact.add(p.id);
      fresh = true;
    }

    b.x += nx * pen;
    b.y += ny * pen;
    if (vn < 0) {
      const twoWay = !p.held;
      // 冲量 j：双向 = 按质量分配；被手抓着 = 桌宠质量无穷大
      const j = twoWay ? (-(1 + PET_RESTITUTION) * vn) / (1 / ICON_MASS + 1) : -(1 + PET_RESTITUTION) * vn * ICON_MASS;
      b.vx += (j / ICON_MASS) * nx;
      b.vy += (j / ICON_MASS) * ny;
      if (twoWay) {
        p.dvx -= j * nx;
        p.dvy -= j * ny;
      }
      if (fresh) {
        this.sfx(approach, 'hit');
        if (approach > 150) this.flash(cx - nx * r, cy - ny * r, approach);
      }
    }
    const sp = len(b.vx, b.vy);
    if (sp > MAX_SPEED) {
      b.vx *= MAX_SPEED / sp;
      b.vy *= MAX_SPEED / sp;
    }
    b.moving = true;
    b.touched = true;
    return true;
  }

  /** 把累计的速度变化交还给桌宠自己的物理（「被撞」通道）。 */
  flushPet(p) {
    const dvx = p.dvx;
    const dvy = p.dvy;
    p.dvx = 0;
    p.dvy = 0;
    if (p.held) return;
    const dv = len(dvx, dvy);
    if (dv < 30) return;
    // 渲染端落地后就不再上报：最后一帧还标着 flying。超过 0.1s 没消息 = 已经停了
    const now = this.hooks.now();
    const flying = p.flying && now - p.t < 0.1;
    if (!flying && dv < KNOCK_SPEED) return; // 站着的桌宠：轻轻碰一下不至于被撞飞
    p.vx = (flying ? p.vx : 0) + dvx;
    p.vy = (flying ? p.vy : 0) + dvy;
    p.flying = true;
    p.t = now;
    this.hooks.petHit(p.id, p.vx, p.vy);
  }

  sfx(speed, kind) {
    const now = this.hooks.now();
    if (now - this.lastSfx < 0.035) return;
    if (speed < (kind === 'cushion' ? 300 : 120)) return;
    this.lastSfx = now;
    this.hooks.fx({ sound: true, kind, strength: clamp(speed / 2200, 0.1, 1) });
  }

  flash(x, y, speed) {
    const now = this.hooks.now();
    if (now - this.lastFlash < 0.03) return;
    this.lastFlash = now;
    this.hooks.fx({ kind: 'hit', x, y, strength: clamp(speed / 2200, 0.15, 1) });
  }

  // ───── 主循环 ─────

  /** 推进到当前时刻；返回 true = 还有图标在动（调用方继续 tick）。 */
  tick() {
    const now = this.hooks.now();
    let total = now - this.lastT;
    this.lastT = now;
    if (!this.active) return false;
    if (!this.anyMoving()) {
      if (this.needResync) {
        this.needResync = false;
        if (this.hooks.requestSnapshot) this.hooks.requestSnapshot();
      }
      return false;
    }
    if (total <= 0) return true;
    if (total > 0.1) total = 0.1;
    const steps = clamp(Math.ceil(total / SUBSTEP), 1, 40);
    const h = total / steps;
    for (let s = 0; s < steps; s++) this.step(h);
    for (const p of this.pets.values()) this.flushPet(p);
    const moving = this.anyMoving();
    if (this.wasMoving && !moving) this.settleOverlaps();
    this.wasMoving = moving;
    this.pushMoves();
    return moving;
  }

  step(h) {
    const decay = Math.exp(-FRICTION * h);
    const decel = LINEAR_DECEL * h;
    for (const b of this.balls) {
      if (!b.moving) continue;
      b.x += b.vx * h;
      b.y += b.vy * h;
    }
    // 飞行中的图标撞桌宠（桌宠站着也会被撞到）
    for (const p of this.pets.values()) {
      for (const b of this.balls) if (b.moving) this.contact(b, p, p.body, 0, 'world');
    }
    const balls = this.balls;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      for (let j = i + 1; j < balls.length; j++) {
        const c = balls[j];
        if (a.moving || c.moving) this.collideBalls(a, c);
      }
    }
    for (const b of balls) {
      if (!b.moving) continue;
      this.walls(b, true);
      const sp = len(b.vx, b.vy);
      const ns = sp * decay - decel;
      if (ns < STOP_SPEED) {
        b.vx = 0;
        b.vy = 0;
        b.moving = false;
      } else {
        const k = Math.min(ns, MAX_SPEED) / sp;
        b.vx *= k;
        b.vy *= k;
      }
    }
  }

  collideBalls(a, c) {
    const minD = 2 * this.r;
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minD * minD) return;
    let d = Math.sqrt(d2);
    let nx = 1;
    let ny = 0;
    if (d >= 1e-3) {
      nx = dx / d;
      ny = dy / d;
    } else d = 0;
    const overlap = (minD - d) / 2;
    a.x -= nx * overlap;
    a.y -= ny * overlap;
    c.x += nx * overlap;
    c.y += ny * overlap;
    const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
    if (vn < 0) {
      const j = (-(1 + ICON_RESTITUTION) * vn) / 2;
      a.vx -= j * nx;
      a.vy -= j * ny;
      c.vx += j * nx;
      c.vy += j * ny;
      this.sfx(-vn, 'hit');
      if (-vn > 900) this.flash(a.x + nx * this.r, a.y + ny * this.r, -vn);
    }
    a.moving = true;
    a.touched = true;
    c.moving = true;
    c.touched = true;
  }

  areaFor(x, y) {
    if (this.areas.length === 0) return { l: -1e6, t: -1e6, r: 1e6, b: 1e6 };
    let best = this.areas[0];
    let bestD = Infinity;
    for (const a of this.areas) {
      const ddx = x < a.l ? a.l - x : x > a.r ? x - a.r : 0;
      const ddy = y < a.t ? a.t - y : y > a.b ? y - a.b : 0;
      const dd = ddx * ddx + ddy * ddy;
      if (dd < bestD) {
        bestD = dd;
        best = a;
      }
      if (dd === 0) break;
    }
    return best;
  }

  /** 图标格子碰到工作区边缘：夹回并按 physics.restitution 反弹。 */
  walls(b, bounce) {
    const a = this.areaFor(b.x, b.y);
    const e = bounce ? this.restitution : 0;
    const left = b.x - this.offX;
    const top = b.y - this.offY;
    let hit = 0;
    if (left < a.l) {
      b.x = a.l + this.offX;
      if (b.vx < 0) {
        hit = Math.max(hit, -b.vx);
        b.vx = -b.vx * e;
      }
    } else if (left + this.cw > a.r) {
      b.x = a.r - this.cw + this.offX;
      if (b.vx > 0) {
        hit = Math.max(hit, b.vx);
        b.vx = -b.vx * e;
      }
    }
    if (top < a.t) {
      b.y = a.t + this.offY;
      if (b.vy < 0) {
        hit = Math.max(hit, -b.vy);
        b.vy = -b.vy * e;
      }
    } else if (top + this.ch > a.b) {
      b.y = a.b - this.ch + this.offY;
      if (b.vy > 0) {
        hit = Math.max(hit, b.vy);
        b.vy = -b.vy * e;
      }
    }
    if (bounce && hit > 0) this.sfx(hit, 'cushion');
  }

  /** 一杆打完：把这一杆里动过、但最后叠在一起的图标轻轻推开（没被碰过的不动）。 */
  settleOverlaps() {
    const minD = 2 * this.r;
    const balls = this.balls;
    for (let iter = 0; iter < 12; iter++) {
      let moved = false;
      for (let i = 0; i < balls.length; i++) {
        const a = balls[i];
        for (let j = i + 1; j < balls.length; j++) {
          const c = balls[j];
          if (!a.touched && !c.touched) continue;
          const dx = c.x - a.x;
          const dy = c.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD) continue;
          let d = Math.sqrt(d2);
          let nx = 1;
          let ny = 0;
          if (d >= 1e-3) {
            nx = dx / d;
            ny = dy / d;
          } else d = 0;
          const push = minD - d + 0.5;
          if (a.touched && c.touched) {
            a.x -= (nx * push) / 2;
            a.y -= (ny * push) / 2;
            c.x += (nx * push) / 2;
            c.y += (ny * push) / 2;
          } else if (a.touched) {
            a.x -= nx * push;
            a.y -= ny * push;
          } else {
            c.x += nx * push;
            c.y += ny * push;
          }
          moved = true;
        }
      }
      for (const b of balls) if (b.touched) this.walls(b, false);
      if (!moved) break;
    }
    for (const b of balls) b.touched = false;
  }

  /** 把位置有变化的图标交给 bridge。 */
  pushMoves() {
    const list = [];
    for (const b of this.balls) {
      const nx = Math.round(b.x - this.offX);
      const ny = Math.round(b.y - this.offY);
      if (nx !== b.px || ny !== b.py) {
        list.push(b.i, nx, ny);
        b.px = nx;
        b.py = ny;
      }
    }
    if (list.length) this.hooks.move(list);
  }
}

module.exports = { IconWorld, bodyRect, HIT_BOX };
