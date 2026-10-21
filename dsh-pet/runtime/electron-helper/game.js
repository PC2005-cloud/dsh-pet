/**
 * 「弹弓」控制器 —— 输入 / 飞行 / 回位 / 特效（经典 script；依赖 shared-core.js、matter.min.js、
 * game-physics.js、sling-meta.js、game-art.js、pet-frame-filter.js）。
 *
 * 规则不在这里：拉伸夹取、初速、木箱垛布局、损伤与「全倒」判定、会话状态来自 src/shared/slingshot-game.ts；
 * 刚体模拟（木箱翻倒 / 碰撞 / 宠物飞行）在 game-physics.js（matter-js）。本文件只做：
 *   - 拽住宠物往后拉（宠物身体之外整窗点击穿透），松手把她作为刚体弹出去；
 *   - 固定步长推进物理，碰撞够狠的木箱先裂、再碎（碎成木片 + 一团木屑）；
 *   - 她停下后淡出、在弹弓皮兜里淡入（不用跑回去）；整排都被推倒了就开心地跳一下，木箱再重新码好。
 *
 * 会话：窗口每次打开都是新页面；startSession() 是唯一的「开局」入口（进入时一次 / 右键「重新开始」），
 * 它连同物理世界一起整体重建——没有任何东西从上一局漏过来。rAF 循环、事件监听只在页面加载时注册一次。
 */
'use strict';

(() => {
  const S = window.PetShared;
  const A = GameArt;
  const GP = window.GamePhysics;
  const ANCHOR = S.SLING_ANCHOR;
  const BASE = S.SLING_BASE;
  const GROUND = S.GAME_GROUND_Y;
  const TIPS = A.tips(BASE);
  const PET_W = S.GAME_PET_SIZE;
  const PET_H = (PET_W * 9) / 16;
  /** 物理参数；左右墙在开局时按窗口左右边补上，见 physOpts() */
  const PHYS = { groundY: GROUND, gravity: S.GAME_GRAVITY };
  const STEP_MS = S.GAME_STEP_DT * 1000;

  // ---- 手感（秒 / 场景像素） ----
  const MAX_FRAME_DT = 0.25; // 单帧最多补算的物理时长（卡顿后不快进）
  const PULL_FOLLOW = 26; // 拉弓跟手的收敛速度（越大越贴手）
  const SNAP_SEC = 0.4; // 拉得太短：弹回皮兜
  const REST_SEC = 0.45; // 停下后定一下神再回弹弓
  const CALM_SPEED = 20; // 积木都慢于它（或睡着）= 这一垛安静下来了，才判「倒没倒完」
  const SETTLE_SPEED = 15; // 宠物慢于它持续 SETTLE_FRAMES 帧 = 停下了
  const SETTLE_FRAMES = 15;
  const CHEER_SEC = 2.6; // 整垛倒了：欢呼多久
  const VANISH_SEC = 0.22; // 停下的地方淡出
  const APPEAR_SEC = 0.3; // 皮兜里淡入
  const LAUNCH_STRETCH_SEC = 0.18;
  const LAND_SQUASH_SPEED = 300; // 宠物落地 / 撞上东西的法向速度超过它才 Q 弹
  const BLOCK_IN_SEC = 0.45; // 重新码好时每块淡入
  const BLOCK_IN_GAP = 0.05;
  const BLOCK_IN_DELAY = 0.25;
  const BLOCK_OUT_SEC = 0.35; // 旧的那几块淡出
  const TRAIL_EVERY = 0.06;
  const BAND_REST_THICK = 3.6;
  const POUCH_SPRING_K = 950; // 皮筋回弹要快：一下弹回、冲过头一点、两三下就停
  const POUCH_SPRING_C = 32;

  const init = parseInit();
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const sayEl = document.getElementById('say');
  const clip = createClip(init.assetBase);
  const petFrames = window.PetFrameFilter.create();
  /** 窗口尺寸 / 缩放变了：这一局的墙、木箱垛位置与弹力都按旧窗口算的，等宠物回到皮兜就按新窗口重新开局 */
  let viewChanged = false;

  // ---- 每局状态（startSession 整体重建） ----
  let session = null;
  let sessionCount = 0;
  // ---- 页面级状态（与局无关） ----
  let view = { fit: 1, offX: 0, offY: 0, dpr: 1 };
  let menu = null;
  let lastInputKey = '';
  let hoverPet = false;
  let loops = 0;
  let ready = false;

  function parseInit() {
    try {
      const raw = new URLSearchParams(location.search).get('init');
      const v = raw ? JSON.parse(raw) : null;
      if (v && typeof v === 'object') return v;
    } catch (e) {
      console.error('[dsh-pet slingshot] init 参数解析失败：', e);
    }
    return { petName: '宠物', petSize: 0, base: '', assetBase: '', idle: [], drag: [], cheer: '' };
  }

  const pick = (pool) => (pool && pool.length ? pool[Math.floor(Math.random() * pool.length)] : '');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const smooth = (u) => u * u * (3 - 2 * u);
  const easeOutBack = (u) => 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2);

  /**
   * 宠物动画：两条 video 交替（新一段准备好才换前台，切换不闪空帧），只作 canvas 帧源。
   * 素材先整段取成 blob 再播：保证可以 seek（欢呼只循环其中最欢的那一段）。
   */
  function createClip(assetBase) {
    const make = () => {
      const v = document.createElement('video');
      v.className = 'clip';
      v.muted = true;
      v.playsInline = true;
      document.body.appendChild(v);
      return v;
    };
    const vids = [make(), make()];
    const blobs = new Map();
    let front = -1;
    let want = null; // 最近一次请求 { key, seg, from, to }
    let active = null; // 前台视频此刻真正在播的那个请求（片段循环只认它）
    const urlOf = (name) => {
      if (!blobs.has(name)) {
        const src = assetBase + encodeURIComponent(name) + (S.ANIMATION_EXT || '.webm');
        const task = fetch(src)
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('http ' + r.status))))
          .then((b) => URL.createObjectURL(b));
        task.catch(() => blobs.delete(name)); // 失败不缓存：下次再要这段动画会重新取
        blobs.set(name, task);
      }
      return blobs.get(name);
    };
    return {
      /** 提前把要用到的动画取成 blob（欢呼第一次出现时不卡在上一个姿势上） */
      preload(names) {
        if (!assetBase) return;
        for (const n of names) if (n) urlOf(n).catch(() => {});
      },
      /** seg：{fromFrac, toFrac}（按时长比例循环其中一段）；省略 = 整段循环 */
      play(name, seg) {
        if (!assetBase || !name) return;
        const key = name + '|' + JSON.stringify(seg || null);
        if (want && want.key === key) return;
        const req = { key, seg: seg || null };
        want = req;
        urlOf(name)
          .then((url) => {
            if (want !== req) return;
            const back = front === 0 ? 1 : 0;
            const v = vids[back];
            const go = () => {
              if (want !== req) return;
              if (front >= 0 && front !== back) vids[front].pause();
              front = back;
              active = req;
              v.play().catch(() => {});
            };
            v.onloadedmetadata = () => {
              if (want !== req) return;
              const d = v.duration || 10;
              req.from = seg ? seg.fromFrac * d : 0;
              // 给结尾留够余量：播到 ended 就再也绕不回来了
              req.to = Math.min(seg ? seg.toFrac * d : d, d - 0.25);
              if (seg && req.to - req.from < 0.3) {
                // 片段放不下（动画比预想的短）：退回整段循环，至少在动
                req.seg = null;
                req.from = 0;
                req.to = d;
                v.loop = true;
              }
              if (req.from > 0) {
                v.onseeked = () => {
                  v.onseeked = null;
                  go();
                };
                v.currentTime = req.from;
              } else {
                v.onloadeddata = () => {
                  v.onloadeddata = null;
                  go();
                };
              }
            };
            v.loop = !seg;
            v.src = url;
          })
          .catch((e) => {
            console.error('[dsh-pet slingshot] 动画加载失败：' + name, e);
            if (want === req) want = null; // 允许下一次 play() 重新请求同一段
          });
      },
      /** 逐帧调用：片段播到头就绕回片段开头（只管前台那条视频与它自己的请求） */
      tick() {
        const v = front >= 0 ? vids[front] : null;
        if (!v || !active || !active.seg) return;
        if (v.currentTime >= active.to || v.ended) v.currentTime = active.from;
        if (v.paused || v.ended) v.play().catch(() => {});
      },
      frame() {
        const v = front >= 0 ? vids[front] : null;
        return v && v.readyState >= 2 ? v : null;
      },
    };
  }

  const playIdle = () => clip.play(pick(init.idle));
  const playHeld = () => clip.play(pick(init.drag) || pick(init.idle));
  const playCheer = () =>
    init.cheer ? clip.play(init.cheer, { fromFrac: 0.35, toFrac: 0.62 }) : clip.play(pick(init.idle));

  // ---- 布局（S.sceneView）：场景按桌宠大小缩放（宠物与桌面上一样大），弹弓在屏宽 1/6 处、木箱垛右边缘在 5/6 处，
  //      地面贴窗口底（= 任务栏上沿），左右墙就是窗口左右边 ----
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const next = S.sceneView({ width: w, height: h, petSize: init.petSize });
    viewChanged = viewChanged || ['fit', 'offX', 'offY'].some((k) => Math.abs(next[k] - view[k]) > 1e-6);
    view = { ...next, dpr };
  }
  /** 当前窗口下的物理参数：墙 = 窗口左右边（换算成场景坐标），宠物和木箱撞的是看得见的屏幕边 */
  const physOpts = () => ({ ...PHYS, left: view.wallLeft, right: view.wallRight });
  const toWorld = (cx, cy) => ({ x: (cx - view.offX) / view.fit, y: (cy - view.offY) / view.fit });
  const toClient = (p) => ({ x: view.offX + p.x * view.fit, y: view.offY + p.y * view.fit });

  const feetOf = (center) => S.petBody(S.petBoxAt(center)).bottom;
  /** 画面上的身体中心比物理刚体中心低这么多：刚体比画面里的身体框矮一点，脚底要对齐地面 */
  const FEET_GAP = feetOf({ x: 0, y: 0 }) - GP.PET_BODY.h / 2;
  const toPhysics = (c) => ({ x: c.x, y: c.y - FEET_GAP });
  const fromPhysics = (p) => ({ x: p.x, y: p.y + FEET_GAP });
  /** 站在地面上时身体中心的 y */
  const GROUND_CENTER_Y = GROUND - feetOf({ x: 0, y: 0 });
  /** 皮兜在宠物脚下（待发 / 淡入回来时）的位置 */
  const pouchUnderFeet = (center) => ({ x: center.x - 3, y: feetOf(center) + 1 });
  /** 空皮兜垂在两叉之间 */
  const POUCH_EMPTY = { x: (TIPS.back.x + TIPS.front.x) / 2, y: (TIPS.back.y + TIPS.front.y) / 2 + 7 };

  // ================= 会话 =================
  /** 开局：进入窗口时一次、右键「重新开始」时一次。连同物理世界整体重建，旧的木箱 / 碎片 / 速度全部丢弃 */
  function startSession(t) {
    sessionCount += 1;
    const world = GP.createWorld(physOpts());
    const spots = S.pileAt(view.pileRight); // 这一局木箱垛摆在哪（屏宽 5/6 处右对齐），重新码好也码回这里
    world.addBlocks(spots);
    viewChanged = false;
    session = {
      game: S.newSession(),
      world,
      spots,
      power: view.power, // 这一局的弹力（与木箱垛离多远配套）
      probe: GP.createProbe(physOpts()), // 瞄准探针：只有宠物和地面、墙与真实世界一致

      blocksIn: t, // 木箱码好的时刻（逐块淡入）
      leaving: [], // 重新码好时淡出的旧木箱 { kind, x, y, w, angle, cracked, t0 }
      pet: { mode: 'ready', center: { ...ANCHOR }, box: S.petBoxAt(ANCHOR), vx: 0, vy: 0, tilt: 0, facing: 'right' },
      pulled: { ...ANCHOR },
      pullTarget: { ...ANCHOR },
      grab: null, // { id, dx, dy }：拽住时指针相对身体中心的偏移
      flightT: 0,
      stillFrames: 0,
      stepAcc: 0,
      until: 0, // rest / cheer 结束时刻
      cheerInPouch: false,
      snap: null, // { from, t0 }
      fade: null, // { t0 }：回弹弓时淡出 / 淡入的起点
      squash: null, // { t0, depth }
      stretch: null, // { t0 }
      pouch: { pos: pouchUnderFeet(ANCHOR), vel: { x: 0, y: 0 } },
      particles: [], // 拖尾小泡泡 / 木片 / 木屑
      lastTrail: 0,
      respawnPending: false,
    };
    closeMenu();
    playIdle();
  }

  /** 整垛倒了、欢呼完、宠物回到皮兜之后：剩下的旧木箱淡出，一垛新的原样码好（全部睡着、纹丝不动） */
  function respawnBlocks(t) {
    const s = session;
    s.leaving = s.world.blockStates().map((b) => ({
      kind: s.spots[b.id].kind,
      x: b.x,
      y: b.y,
      w: s.spots[b.id].w,
      angle: b.angle,
      cracked: blockCracked(b.id),
      t0: t,
    }));
    s.world.clearBlocks();
    s.world.addBlocks(s.spots);
    s.game = S.newSession();
    s.blocksIn = t;
    s.respawnPending = false;
  }

  const blockCracked = (id) => {
    const b = session.game.blocks[id];
    return !!b && b.hp < S.BLOCK_HP;
  };
  const brokenSet = () => new Set(session.game.blocks.filter((b) => b.broken).map((b) => b.id));
  const blocksCalm = () => session.world.blockStates().every((b) => b.sleeping || b.speed < CALM_SPEED);
  const flattened = () => S.isFlattened(session.world.blockStates(), brokenSet());

  // ================= 输入 =================
  function petBodyClient() {
    const b = S.petBody(S.petBoxAt(session.pet.center));
    const tl = toClient({ x: b.left, y: b.top });
    const br = toClient({ x: b.right, y: b.bottom });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }
  const inRect = (r, x, y, pad) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
  /** 宠物此刻能不能被拽：在皮兜里、这一垛还没倒完 */
  const canGrab = () => session.pet.mode === 'ready' && session.game.phase === 'aiming';
  /** 宠物此刻能不能被右键：飞行中、正在淡出回弹弓时不行（人在天上 / 快看不见了），其余时候都可以 */
  const canMenu = () => session.pet.mode !== 'fly' && session.pet.mode !== 'vanish';

  function setCursor() {
    const s = session;
    let c = '';
    if (s.grab) c = cursorCss('cursor-grabbing.png', 'grabbing');
    else if (hoverPet && canGrab()) c = cursorCss('cursor-grab.png', 'grab');
    if (canvas.style.cursor !== c) canvas.style.cursor = c;
  }
  const cursorCss = (file, fallback) =>
    init.base ? 'url("' + init.base + '/pic/' + file + '") 16 16, ' + fallback : fallback;

  canvas.addEventListener('pointermove', (e) => {
    if (!session) return;
    hoverPet = inRect(petBodyClient(), e.clientX, e.clientY, 4);
    const s = session;
    if (s.grab && e.pointerId === s.grab.id) {
      if (e.buttons === 0) return endPull(e, false); // 松手事件丢了：按取消处理
      const w = toWorld(e.clientX, e.clientY);
      s.pullTarget = S.aimPoint({ x: w.x - s.grab.dx, y: w.y - s.grab.dy });
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!session || e.button !== 0 || menu) return;
    if (!canGrab() || !inRect(petBodyClient(), e.clientX, e.clientY, 4)) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已失效：不捕获也能拉 */
    }
    const s = session;
    const w = toWorld(e.clientX, e.clientY);
    s.grab = { id: e.pointerId, dx: w.x - ANCHOR.x, dy: w.y - ANCHOR.y };
    s.pullTarget = { ...ANCHOR };
    s.pulled = { ...ANCHOR };
    s.pet.mode = 'pull';
    reportInput(); // 立刻告诉主进程「正拿着鼠标」：别等下一帧，快速甩出命中区时轮询不会先把窗口翻成穿透
    hideSay();
    playHeld();
  });

  function endPull(e, fire) {
    const s = session;
    if (!s || !s.grab || e.pointerId !== s.grab.id) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    s.grab = null;
    reportInput();
    const t = performance.now() / 1000;
    const v = fire ? S.slingVelocity(s.pulled, s.power) : null;
    if (!v) {
      s.pet.mode = 'snap';
      s.snap = { from: { ...s.pulled }, t0: t };
      playIdle();
      return;
    }
    s.game = S.fireShot(s.game);
    s.pet.mode = 'fly';
    s.pet.center = { ...s.pulled };
    s.pet.vx = v.vx;
    s.pet.vy = v.vy;
    s.pet.facing = v.vx >= 0 ? 'right' : 'left';
    s.world.launchPet(toPhysics(s.pulled), v);
    s.flightT = 0;
    s.stillFrames = 0;
    s.stretch = { t0: t };
    s.pouch.vel = { x: 0, y: 0 }; // 皮兜从松手的位置自己弹回去（弹簧），会冲过头再晃几下
  }
  canvas.addEventListener('pointerup', (e) => endPull(e, true));
  canvas.addEventListener('pointercancel', (e) => endPull(e, false));
  canvas.addEventListener('lostpointercapture', (e) => endPull(e, false));

  // 右键：用桌宠同一个菜单组件（同样子、同手感），只有两项
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!session || session.grab || !canMenu()) return;
    if (!inRect(petBodyClient(), e.clientX, e.clientY, 4)) return;
    closeMenu();
    menu = S.mountContextMenu({
      tree: [
        { label: '重新开始', action: 'restart' },
        { label: '回到桌面', action: 'exit' },
      ],
      x: e.clientX,
      y: e.clientY,
      onAction: (leaf) => {
        menu = null;
        if (leaf.action === 'exit') window.close();
        else if (leaf.action === 'restart') startSession(performance.now() / 1000);
      },
      onClose: () => {
        menu = null;
      },
    });
    reportInput(); // 菜单是整窗任意位置的 DOM：开着时整窗接住鼠标
  });
  function closeMenu() {
    if (!menu) return;
    const m = menu;
    menu = null;
    m.close();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close(); // 主进程也拦了一层 Esc（页面脚本挂了也能退）
  });
  window.addEventListener('resize', resize);

  /** 把交互区域报给主进程（只在变化时发）：宠物身体 + 菜单；拖拽 / 菜单开着时整窗接住鼠标 */
  function reportInput() {
    if (!window.gameBridge || !session) return;
    const s = session;
    const regions = [];
    if (canMenu()) {
      const r = petBodyClient();
      regions.push({
        x: Math.round(r.x - 6),
        y: Math.round(r.y - 6),
        w: Math.round(r.w + 12),
        h: Math.round(r.h + 12),
      });
    }
    const input = { regions, busy: !!s.grab || !!menu };
    const key = JSON.stringify(input);
    if (key === lastInputKey) return;
    lastInputKey = key;
    window.gameBridge.reportInput(input);
  }

  // ---- 第一次进入时的一句话（之后不再出现） ----
  const SAY_KEY = 'dsh-pet:slingshot-said';
  let sayUntil = 0;
  function maybeSay(t) {
    let said = false;
    try {
      said = localStorage.getItem(SAY_KEY) === '1';
      localStorage.setItem(SAY_KEY, '1');
    } catch {
      /* 存储不可用：每次都说也无妨 */
    }
    if (!said) sayUntil = t + 4.5;
  }
  function hideSay() {
    sayUntil = 0;
  }
  function placeSay(t) {
    const on = t < sayUntil && session.pet.mode === 'ready';
    sayEl.classList.toggle('is-on', on);
    if (!on) return;
    const b = S.petBody(S.petBoxAt(session.pet.center));
    const p = toClient({ x: (b.left + b.right) / 2, y: b.top - 6 });
    sayEl.style.left = p.x + 'px';
    sayEl.style.top = p.y + 'px';
  }

  // ================= 推进 =================
  /** 物理碰撞 → 木箱掉血（裂 / 碎）+ 宠物撞上东西时 Q 弹一下 */
  function onImpacts(impacts, t) {
    const s = session;
    for (const im of impacts) {
      const petHit = im.a === 'pet' || im.b === 'pet';
      if (petHit && s.pet.mode === 'fly' && im.speed > LAND_SQUASH_SPEED && !s.squash) {
        s.squash = { t0: t, depth: S.landingSquash(im.speed) };
      }
      for (const id of [im.a, im.b]) {
        if (typeof id !== 'number') continue;
        const dmg = S.impactDamage(im.speed);
        if (!dmg) continue;
        const r = S.damageBlock(s.game, id, dmg);
        s.game = r.state;
        if (r.broke) breakBlock(id, t);
        else if (r.cracked) puff(im.x, im.y, 0.55, t);
      }
    }
  }

  /** 木箱碎掉：从物理世界拿走，原地迸出几片木片和一团木屑 */
  function breakBlock(id, t) {
    const s = session;
    const b = s.world.blockStates().find((x) => x.id === id);
    s.world.removeBlock(id);
    if (!b) return;
    const spot = s.spots[id];
    const n = 4;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 140 + Math.random() * 200;
      const along = (Math.random() - 0.5) * spot.w * 0.5;
      s.particles.push({
        kind: 'shard',
        which: i % 3,
        x: b.x + Math.cos(b.angle) * along,
        y: b.y + Math.sin(b.angle) * along + (Math.random() - 0.5) * spot.h * 0.4,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 220,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 14,
        scale: 0.85 + Math.random() * 0.3,
        t0: t,
        life: 1.0 + Math.random() * 0.4,
      });
    }
    puff(b.x, b.y, 1.2, t);
    puff(b.x + (Math.random() - 0.5) * 20, b.y + 8, 0.9, t);
  }

  /** 一团木屑（scale 是起始大小，之后慢慢胀开、上飘、淡掉） */
  function puff(x, y, scale, t) {
    session.particles.push({
      kind: 'dust',
      x,
      y,
      vx: (Math.random() - 0.5) * 30,
      vy: -24,
      scale,
      rot: (Math.random() - 0.5) * 0.6,
      t0: t,
      life: 0.75,
    });
  }

  /** 宠物停下了：从物理世界里拿出来，先定一下神（顺便等这一垛安静下来） */
  function onSettled(t) {
    const s = session;
    s.world.removePet();
    s.pet.vx = 0;
    s.pet.vy = 0;
    s.game = S.settleShot(s.game);
    s.pet.mode = 'rest';
    s.until = t + REST_SEC;
    playIdle();
  }

  /** 整排倒了：开心地跳一下（在地上 → 跳完回弹弓；在皮兜里 → 原地跳完木箱就重新码好） */
  function startCheer(t, inPouch) {
    const s = session;
    s.game = S.markCleared(s.game);
    s.pet.mode = 'cheer';
    s.pet.facing = 'right';
    s.cheerInPouch = inPouch;
    s.until = t + CHEER_SEC;
    s.respawnPending = true;
    playCheer();
  }

  /** 回弹弓：在停下的地方扬起一小团木屑、淡出，再站在皮兜里淡入——不用跑回去 */
  function startReturn(t) {
    const s = session;
    s.pet.mode = 'vanish';
    s.fade = { t0: t };
    puff(s.pet.center.x, feetOf(s.pet.center) - 6, 0.7, t);
  }

  /** 淡出完：直接站进皮兜，淡入 + 轻轻一顿（落进皮兜的 Q 弹） */
  function appearInPouch(t) {
    const s = session;
    s.pet.center = { ...ANCHOR };
    s.pet.facing = 'right';
    s.pet.tilt = 0;
    s.pet.mode = 'appear';
    s.fade = { t0: t };
    s.squash = { t0: t, depth: 0.9 };
    playIdle();
  }

  /** 一个固定步长：推进物理、处理碰撞、跟踪飞行中的宠物 */
  function physicsStep(t) {
    const s = session;
    const p = s.pet;
    onImpacts(s.world.step(STEP_MS), t);
    if (p.mode !== 'fly') return;
    const ps = s.world.petState();
    if (!ps) return;
    p.center = fromPhysics(ps);
    p.vx = ps.vx;
    p.vy = ps.vy;
    s.flightT += S.GAME_STEP_DT;
    if (Math.abs(p.vx) > 40) p.facing = p.vx >= 0 ? 'right' : 'left';
    s.stillFrames = Math.hypot(p.vx, p.vy) < SETTLE_SPEED ? s.stillFrames + 1 : 0;
    if (s.stillFrames >= SETTLE_FRAMES || s.flightT > S.MAX_FLIGHT_SEC) onSettled(t);
  }

  function update(t, dt) {
    const s = session;
    const p = s.pet;
    clip.tick();
    if (viewChanged && p.mode === 'ready' && !s.grab) {
      startSession(t); // 窗口变了：宠物安安稳稳待在皮兜里时才重开（不打断拉弓 / 飞行 / 回弹弓）
      return;
    }
    // 物理一直在跑：宠物停下之后，被撞松的木箱还会接着倒
    s.stepAcc += dt;
    while (s.stepAcc >= S.GAME_STEP_DT) {
      s.stepAcc -= S.GAME_STEP_DT;
      physicsStep(t);
    }
    if (p.mode === 'pull') {
      const k = 1 - Math.exp(-dt * PULL_FOLLOW);
      s.pulled = { x: lerp(s.pulled.x, s.pullTarget.x, k), y: lerp(s.pulled.y, s.pullTarget.y, k) };
      p.center = { ...s.pulled };
    } else if (p.mode === 'snap') {
      const u = Math.min((t - s.snap.t0) / SNAP_SEC, 1);
      const k = Math.cos(u * Math.PI * 2.5) * (1 - u) * (1 - u);
      p.center = { x: lerp(ANCHOR.x, s.snap.from.x, k), y: lerp(ANCHOR.y, s.snap.from.y, k) };
      if (u >= 1) {
        p.mode = 'ready';
        p.center = { ...ANCHOR };
        s.snap = null;
      }
    } else if (p.mode === 'fly') {
      const airborne = feetOf(p.center) < GROUND - 2;
      if (airborne && t - s.lastTrail > TRAIL_EVERY) {
        s.lastTrail = t;
        s.particles.push({
          kind: 'bubble',
          x: p.center.x - p.vx * 0.03 + (Math.random() - 0.5) * 14,
          y: p.center.y - p.vy * 0.03 + (Math.random() - 0.5) * 14,
          vx: (Math.random() - 0.5) * 16,
          vy: -18,
          size: 3.5 + Math.random() * 3,
          t0: t,
          life: 0.9,
          seed: Math.floor(Math.random() * 3),
        });
      }
    } else if (p.mode === 'rest') {
      if (menu) {
        s.until += dt; // 右键菜单开着时宠物原地等着（与桌宠「菜单悬停期间不漫游」一致）
      } else if (t >= s.until) {
        // 已经整排倒了就在原地欢呼；还在倒的话先回弹弓，倒完了在皮兜里欢呼（见下面 ready 那一支）
        if (blocksCalm() && flattened()) startCheer(t, false);
        else startReturn(t);
      }
    } else if (p.mode === 'cheer') {
      if (menu) s.until += dt;
      else if (t >= s.until) {
        if (s.cheerInPouch) {
          p.mode = 'ready';
          playIdle();
          respawnBlocks(t);
        } else startReturn(t);
      }
    } else if (p.mode === 'vanish') {
      if (t - s.fade.t0 >= VANISH_SEC) appearInPouch(t);
    } else if (p.mode === 'appear') {
      if (t - s.fade.t0 >= APPEAR_SEC) {
        p.mode = 'ready';
        s.fade = null;
        if (s.respawnPending) respawnBlocks(t);
      }
    } else if (p.mode === 'ready' && !s.grab && s.game.phase === 'aiming' && blocksCalm() && flattened()) {
      // 宠物回到皮兜之后这一垛才慢慢倒完：就在皮兜里跳一下
      startCheer(t, true);
    }
    p.box = S.petBoxAt(p.center);

    // 飞行时身体顺着速度轻轻仰 / 俯；其余时候回正
    let tiltTarget = 0;
    if (p.mode === 'fly' && feetOf(p.center) < GROUND - 2) {
      tiltTarget = clamp(Math.atan2(p.vy, Math.abs(p.vx) + 1) * 0.35, -0.42, 0.42) * (p.vx >= 0 ? 1 : -1);
    } else if (p.mode === 'pull') {
      const d = { x: ANCHOR.x - s.pulled.x, y: ANCHOR.y - s.pulled.y };
      tiltTarget = clamp(Math.atan2(-d.y, Math.abs(d.x) + 1) * -0.25, -0.25, 0.25);
    }
    p.tilt += (tiltTarget - p.tilt) * Math.min(1, dt * 10);

    updatePouch(dt);
    updateParticles(t, dt);
    s.leaving = s.leaving.filter((q) => t - q.t0 < BLOCK_OUT_SEC);
  }

  /** 粒子：小泡泡慢慢上浮；木片带旋转地抛出去、落地弹一下再躺平；木屑胀开上飘 */
  function updateParticles(t, dt) {
    const s = session;
    s.particles = s.particles.filter((q) => t - q.t0 < q.life);
    for (const q of s.particles) {
      if (q.kind === 'bubble') {
        const drag = Math.exp(-dt * 2.6);
        q.vx *= drag;
        q.vy = q.vy * drag - 55 * dt;
      } else if (q.kind === 'shard') {
        q.vy += S.GAME_GRAVITY * dt;
        q.rot += q.spin * dt;
        if (q.y >= GROUND - 3 && q.vy > 0) {
          q.y = GROUND - 3;
          q.vy *= -0.3;
          q.vx *= 0.6;
          q.spin *= 0.5;
        }
      } else {
        const drag = Math.exp(-dt * 1.5);
        q.vx *= drag;
        q.vy *= drag;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
  }

  /** 皮兜：拉弓时跟着宠物（从脚下渐渐挪到背后），其余时候是弹簧——松手后冲过头再晃几下，自然回位 */
  function updatePouch(dt) {
    const s = session;
    const p = s.pet;
    const pouch = s.pouch;
    if (p.mode === 'pull' || p.mode === 'snap') {
      const d = { x: p.center.x - ANCHOR.x, y: p.center.y - ANCHOR.y };
      const len = Math.hypot(d.x, d.y);
      const k = smooth(clamp(len / 60, 0, 1));
      const feet = pouchUnderFeet(p.center);
      const back = len > 0.5 ? { x: p.center.x + (d.x / len) * 46, y: p.center.y + (d.y / len) * 46 } : feet;
      const next = { x: lerp(feet.x, back.x, k), y: lerp(feet.y, back.y, k) };
      pouch.vel = { x: (next.x - pouch.pos.x) / Math.max(dt, 1e-3), y: (next.y - pouch.pos.y) / Math.max(dt, 1e-3) };
      pouch.pos = next;
      return;
    }
    const inPouch = p.mode === 'ready' || p.mode === 'appear' || (p.mode === 'cheer' && s.cheerInPouch);
    const target = inPouch ? pouchUnderFeet(p.center) : POUCH_EMPTY;
    // 刚度大：按 ≤1/120s 的子步积分才稳（半隐式欧拉），与帧率无关
    const n = Math.max(1, Math.ceil(dt * 120));
    const h = dt / n;
    let { x, y } = pouch.pos;
    let { x: vx, y: vy } = pouch.vel;
    for (let i = 0; i < n; i++) {
      vx += ((target.x - x) * POUCH_SPRING_K - vx * POUCH_SPRING_C) * h;
      vy += ((target.y - y) * POUCH_SPRING_K - vy * POUCH_SPRING_C) * h;
      x += vx * h;
      y += vy * h;
    }
    pouch.pos = { x, y };
    pouch.vel = { x: vx, y: vy };
  }
  /** 回弹弓时宠物的不透明度：淡出 1 → 0，淡入 0 → 1，其余时候 1 */
  function petAlpha(t) {
    const s = session;
    const p = s.pet;
    if (p.mode === 'vanish') return 1 - smooth(clamp((t - s.fade.t0) / VANISH_SEC, 0, 1));
    if (p.mode === 'appear') return smooth(clamp((t - s.fade.t0) / APPEAR_SEC, 0, 1));
    return 1;
  }

  // ================= 绘制 =================
  function bandThickness(from, to) {
    const rest = Math.hypot(POUCH_EMPTY.x - from.x, POUCH_EMPTY.y - from.y) + 8;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    return clamp(BAND_REST_THICK * Math.sqrt(rest / Math.max(len, 1)), 2.4, BAND_REST_THICK);
  }

  function pouchAngle(pos) {
    const mid = { x: (TIPS.back.x + TIPS.front.x) / 2, y: (TIPS.back.y + TIPS.front.y) / 2 };
    const d = Math.hypot(mid.x - pos.x, mid.y - pos.y);
    if (d < 6) return Math.atan2(TIPS.front.y - TIPS.back.y, TIPS.front.x - TIPS.back.x);
    return Math.atan2(mid.y - pos.y, mid.x - pos.x) + Math.PI / 2;
  }

  /** 宠物：视频帧绕身体中心倾斜、以脚底为支点做 Q 弹挤压 / 发射时的拉长，按朝向镜像（素材默认朝左） */
  function drawPet(t) {
    const s = session;
    const p = s.pet;
    const frame = clip.frame();
    if (!frame) return;
    const box = p.box;
    const c = S.petCenterOf(box);
    const foot = S.petBody(box).bottom;
    let sy = 1;
    if (s.squash) {
      const u = ((t - s.squash.t0) * 1000) / S.SQ_DURATION_MS;
      if (u >= 1) s.squash = null;
      else sy = S.squashScale(u, s.squash.depth);
    }
    if (s.stretch) {
      const u = (t - s.stretch.t0) / LAUNCH_STRETCH_SEC;
      if (u >= 1) s.stretch = null;
      else sy *= 1 + 0.07 * (1 - u);
    }
    const sx = 1 + (1 - sy) * 0.5;
    const flip = p.facing === 'right' ? -1 : 1;
    ctx.save();
    ctx.globalAlpha = petAlpha(t);
    ctx.translate(c.x, c.y);
    ctx.rotate(p.tilt);
    ctx.translate(0, foot - c.y);
    ctx.scale(flip * sx, sy);
    ctx.translate(-c.x, -foot);
    ctx.drawImage(petFrames.apply(frame), box.x, box.y, PET_W, PET_H); // 去掉视频帧整帧的 alpha 噪声（pet-frame-filter.js）
    ctx.restore();
  }

  /** 木箱垛：物理世界里每块的位置 / 角度；裂过的换裂开的那张；刚码好时逐块轻轻落下、淡入 */
  function drawBlocks(t) {
    const s = session;
    for (const q of s.leaving) {
      const u = (t - q.t0) / BLOCK_OUT_SEC;
      A.drawBlock(ctx, q.kind, q.x, q.y, q.w * (1 - 0.08 * u), q.angle, q.cracked, 1 - smooth(u));
    }
    for (const b of s.world.blockStates()) {
      const spot = s.spots[b.id];
      const u = clamp((t - s.blocksIn - BLOCK_IN_DELAY - b.id * BLOCK_IN_GAP) / BLOCK_IN_SEC, 0, 1);
      if (u <= 0) continue;
      const drop = (1 - easeOutBack(u)) * 14;
      A.drawBlock(ctx, spot.kind, b.x, b.y - drop, spot.w, b.angle, blockCracked(b.id), smooth(Math.min(1, u * 1.4)));
    }
  }

  function drawParticles(t, kinds) {
    for (const q of session.particles) {
      if (!kinds.includes(q.kind)) continue;
      const u = (t - q.t0) / q.life;
      if (q.kind === 'bubble') {
        A.drawBubble(ctx, q.x, q.y, q.size, q.seed, u < 0.15 ? u / 0.15 : 1 - smooth((u - 0.15) / 0.85));
      } else if (q.kind === 'shard') {
        A.drawShard(ctx, q.which, q.x, q.y, q.rot, q.scale, u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3);
      } else {
        A.drawDust(ctx, q.x, q.y, q.scale * (1 + 0.9 * smooth(u)), 0.85 * (1 - smooth(u)), q.rot);
      }
    }
  }

  /** 瞄准：一小串小泡泡点出前一小段弧线（与真实飞行同一套物理，提示方向，不把落点算给人看） */
  function drawAim() {
    const s = session;
    if (s.pet.mode !== 'pull') return;
    const v = S.slingVelocity(s.pulled, s.power);
    if (!v) return;
    const pts = s.probe.path(toPhysics(s.pulled), v, 9, 3).map(fromPhysics);
    pts.forEach((q, i) => {
      const k = 1 - i / pts.length;
      A.drawBubble(ctx, q.x, q.y, 2.6 + 2.6 * k, i, 0.3 + 0.6 * k);
    });
  }

  function render(t) {
    const s = session;
    const p = s.pet;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height); // 透明窗口：不画背景
    const k = view.dpr * view.fit;
    ctx.setTransform(k, 0, 0, k, view.dpr * view.offX, view.dpr * view.offY);
    ctx.imageSmoothingQuality = 'high';

    drawBlocks(t);
    drawParticles(t, ['shard', 'dust']);
    drawAim();

    // 宠物的接地影子：离地越高越淡越小（在皮兜里时不画）
    const height = GROUND - feetOf(p.center);
    const inSling =
      p.mode === 'ready' ||
      p.mode === 'pull' ||
      p.mode === 'snap' ||
      p.mode === 'appear' ||
      (p.mode === 'cheer' && s.cheerInPouch);
    if (!inSling) {
      const fade = petAlpha(t);
      A.drawShadow(
        ctx,
        p.center.x,
        GROUND,
        96 * clamp(1 - height / 500, 0.4, 1),
        clamp(1 - height / 380, 0.25, 1) * fade,
      );
    }

    A.drawSling(ctx, BASE);
    const pouch = s.pouch.pos;
    const pouchBehind =
      (p.mode === 'pull' || p.mode === 'snap') && Math.hypot(p.center.x - ANCHOR.x, p.center.y - ANCHOR.y) > 30;
    A.drawBand(ctx, TIPS.back, pouch, bandThickness(TIPS.back, pouch));
    if (pouchBehind) A.drawPouch(ctx, pouch, pouchAngle(pouch));
    drawParticles(t, ['bubble']);
    drawPet(t);
    A.drawBand(ctx, TIPS.front, pouch, bandThickness(TIPS.front, pouch));
    if (!pouchBehind) A.drawPouch(ctx, pouch, pouchAngle(pouch));
  }

  // ================= 循环（页面生命周期内只有这一个） =================
  let lastT = performance.now() / 1000;
  function frame() {
    requestAnimationFrame(frame); // 先排下一帧：本帧哪怕抛异常，循环也不会断（断了窗口可能一直接着鼠标）
    const t = performance.now() / 1000;
    const dt = Math.min(t - lastT, MAX_FRAME_DT);
    lastT = t;
    try {
      update(t, dt);
      render(t);
      setCursor();
      placeSay(t);
    } catch (e) {
      console.error('[dsh-pet slingshot] frame failed:', e);
    } finally {
      reportInput();
    }
  }

  // 字体：与桌宠气泡同一款上首软糖体；FontFace API 只把地址当 url() 参数，不拼样式文本
  if (init.base && typeof FontFace === 'function') {
    const fontUrl = init.base + '/font/' + encodeURIComponent('上首软糖体') + '.ttf';
    new FontFace('ShangshouSoftCandy', 'url(' + JSON.stringify(fontUrl) + ')')
      .load()
      .then((face) => document.fonts.add(face))
      .catch((e) => console.error('[dsh-pet slingshot] 字体加载失败：', e));
  }
  // 右键菜单样式：与桌宠窗口注入同一份 MENU_CSS（同一个组件、同一个样子）
  const menuStyle = document.createElement('style');
  menuStyle.textContent = S.MENU_CSS;
  document.head.appendChild(menuStyle);
  document.title = '弹弓 · ' + init.petName;
  // 冒烟自检 / 排障钩子：sessions / loops 用来验证「重进不残留、不叠循环」
  window.__dshPetGame = {
    get state() {
      return session && session.game;
    },
    get petMode() {
      return session && session.pet.mode;
    },
    get pet() {
      return session && { ...session.pet.center };
    },
    get pouch() {
      return session && { ...session.pouch.pos };
    },
    get blocks() {
      return session ? session.world.blockStates() : [];
    },
    get particles() {
      return session ? session.particles.length + session.leaving.length : 0;
    },
    get sessions() {
      return sessionCount;
    },
    get view() {
      return { ...view };
    },
    get spots() {
      return session ? session.spots : [];
    },
    get loops() {
      return loops;
    },
    get ready() {
      return ready;
    },
  };

  resize();
  A.loadAll()
    .catch((e) => console.error('[dsh-pet slingshot]', e))
    .then(() => {
      const t = performance.now() / 1000;
      clip.preload([...(init.idle || []).slice(0, 3), ...(init.drag || []).slice(0, 2), init.cheer]);
      startSession(t);
      maybeSay(t);
      ready = true;
      loops += 1;
      lastT = t;
      requestAnimationFrame(frame);
    });
})();
