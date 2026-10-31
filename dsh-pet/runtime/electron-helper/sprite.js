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
    // 左右透明边余量（视频盒内宠物身体居中）：让边界按身体贴边——宠物能走到屏幕边缘，但身体永不越界。
    this.sideAllow = (S.HIT_BOX.x0 / 640) * this.size;
    window.__dshPetDebug.sideAllow = this.sideAllow;
    // 窗口四周外扩：左右下 = WINDOW_MARGIN_RATIO×宠物尺寸；上边距按气泡与待办面板的最大高度算——
    // 两者都锚字号、窗口余量锚宠物，宠物变小或字号固定时半只宠物的余量装不下，顶端会被窗口上沿切掉。
    // 余量透明且点击穿透，加高没有副作用；但它自此不再四边相等，所以命中区要由主进程按上报值算。
    const m = this.size * WINDOW_MARGIN_RATIO;
    const fontConf = pet.font || config.font || S.DEFAULT_FONT;
    this.margin = {
      t: Math.max(m, S.bubbleTopMarginPx(fontConf, this.size), S.todoPanelTopMarginPx(fontConf, this.size)),
      r: m,
      b: m,
      l: m,
    };
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
    this.inputRegionMutation.disconnect();
    this.inputRegionResize.disconnect();
    this.inputRegionElements.clear();
    if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
    if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    if (this.chatMount) {
      this.chatMount.close();
      this.chatMount = null;
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
    this.pos = { x: Math.round(px), y: Math.round(py) };
    window.__dshPetDebug.dragPos = { x: this.pos.x, y: this.pos.y };
    if (window.petBridge) {
      // 完整状态一次捎带：size/bottomPad 让静止宠物从首帧起就登记进碰撞站场；
      // vx/vy 带当前速度（飞行中实时值、静止/拖拽 = 0），避免落地后残留旧速度干扰碰撞动量。
      const fly = this.throwState;
      window.petBridge.setBounds(
        toScreen(this.pos.x - this.margin.l + VIEW.x),
        toScreen(this.pos.y - this.margin.t + VIEW.y),
        toScreen(this.size + this.margin.l + this.margin.r),
        toScreen(this.winH + this.margin.t + this.margin.b),
        toScreen(this.pos.x), // 包围盒左上角（碰撞站场用：窗口坐标 ≠ 包围盒坐标）
        toScreen(this.pos.y),
        toScreen(this.size),
        toScreen(this.bottomPad),
        fly ? toScreen(fly.vx) : 0,
        fly ? toScreen(fly.vy) : 0,
        // 窗口余量（DIP）：主进程据此算宠物身体命中区——余量不再四边相等（上边距按气泡加高），
        // 不能再按「窗口宽/4」反推（见 pointer-target.js 的 spriteHitRect）。
        toScreen(this.margin.l),
        toScreen(this.margin.t),
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
    const winX = this.pos.x + VIEW.x - this.margin.l;
    const winY = this.pos.y + VIEW.y - this.margin.t;
    const winW = this.size + this.margin.l + this.margin.r;
    const winH = this.winH + this.margin.t + this.margin.b;
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
