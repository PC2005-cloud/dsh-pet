/**
 * dsh-pet 桌面 Helper 的宠物本体（PetSprite 类）：播放、拖拽抛掷、跨窗碰撞、点击穿透、
 * 右键菜单、聊天弹窗与气泡渲染。
 * 事件联动（余额/碎碎念/广播/工作状态）不在此文件，见 events.js；纯逻辑与常量来自 shared-core.js。
 * 依赖 constants.js 的全局，须后加载。始终成立：所有位移都经 sendBounds 落到窗口，跨进程交换一律
 * 在 toScreen/toLocal 收口。
 * @module dsh-pet/runtime/electron-helper/sprite
 */
'use strict';

// 左键 + 修饰键 = 「呼出 DSH」的快捷键。Windows / Linux 用 Ctrl；macOS 上 Ctrl+左键是系统右键
// （先触发 contextmenu、拿不到 click），所以改用 Cmd。快捷键文案按平台取，判定统一走 isOpenShortcut。
const OPEN_SHORTCUT_HINT = /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Cmd+左键' : 'Ctrl+左键';
/** 本次点击是否按住了「呼出 DSH」的修饰键（Ctrl / Cmd） */
const isOpenShortcut = (e) => !!(e && (e.ctrlKey || e.metaKey));

/** 空闲时窗口四周余量（CSS px）：窗口≈主体盒，宠物才能贴到屏幕边（见 desiredMargin） */
const IDLE_MARGIN_PX = 4;
/** 菜单/对话窗打开时窗口四周至少留出的余量（CSS px）：够两层菜单面板并排 */
const MENU_ROOM_PX = 260;

// 点击音效：与浏览器端同一套参数（单例 audio、音量 0.5、100ms 节流、失败静默）。
// 复用素材通道：bridge 模式由主进程取回音频，普通模式仍走 HTTP。
const CLICK_SOUND_URL = BASE + '/sound/click-duck.wav';
const CLICK_SOUND_VOLUME = 0.5;
const CLICK_SOUND_THROTTLE_MS = 100;
let clickAudio = null;
let lastClickSoundAt = 0;
const playClickSound = () => {
  // 开关来自成品配置 main.clickSoundEnabled（renderer.js 的 loadConfig 带入）；缺失一律静音
  if (!config || config.clickSoundEnabled !== true) return;
  const now = Date.now();
  if (now - lastClickSoundAt < CLICK_SOUND_THROTTLE_MS) return;
  lastClickSoundAt = now;
  try {
    clickAudio = clickAudio || new Audio(CLICK_SOUND_URL);
    clickAudio.volume = CLICK_SOUND_VOLUME;
    clickAudio.currentTime = 0;
    const p = clickAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 音频不可用：静默忽略 */
  }
};

// 单只宠物：行为与浏览器 PetCard 一致，纯逻辑来自 src/shared
class PetSprite {
  constructor(pet) {
    this.pet = pet; // 这只宠物的配置段（拍平后的成品实例，条目级字段已吹入）
    // 页面级缩放（主进程对窗口 setZoomFactor）统一放大整窗：pet.size 即 CSS 像素基准，
    // 不再手工乘 CONFIG.scale；跨进程交换由 constants.js 的 toScreen/toLocal 收口。
    this.size = pet.size;
    this.height = (this.size * 9) / 16;
    this.halfW = this.size / 2;
    this.halfH = this.height / 2;
    this.bottomPad = (this.size * (9 / 16) * (S.CANVAS_H - S.FEET_Y)) / S.CANVAS_H;
    // 窗口高 = 舞台高 + 脚底垫高（stage 被 translateY(bottomPad) 下移的余量，防底部被窗口裁剪）
    this.winH = this.height + this.bottomPad;
    // 可交互区域 = 身体命中区（像素，窗口坐标）。浏览器只有 .dsh-pet-hit 可交互，桌面严格对齐：
    // 命中区外（含透明像素）一律穿透到下层应用。HIT_BOX 是 640×360 舞台坐标：x 按窗口宽缩放，
    // y 除舞台高外还要加 bottomPad（舞台被下移）。
    this.hitRect = {
      x: (S.HIT_BOX.x0 / 640) * this.size,
      y: this.bottomPad + (S.HIT_BOX.y0 / 360) * this.height,
      w: ((S.HIT_BOX.x1 - S.HIT_BOX.x0) / 640) * this.size,
      h: ((S.HIT_BOX.y1 - S.HIT_BOX.y0) / 360) * this.height,
    };
    window.__dshPetDebug.hitRect = this.hitRect;
    // 宠物**主体盒**（窗口坐标系）—— 就是上面 hitRect 那块（HIT_BOX 像素化，略大于角色本身）。
    // 实测角色只占画布的 x 218..425 / y 62..328（左右各约 1/3 是纯透明留白），所以桌面端把窗口
    // 按主体盒来算：画布以**负余量**溢出窗口、被裁掉的只是透明留白，换来的是角色能贴到屏幕边。
    this.body = { x: this.hitRect.x, y: this.hitRect.y, w: this.hitRect.w, h: this.hitRect.h };
    // 左右透明边余量（视频盒内宠物身体居中）：让边界按身体贴边——宠物能走到屏幕边缘，但身体永不越界。
    this.sideAllow = (S.HIT_BOX.x0 / 640) * this.size;
    window.__dshPetDebug.sideAllow = this.sideAllow;
    // 窗口余量**按当前状态算**（见 desiredMargin）：空闲贴着主体盒，有气泡/菜单时才外扩。
    // fontConf 仍在这里取好：下面 this.font 要用同一份字号（上边距与气泡字号必须同源）。
    const fontConf = pet.font || config.font || S.DEFAULT_FONT;
    this.margin = this.desiredMargin();
    window.__dshPetDebug.winMargin = this.margin;
    // 宠物包围盒左上角在【工作区】坐标系里的位置（本窗口的位置 = 宠物的位置）
    this.pos = { x: 0, y: 0 };

    // 配置派生字段：拍平的实例优先，其次全局，最后内置默认。
    // 拖拽抛掷物理参数
    this.physics = pet.physics || config.physics || S.DEFAULT_PHYSICS;
    // 字体：字号按本宠物尺寸算；字体族由 renderer.js 注入 documentElement（fontConf 见上，上边距用的是同一份）
    this.font = fontConf;
    // 抛掷锁定在当前屏幕：true = 只在松手时所在那块屏内弹（屏缝当墙），false = 照常跨屏飞行
    this.confineToScreen = pet.confineToScreen === true || config.confineToScreen === true;
    // 素材根按 assetRoot（文件宠物 = 配置文件前缀，多实例共享同一素材目录）或宠物 id 回落
    this.assetRoot = pet.assetRoot || pet.id;
    this.assetBase = BASE + '/thumb/' + encodeURIComponent(this.assetRoot) + '/';

    this.initPlayback(pet);
    this.initMotion();
    this.initPanels();
    this.buildDom();
    this.bindEvents();
  }

  dispose() {
    this.ac.abort();
    if (this.shapeTimer !== null) window.clearInterval(this.shapeTimer);
    this.inputRegionMutation.disconnect();
    this.inputRegionResize.disconnect();
    this.inputRegionElements.clear();
    if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
    if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    if (this.chatClose) {
      this.chatClose();
      this.chatClose = null;
    }
    this.closeMenu();
    this.stopThrow();
    this.stopDragFollow();
    this.stopSquash();
    this.stopMove();
    this.el.remove();
  }

  get facing() {
    return this._facing;
  }

  set facing(next) {
    const value = next === 'right' ? 'right' : 'left';
    if (this._facing === value) return;
    this._facing = value;
    this.markPoseDirty();
  }

  /** 实况变了 → 交给节流器（连续变化被合并成一次冲刷） */
  markPoseDirty() {
    if (this.poseTimer !== null) return;
    this.poseTimer = window.setTimeout(() => {
      this.poseTimer = null;
      this.reportPose();
    }, POSE_THROTTLE_MS);
  }

  /**
   * 窗口在「视口坐标」里的矩形：原点 = pos + 主体盒偏移 − 余量，尺寸 = 主体盒 + 余量。
   * @returns {{x:number,y:number,w:number,h:number}} 窗口矩形（CSS 像素，视口坐标）
   */
  winRect() {
    return {
      x: this.pos.x + this.body.x - this.margin.l,
      y: this.pos.y + this.body.y - this.margin.t,
      w: this.body.w + this.margin.l + this.margin.r,
      h: this.body.h + this.margin.t + this.margin.b,
    };
  }

  /**
   * 把理想余量**夹到宠物周围真正可用的空间**里。
   *
   * 窗口矩形会被 WM 钳制在工作区内（实测请求 x=-300 得 x=0）。余量一变大，窗口原点就要往左/上挪；
   * 贴着屏幕边时窗口挪不动、被钳回来，而画布在窗口内的偏移已经按新余量改了 —— 于是**宠物被永久
   * 推离原位**（右键菜单一开就"跳走"）。先夹到「窗口仍完整落在工作区内」的范围，WM 就永远不用钳。
   * @param mg 理想余量。
   * @returns 夹取后的余量。
   */
  clampMarginToSpace(mg) {
    const pad = IDLE_MARGIN_PX;
    const b = this.body;
    const bodyX0 = this.pos.x + b.x;
    const bodyY0 = this.pos.y + b.y;
    const bodyX1 = bodyX0 + b.w;
    const bodyY1 = bodyY0 + b.h;
    return {
      l: Math.max(pad, Math.min(mg.l, Math.floor(bodyX0))),
      t: Math.max(pad, Math.min(mg.t, Math.floor(bodyY0))),
      r: Math.max(pad, Math.min(mg.r, Math.floor(VIEW.w - bodyX1))),
      b: Math.max(pad, Math.min(mg.b, Math.floor(VIEW.h - bodyY1))),
    };
  }

  /**
   * 当前该用多大窗口余量。
   *
   * 空闲贴着主体盒（宠物才能贴到屏幕边），有覆盖层时才外扩：菜单/对话窗四边都要地方，
   * 气泡只按**相对主体盒的真实溢出量**补。所有分支都过 clampMarginToSpace。
   * @returns {{l:number,t:number,r:number,b:number}} 余量（CSS 像素）
   */
  desiredMargin() {
    const pad = IDLE_MARGIN_PX;
    const m = this.size * WINDOW_MARGIN_RATIO;
    const fontConf = this.pet.font || config.font || S.DEFAULT_FONT;
    if (this.needsRoom()) {
      const room = Math.max(m, MENU_ROOM_PX);
      return this.clampMarginToSpace({
        t: Math.max(room, S.bubbleTopMarginPx(fontConf, this.size)),
        r: room,
        b: room,
        l: room,
      });
    }
    if (this.bubble && this.bubble.classList.contains('is-on') && this.el) {
      const er = this.el.getBoundingClientRect();
      const br = this.bubble.getBoundingClientRect();
      if (er.width > 0 && br.width > 0) {
        const bx0 = br.left - er.left;
        const by0 = br.top - er.top;
        const bx1 = bx0 + br.width;
        const by1 = by0 + br.height;
        const bodyX1 = this.body.x + this.body.w;
        const bodyY1 = this.body.y + this.body.h;
        return this.clampMarginToSpace({
          l: Math.max(pad, Math.ceil(this.body.x - bx0) + pad),
          t: Math.max(pad, Math.ceil(this.body.y - by0) + pad),
          r: Math.max(pad, Math.ceil(bx1 - bodyX1) + pad),
          b: Math.max(pad, Math.ceil(by1 - bodyY1) + pad),
        });
      }
    }
    return { l: pad, t: pad, r: pad, b: pad };
  }

  /** 是否正有"长在余量里"的覆盖层需要空间（右键菜单 / 对话窗）。 */
  needsRoom() {
    return !!(this.menuOpen || this.chatOpen);
  }

  /** 菜单刚开（宽限期内）：此时 blur / mouseleave 多半是本进程改窗口尺寸/形状引起的，不该据此关菜单。 */
  menuJustOpened() {
    return typeof this.menuOpenedAt === 'number' && performance.now() - this.menuOpenedAt < 500;
  }

  /**
   * 余量变了：改 DOM 里 sprite 的位置，并把新窗口矩形上报一次（宽高/原点都由余量算出）。
   * 宠物在屏幕上的位置天然不动（pos 不变，只有窗口原点与画布偏移一起变）。
   */
  syncMargin() {
    if (!this.el) return;
    const next = this.desiredMargin();
    const cur = this.margin;
    if (cur && next.l === cur.l && next.t === cur.t && next.r === cur.r && next.b === cur.b) return;
    this.margin = next;
    window.__dshPetDebug.winMargin = next;
    this.el.style.left = next.l - this.body.x + 'px';
    this.el.style.top = next.t - this.body.y + 'px';
    this._shapeKey = null; // 余量变了：形状要按新坐标重算
    this._marginBusy = true; // 防止 sendBounds → syncMargin → sendBounds 递归
    try {
      this.sendBounds(this.pos.x, this.pos.y);
    } finally {
      this._marginBusy = false;
    }
    this.syncShape();
  }

  /**
   * 上报窗口形状（Linux `shape` 输入模型，见 main/windows.js 的 INPUT_MODE）。
   *
   * 形状 = 宠物主体盒 ∪ 所有覆盖层（气泡 / 悬浮提示 / 级联菜单 / 对话窗 / 积分弹窗）；
   * 拖拽中直接给整窗——拖拽时用户就是在操作这个窗口，别让形状把输入切掉。
   * 坐标口径与其余跨进程交换一致：CSS × CONFIG.scale = 窗口物理像素（主进程侧 DIP 与之相等）。
   */
  syncShape() {
    if (!window.petBridge || !window.petBridge.setShape) return;
    const rects = [];
    const push = (el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        rects.push({ x: toScreen(r.x), y: toScreen(r.y), width: toScreen(r.width), height: toScreen(r.height) });
      }
    };
    if (this.dragState.active) {
      // 拖拽中：形状直接给整窗——宠物由弹簧追着光标跑、会滞后，光标可能短暂落在主体盒之外，
      // 形状不能跟着缩（否则正在进行的拖拽有被切掉的风险）
      rects.push({ x: 0, y: 0, width: toScreen(window.innerWidth), height: toScreen(window.innerHeight) });
    } else {
      // 宠物本体直接用主体盒（窗口坐标）：stage 现在会以负偏移溢出窗口，读它的 DOM 矩形没意义
      rects.push({
        x: toScreen(this.margin.l),
        y: toScreen(this.margin.t),
        width: toScreen(this.body.w),
        height: toScreen(this.body.h),
      });
      if (this.bubble && this.bubble.classList.contains('is-on')) push(this.bubble);
      if (this.tip && this.tip.classList.contains('is-on')) push(this.tip);
      for (const el of document.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat, .dsh-pet-score')) push(el);
    }
    const key = rects
      .map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])
      .join('|');
    if (key === this._shapeKey) return;
    this._shapeKey = key;
    window.__dshPetDebug.shapeRects = rects;
    window.petBridge.setShape({ rects });
  }

  /**
   * 把当前实况推给宿主（`POST /pose/report`）。读的是当前值，所以节流窗口内的连续变化只留最后一帧。
   *
   * 坐标与 POST /position 同一口径：宠物中心的归一化 0~1，基准是所有屏并集的外接矩形（VIEW）；
   * 不这样读回来的值就喂不回 /position。
   */
  reportPose() {
    if (!this.pos) return; // 还没摆过位（position() 首次调用前）：不报，免得推 0,0
    const body = {
      x: (this.pos.x + this.halfW) / VIEW.w,
      y: (this.pos.y + this.halfH) / VIEW.h,
      facing: this._facing,
    };
    void S.postAction(POSE_REPORT_URL + '?pet=' + encodeURIComponent(this.pet.id), body).then((ok) => {
      if (!ok) console.warn('[dsh-pet] 实况上报未送达 pet=' + this.pet.id);
    });
  }

  sendBounds(px, py) {
    // 摆位前先让余量跟上当前状态（气泡/菜单一出现就要外扩，否则会被窗口裁掉；都消失后收回贴边，
    // 宠物才能贴着屏幕边站）。syncMargin 内部会回调 sendBounds，用标志位刹车。
    if (!this._marginBusy) this.syncMargin();
    this.pos = { x: Math.round(px), y: Math.round(py) };
    window.__dshPetDebug.dragPos = { x: this.pos.x, y: this.pos.y };
    if (window.petBridge) {
      // 完整状态一次捎带：size/bottomPad 让静止宠物从首帧起就登记进碰撞站场；
      // vx/vy 带当前速度（飞行中实时值、静止/拖拽 = 0），避免落地后残留旧速度干扰碰撞动量。
      const fly = this.throwState;
      const win = this.winRect();
      window.petBridge.setBounds(
        toScreen(win.x + VIEW.x),
        toScreen(win.y + VIEW.y),
        toScreen(win.w),
        toScreen(win.h),
        toScreen(this.pos.x + this.body.x), // 包围盒左上角（碰撞站场用：这里给**主体盒**）
        toScreen(this.pos.y + this.body.y),
        toScreen(this.body.w),
        0,
        fly ? toScreen(fly.vx) : 0,
        fly ? toScreen(fly.vy) : 0,
        // 上报给主进程的余量仍是**画布相对**（pointer-target 按整张画布折命中区，与旧口径一致）
        toScreen(this.margin.l - this.body.x),
        toScreen(this.margin.t - this.body.y),
      );
    }
    // 位置变了：提示跟的是光标，而光标存视口坐标，窗口一移就必须重摆，否则提示会跟着窗口漂走。
    // 只在显示时重摆（漫游逐帧调本函数，没显示提示时不做无谓的 DOM 写入）。
    if (this.tipOn) this.renderTip();
    // 实况标脏（节流上报，见 markPoseDirty）：所有位移都收口在本函数，所以这里一处就够
    this.markPoseDirty();
  }

  // 角落/边距 → 窗口位置；拖拽后按会话内位置（比例）还原——松手不做任何边界夹取，宠物停在哪就算哪
  // （与浏览器一致：可以完全拖出工作区；漫游仍由 planMove 的边界检查兜底）。
  position() {
    const W = VIEW.w;
    const H = VIEW.h;
    let x;
    let y;
    if (this.customPos) {
      x = this.customPos.rx * W - this.halfW;
      y = this.customPos.ry * H - this.halfH;
    } else {
      // 角落取主屏而不是外接矩形：不规则多屏布局下外接矩形的角落可能不属于任何显示器，
      // 配了该角落的宠物会开机即隐身。
      const anchor = S.anchorPixel({
        corner: this.pet.position.corner,
        // marginX/marginY 是配置里的绝对像素：页面级缩放已统一放大整窗，配置值不再乘 scale
        marginX: this.pet.position.marginX,
        // macOS 顶部边距对齐身体命中盒，扣掉动画画布头顶留白。
        marginY:
          this.pet.position.marginY -
          (this.pet.position.corner.startsWith('top-') ? this.size * CONFIG.topInsetRatio : 0),
        size: this.size,
        W,
        H,
        area: PRIMARY_AREA || undefined,
      });
      x = anchor.x;
      y = anchor.y;
    }
    this.sendBounds(x, y);
  }

  /** 抛掷空间（逐屏 AABB）。AREAS/PANELS 变化时由 relayout() 置空重建——飞行中每帧重算太浪费 */
  throwSpaceOf() {
    if (!this.space || this.space.areas !== AREAS || this.space.panels !== PANELS) {
      this.space = S.throwSpace({ areas: AREAS, panels: PANELS, size: this.size, sideAllow: this.sideAllow });
      for (const b of this.space.bounds) b.minY -= this.size * CONFIG.topInsetRatio;
    }
    return this.space;
  }

  /**
   * 显示器几何变化后就地重挂：抛掷空间作废，并把宠物从可能变成空洞的位置拉回可见区。
   * 拖拽中不动它（用户正握着），飞行中也不动（下一帧物理会按新边界夹取）。
   *
   * 宠物位置是视口相对坐标，而视口原点会随显示器拓扑平移；prevView 是变化前的视口，
   * 这里用 S.rebaseCenter 做「世界坐标守恒 + 越界才夹」，比例无条件跟着新视口重写，
   * 否则每合盖一次就漂一次。
   */
  relayout(prevView) {
    this.space = null;
    this._shapeKey = null; // 视口/几何变了：下次 syncShape 必须重发
    if (this.dragState.active || this.throwRef !== null) return;
    this.stopMove();
    if (!this.pos) {
      // 还没摆过位（position() 首次调用前）：没有旧位置可守恒，直接按新几何定位
      this.position();
      return;
    }
    const from = prevView || VIEW;
    const centerOld = { x: this.pos.x + this.halfW, y: this.pos.y + this.halfH };
    const center = S.rebaseCenter(centerOld, from, VIEW, AREAS);
    // 平移后（世界坐标守恒）本应落在的位置；与夹取结果不同 = 那块屏真的没了
    const moved = { x: centerOld.x + from.x - VIEW.x, y: centerOld.y + from.y - VIEW.y };
    const clamped = center.x !== moved.x || center.y !== moved.y;
    // customPos 非空 = 用户摆过的位置，语义是相对视口的比例：视口变了必须重写，否则同一个比例
    // 在新视口里是另一个世界坐标。为空 = 角落模式：没越界就保持「跟主屏角落」，越界才转锁定坐标。
    if (this.customPos || clamped) {
      this.customPos = { rx: center.x / VIEW.w, ry: center.y / VIEW.h };
    }
    this.position();
  }

  currentCenterX() {
    if (this.customPos) return this.customPos.rx * VIEW.w;
    return this.pos.x + this.halfW;
  }
  currentCenterY() {
    if (this.customPos) return this.customPos.ry * VIEW.h;
    return this.pos.y + this.halfH;
  }

  /**
   * 播放回执上报：把这一段点播的真实状态告诉宿主。
   *
   * 只对第三方点播（带 playbackId）上报，自播动画不报——宿主只知道「受理了」，动画在这里播，
   * 只有这里知道播没播完。postAction 从不抛异常，这里加一层 then 只为留排障日志。
   */
  reportPlayback(playbackId, status, reason) {
    if (!playbackId) return;
    const body = reason ? { status, reason } : { status };
    void S.postAction(BASE + '/playback/' + encodeURIComponent(playbackId) + '/report', body).then((ok) => {
      if (!ok) console.warn('[dsh-pet] 播放回执未送达 pet=' + this.pet.id + ' id=' + playbackId + ' status=' + status);
    });
  }

  // 可见夹取矩形：以宠物所在那块屏为界，返回窗口局部坐标；可见区太小则返回 null
  visibleClampRect() {
    // 比较双方都用屏幕坐标，返回的夹取矩形是窗口局部坐标。夹取用宠物所在的那块屏而不是外接矩形：
    // 后者含空洞，按它夹菜单会伸进不属于任何显示器的区域。
    const area = S.resolveRect(WORK_AREAS, this.pos.x + this.halfW, this.pos.y + this.halfH);
    if (!area) return null;
    const wr = this.winRect();
    const winX = wr.x + VIEW.x;
    const winY = wr.y + VIEW.y;
    const winW = wr.w;
    const winH = wr.h;
    const ax = area.x + VIEW.x;
    const ay = area.y + VIEW.y;
    const vx0 = Math.max(ax, winX);
    const vy0 = Math.max(ay, winY);
    const vx1 = Math.min(ax + area.width, winX + winW);
    const vy1 = Math.min(ay + area.height, winY + winH);
    const w = vx1 - vx0;
    const h = vy1 - vy0;
    if (w < 40 || h < 40) return null;
    return { x: vx0 - winX, y: vy0 - winY, w, h };
  }
}
