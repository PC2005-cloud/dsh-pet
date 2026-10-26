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
/** 空闲时窗口四周余量（CSS px）：窗口≈宠物盒，宠物才能贴到屏幕边（见 desiredMargin） */
const IDLE_MARGIN_PX = 4;
/** 菜单/对话窗打开时窗口四周至少留出的余量（CSS px）：够两层菜单面板并排 */
const MENU_ROOM_PX = 260;

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

    // 播放状态（与浏览器同构）
    // 动画池与权重按宠物取：文件宠物自带完整独立动画池；常规宠物（无 anims 段）用全局配置。
    this.animations = pet.animations || cfg.animations;
    this.weights = pet.animationWeights || cfg.animationWeights;
    // 第三方菜单项（/state 的 sections.menu 快照）：只在右键那一刻拼进菜单，不参与渲染。
    this.menuItems = [];
    // 拖拽抛掷物理参数（顶层全局；拍平已吹入实例，兜底回全局/默认）
    this.physics = pet.physics || config.physics || S.DEFAULT_PHYSICS;
    // 字体（全局一份，拍平已吹入实例）：字号按本宠物尺寸算；字体族由 renderer.js 注入 documentElement。
    // fontConf 已在算窗口上边距时取好（上边距要用同一份字号）。
    this.font = fontConf;
    // 抛掷锁定在当前屏幕：true = 只在松手时所在那块屏内弹（屏缝当墙），false = 照常跨屏飞行
    this.confineToScreen = pet.confineToScreen === true || config.confineToScreen === true;
    // 素材根按 assetRoot（文件宠物 = 配置文件前缀，多实例共享同一素材目录）或宠物 id 回落
    this.assetRoot = pet.assetRoot || pet.id;
    this.assetBase = BASE + '/thumb/' + encodeURIComponent(this.assetRoot) + '/';
    this.front = 0; // 0 = A, 1 = B
    this.pending = null;
    this.gen = 0;
    this.anim = this.animations.idle[0] ?? '';
    this.once = true;
    // 播放回执：当前正在播的第三方点播编号（null = 自播动画，不上报）。单独一个字段是因为
    // 动画名分不出「这一段该不该上报」——菜单点播与第三方 /anim 可以播同名动画。
    this.playback = null;
    // 朝向走 accessor：赋值即标记实况脏。构造函数里直接写 `_facing`，避免其它字段就绪前触发上报。
    this._facing = 'left';
    this.poseTimer = null; // 实况上报的节流定时器（见 markPoseDirty）
    // 交互/移动
    this.dragState = { active: false, dragging: false, sx: 0, sy: 0, petX: 0, petY: 0 };
    this.justDragged = false;
    // 上一次按下的时刻（0 = 还没记过）：弹弓的判定依据是两次按下之间隔了多久，与松手时间无关。
    this.lastPressAt = 0;
    this._interactive = null; // 已上报的可交互状态（setInteractive 去重用）
    this._inputBusy = null; // 已上报的"正在用输入"状态（syncInputBusy 去重用）
    // 拖拽抛掷物理（纯计算在 shared）：弹簧跟随包围盒左上角，松手按指针轨迹估速 → 抛掷
    this.dragTrail = []; // 指针轨迹采样（screenX/Y + performance.now()，初速估算用）
    this.dragTarget = null;
    this.dragVel = { vx: 0, vy: 0 };
    this.dragFollow = null; // 弹簧跟随 rAF handle
    this.dragFollowToken = 0;
    this.throwRef = null; // 抛掷 rAF handle
    this.throwToken = 0;
    // 位置指令的跟随 rAF（spring 与 line 共用）：与拖拽跟手分开——这条有终点，收敛或到点必须自己收掉。
    this.posFollow = null;
    this.posFollowToken = 0;
    this.space = null; // 抛掷空间（逐屏 AABB）缓存；显示器变化时由 relayout() 置空重建
    // Q 弹挤压（点击回应 / 抛掷落地）：rAF + 待压标记（等新动画成为前台再压，压新首帧）
    this.squashRef = null;
    this.squashToken = 0;
    this.pendingSquash = false;
    this._interactive = null; // 当前可交互状态（null=未定；只在变化时发 IPC，避免逐帧刷屏）
    // 窗口形状（Linux `shape` 输入模型）的镜像与安全网：覆盖层的显隐路径很多（气泡/提示/菜单/
    // 对话/积分），逐个挂回调容易漏，1.5s 兜底一次（主进程按矩形去重，重复值不产生系统调用）。
    this._shapeKey = null;
    this._marginBusy = false;
    this.shapeTimer = window.setInterval(() => {
      this.syncMargin();
      this.syncShape();
    }, 1500);
    this.moveRef = null;
    this.moveToken = 0;
    this.pendingMove = null;
    this.customPos = null; // 拖拽后的会话内位置（{rx, ry} 比例）；restart 回角落
    // 右键菜单（统一自绘组件，两端共用同一份：树+渲染均来自 shared-core）
    this.menuOpen = false; // 菜单开启期间强制整窗可交互（悬停菜单不触发穿透翻转）
    this.menuClose = null; // 当前菜单的 close()（打开时挂载，关闭后置空）
    // 余额气泡
    this.bubbleOn = false;
    this.bubbleTimer = null;
    // 悬浮提示（替代原生 title）：显隐 + 最近一次光标位置（视口坐标，见 renderTip）
    this.tipOn = false;
    this.tipCursor = null;
    this.balanceView = null;
    this.balanceWrap = false; // true = 当前余额气泡是不可用的「文字说明」（多行，需换行变体）
    this.balanceState = null; // 最近一次余额读数（展开态要用它算三窗口行；balanceView 只是收起态的行）
    this.balanceViewIndex = 0; // 当前页：点一下气泡切下一页（内置 windows 是 收起/展开 两页；custom 是 views.length 页）
    this.balanceFadeTimer = null; // 展开/收起的淡出等待（250ms 后才换内容，避免硬切）
    this.prevTick = 0;
    // 说话（碎碎念/命令气泡/对话回复）：文本与配图由容器统一轮询 /state 后经 showWhisper 送进来。
    this.whisperOn = false;
    this.whisperTimer = null;
    this.whisperView = null;
    this.whisperText = '';
    // 配图名称（配置 memes 的键；whisperImageEnabled 开启时由 host 随机抽定，随文本一起来）
    this.whisperImage = '';
    // 配图地址（与 whisperImage 二选一）：两种形态由字段名区分，不靠嗅探。
    this.whisperUrl = '';
    // 工作状态联动：容器每秒轮询递增 workTick → 本宠物按档位播动画与气泡，未启用时完全免疫。
    // 气泡单槽优先级：终态任务 > whisper > balance > 非终态任务（见 renderBubble）。
    this.workOn = false;
    this.workTimer = null;
    this.workText = null;
    this.workState = null; // 最近一次工作状态（互动/事件动画播完恢复档位循环用）
    this.prevWorkState = null; // 上一档状态（气泡只在状态变化时点亮/收起）
    this.prevWorkTick = 0;
    // 占用锁：frozen = 此刻正被第三方占用；lockTimer 按叶子里的 expiresAt 自己到点解除
    // （宿主侧过期是懒判的，不会推「锁没了」）。
    this.frozen = false;
    this.lockTimer = null;
    // 对话弹窗：当前挂载的 close() 句柄 + 开启标记。chatOpen 是穿透守卫——弹窗是窗口内 DOM，
    // 期间整窗保持可交互，否则光标移到输入框就会被 onMouseMove 翻回穿透、点击全被透传。
    this.chatClose = null;
    this.chatOpen = false;

    // DOM：sprite 钉在窗口内 (margin.l, margin.t)；宠物"位置"= sprite 位置，窗口随余量外扩
    this.el = document.createElement('div');
    this.el.className = 'pet-sprite';
    // 画布原点 = 余量 − 主体盒偏移（余量相对主体盒，可能是负的外扩）
    this.el.style.left = this.margin.l - this.body.x + 'px';
    this.el.style.top = this.margin.t - this.body.y + 'px';
    this.el.style.setProperty('--pet-size', this.size + 'px');
    // 字号（配置 font）：按本宠物尺寸算好最终 px 注入，气泡与提示的 CSS 读这两个变量
    const fontPx = S.resolveFontPx(this.font, this.size);
    this.el.style.setProperty('--dsh-pet-font-bubble', fontPx.bubble + 'px');
    this.el.style.setProperty('--dsh-pet-font-tip', fontPx.tip + 'px');
    const stage = document.createElement('div');
    stage.className = 'pet-stage';
    stage.style.transform = 'translateY(' + this.bottomPad + 'px)';
    this.stage = stage;
    this.videoA = document.createElement('video');
    this.videoA.className = 'pet-video is-front';
    this.videoB = document.createElement('video');
    this.videoB.className = 'pet-video';
    for (const v of [this.videoA, this.videoB]) {
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
    }
    this.hit = document.createElement('div');
    this.hit.className = 'pet-hit';
    this.hit.style.left = (S.HIT_BOX.x0 / 640) * 100 + '%';
    this.hit.style.top = (S.HIT_BOX.y0 / 360) * 100 + '%';
    this.hit.style.width = ((S.HIT_BOX.x1 - S.HIT_BOX.x0) / 640) * 100 + '%';
    this.hit.style.height = ((S.HIT_BOX.y1 - S.HIT_BOX.y0) / 360) * 100 + '%';
    // 命中层挂 aria-label：原生 title 已换成自绘浮层，但无障碍名称不能跟着丢
    this.hit.setAttribute('aria-label', this.pet.name);
    this.bubble = document.createElement('div');
    this.bubble.className = 'pet-bubble';
    // 余额气泡可点时点一下切页：就地吞掉事件，别让这次点击落到下面的本体命中层。
    this.bubble.addEventListener('click', (e) => {
      if (!this.balanceClickable()) return;
      e.stopPropagation();
      e.preventDefault();
      this.toggleBalanceDetail();
    });
    // 悬浮提示：this.el 内的绝对定位浮层，位置与翻边由 renderTip 决定，样式走 shared 的 TOOLTIP_CSS。
    this.tip = document.createElement('div');
    this.tip.className = S.TOOLTIP_CLASS;
    this.tip.setAttribute('aria-hidden', 'true');

    stage.appendChild(this.videoA);
    stage.appendChild(this.videoB);
    stage.appendChild(this.hit);
    this.el.appendChild(this.bubble);
    this.el.appendChild(this.tip);
    this.el.appendChild(stage);
    rootEl.appendChild(this.el);
    this.position();

    // 事件（与浏览器同一套：pointerdown/move、click、window pointerup/cancel）
    const ac = new AbortController();
    this.ac = ac;
    // 级联菜单新增面板、聊天输入增长都可能在鼠标停住时发生，不能只等下一次 mousemove。
    this.inputRegionResize = new ResizeObserver(() => this.syncInputRegions());
    this.inputRegionElements = new Set();
    this.inputRegionMutation = new MutationObserver(() => this.syncInputRegions());
    this.inputRegionMutation.observe(document.body, { childList: true, subtree: true });
    this.hit.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal: ac.signal });
    this.hit.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal: ac.signal });
    this.hit.addEventListener('click', (e) => this.onClick(e), { signal: ac.signal });
    this.hit.addEventListener('contextmenu', (e) => this.onContextMenu(e), { signal: ac.signal });
    window.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal: ac.signal });
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e), { signal: ac.signal });
    this.hit.addEventListener('lostpointercapture', (e) => this.onPointerUp(e), { signal: ac.signal });
    // 点击穿透：窗口默认整窗穿透，光标进出身体命中区时翻转可交互；穿透期间 mousemove 由主进程
    // 转发进来（forward:true），mouseleave 保证光标离开窗口立即恢复穿透。
    window.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal: ac.signal });
    window.addEventListener(
      'blur',
      () => {
        // 切到其它应用后旧菜单不该继续占着透明窗口；丢失松手时也释放拖拽。
        // 但**开菜单瞬间**的 blur 往往是本进程改窗口尺寸/形状引起的，宽限期内忽略（见 menuJustOpened）。
        if (!this.menuJustOpened()) this.closeMenu();
        this.setTip(false);
        if (this.dragState.active) this.onPointerUp();
        if (!this.chatOpen) this.setInteractive(false);
      },
      { signal: ac.signal },
    );
    window.addEventListener(
      'mouseleave',
      () => {
        // 光标离开窗口：菜单若开着立刻收起（窗口内 DOM，离开即不可达），再恢复穿透。
        // 拖拽中与对话弹窗开着都不恢复：前者会绕过 busy 并丢失 pointerup，后者要留光标回来点输入框。
        // 开菜单瞬间的 leave 同理不算（改窗口尺寸会触发），见 menuJustOpened。
        if (!this.menuJustOpened()) this.closeMenu();
        this.setTip(false); // 窗口在光标底下被搬走时不会再收到 mousemove：提示必须在这里收，否则滞留
        if (!this.chatOpen && !this.dragState.active) this.setInteractive(false);
      },
      { signal: ac.signal },
    );

    // 宠物间碰撞（跨窗 broker）：订阅其它宠物状态广播 + 「被撞」事件 → onDeskHit。
    // 退订由窗口销毁自然回收（webContents 销毁后 ipc 事件不再派发），无需显式取消。
    this.others = {}; // petId -> {x,y,vx,vy,size,bottomPad}（其它宠物的最新状态，来自主进程广播）
    this.throwState = null; // 飞行中的实时状态（被撞查询 / 其它窗碰撞检测时上报用）
    this.pressScoreFired = false; // 按下瞬间已触发过积分（pointerdown 即触发；click 据此不重复弹，同浏览器）
    this.lastFlightReport = 0;
    if (window.petBridge && window.petBridge.onFlightStates) {
      window.petBridge.onFlightStates((states) => {
        if (!states || typeof states !== 'object') return;
        const next = {};
        for (const pid of Object.keys(states)) {
          if (pid === this.pet.id) continue; // 排除自己
          const s = states[pid];
          next[pid] = {
            // 碰撞 broker 协议单位是物理像素：÷scale 进本窗口 CSS 系
            x: toLocal(Number(s && s.x) || 0),
            y: toLocal(Number(s && s.y) || 0),
            vx: toLocal(Number(s && s.vx) || 0),
            vy: toLocal(Number(s && s.vy) || 0),
            size: toLocal(Number(s && s.size) || 0),
            bottomPad: toLocal(Number(s && s.bottomPad) || 0),
          };
        }
        this.others = next;
      });
      window.petBridge.onPetHit((payload) => {
        const vx = Number(payload && payload.vx);
        const vy = Number(payload && payload.vy);
        if (Number.isFinite(vx) && Number.isFinite(vy)) this.onDeskHit(toLocal(vx), toLocal(vy));
      });
    }
  }

  dispose() {
    this.ac.abort();
    this.inputRegionMutation.disconnect();
    this.inputRegionResize.disconnect();
    this.inputRegionElements.clear();
    if (this.shapeTimer !== null) window.clearInterval(this.shapeTimer);
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

  // 目标包围盒左上角（视口相对坐标）→ 移动窗口：窗口 = sprite + 四周外扩余量。
  // setContentBounds 要屏幕坐标：视口坐标先加 VIEW.x/y，再统一 ×scale 回物理像素（IPC 收口），
  // 主进程侧不信任何比例。
  //
  // 实况（位置 + 朝向）上报：第三方用 GET /pose 读桌面端这份快照；位移全仓只有 sendBounds 会调
  // setBounds，所以在它末尾标脏就覆盖了全部位移场景；朝向不必然伴随位移（原地转身），
  // 故用 accessor 让赋值自动标脏。节流见 constants.js 的 POSE_THROTTLE_MS。

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

  // 双缓冲切换：前台视频切换 + 降级视频清 handler 并停播，防残留 ended 雪崩
  switchTo(next, nextOnce, playbackId, url) {
    if (!next) return;
    const pending = this.pending;
    if (pending && pending.anim === next && pending.once === nextOnce) {
      // 防重命中（单动画点击时目标=当前动画，不重播）：仍消费 Q 弹标记，压当前前台视频，
      // 保证「点击唯一动画」时挤压反馈不丢（与浏览器同构）。
      if (this.pendingSquash) {
        this.pendingSquash = false;
        this.startSquash(this.front === 0 ? this.videoA : this.videoB);
      }
      // 这次点播的目标本来就在播（没换源但确实在播）→ 如实回 playing，否则调用方只能干等 timeout
      if (playbackId) {
        this.playback = playbackId;
        this.reportPlayback(playbackId, 'playing');
      }
      return;
    }
    const gen = ++this.gen;
    this.pending = { anim: next, once: nextOnce, gen };
    const target = this.front === 0 ? this.videoB : this.videoA;
    const el = target;
    if (!el) return;
    // 素材地址两条路：url 形态直接用第三方给的完整地址（宿主已把 scheme 卡在 http/https，
    // 不经 bridge、也不拼 BASE）；name 形态按「素材根 + 名字」拼。
    el.src = url || this.assetBase + encodeURIComponent(next) + (S.ANIMATION_EXT || '.webm');
    el.loop = !nextOnce;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = nextOnce ? () => this.handleEnded() : null;
    // 加载兜底（同浏览器端 10s 超时）：素材加载失败或卡住时必须释放 pending，否则它永久挂起——
    // 相同目标会被防重分支吞掉、不同目标靠 gen 覆盖，表现就是「点了没反应」。
    const loadGuard = (why) => {
      if (!this.pending || this.pending.gen !== gen) return;
      this.pending = null;
      console.warn('[dsh-pet] 素材加载失败 pet=' + this.pet.id + ' anim=' + next + '：' + why + '（已释放本次切换）');
      // 播放回执：这一段没能播起来 → 如实回 failed（而不是让调用方干等到 timeout）
      if (playbackId) {
        if (this.playback === playbackId) this.playback = null;
        this.reportPlayback(playbackId, 'failed', why === 'video error' ? 'decode-error' : 'asset-load');
      }
    };
    const loadTimer = window.setTimeout(() => loadGuard('10s 超时'), 10000);
    el.onerror = () => {
      window.clearTimeout(loadTimer);
      loadGuard('video error');
    };
    el.load();
    const onReady = () => {
      el.removeEventListener('loadeddata', onReady);
      window.clearTimeout(loadTimer);
      el.onerror = null;
      if (this.pending && this.pending.gen !== gen) return;
      const old = this.front === 0 ? this.videoA : this.videoB;
      el.classList.add('is-front');
      if (old && old !== el) {
        old.classList.remove('is-front');
        old.onended = null;
        old.pause();
        // 被换下去的那一段若属第三方点播且没播完 → 如实回 cancelled（被新点播顶掉由宿主受理时标记，
        // 这里补的是点击/拖拽/碎碎念/余额/工作状态/空闲回收这类非点播打断）。
        if (this.playback && this.playback !== playbackId) {
          this.reportPlayback(this.playback, 'cancelled', 'superseded');
        }
      }
      this.front = this.front === 0 ? 1 : 0;
      this.pending = null;
      this.playback = playbackId || null;
      el.style.transform = this.facing === 'right' ? 'scaleX(-1)' : '';
      el.play()
        .then(() => {
          // 只有 play() 兑现才代表确实开始出画（loadeddata 只代表可解码）
          if (playbackId) this.reportPlayback(playbackId, 'playing');
        })
        .catch(() => {
          // 自动播放被拒 / 元素不可播：如实回 failed，不改播放控制
          if (!playbackId) return;
          if (this.playback === playbackId) this.playback = null;
          this.reportPlayback(playbackId, 'failed', 'play-rejected');
        });
      // 点击 Q 弹：等新动画就位后才压（压的是新点击动画的首帧，与浏览器一致）
      if (this.pendingSquash) {
        this.pendingSquash = false;
        this.startSquash(el);
      }
      if (this.pendingMove) this.startMoveDrive(el);
    };
    el.addEventListener('loadeddata', onReady);
    if (el.readyState >= 2) onReady();
  }

  playOnce(name, playbackId, url) {
    this.anim = name;
    this.once = true;
    this.switchTo(name, true, playbackId, url);
  }

  // 直接播一个外部地址。单独一个方法、不复用 onMenuAction：那套是菜单语义（文字类强制朝左的镜像
  // 修正、移动类走真实位移），裸地址没有这些属性。这里只停掉漫游并换源播一次，播完回到正常动画链；
  // 地址本身同时是 pending 的防重键与日志标识。
  playUrlOnce(url, playbackId) {
    this.stopMove();
    this.playOnce(url, playbackId, url);
  }

  /**
   * 占用锁：冻结 / 解冻（与浏览器同一套语义）。
   *
   * 冻结期间只挡四件事，且都在渲染端：随机链、当前自播动画（暂停定帧）、自动来源的余额与
   * 工作状态表现（见 events.js 的 onBalanceTick / onWorkTick / showBalanceNotice）、屏上的任务
   * 状态气泡（锁生效就收掉，解冻不补亮）。
   * 显式指令（say / anim / position / throw）一概不挡——那正是占用要保护的东西。
   */
  applyFreeze(next) {
    if (this.frozen === next) return;
    this.frozen = next;
    const el = this.front === 0 ? this.videoA : this.videoB;
    const stamp = '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + this.pet.id;
    if (next) {
      // 停住正在播的那一段：宿主停不掉一段视频，完全静止只能由渲染端执行；只堵随机链入口不够，
      // 那个入口要等动画播完才被调用。
      this.stopMove();
      if (el) el.pause();
      // 播放回执：冻结打断了正在播的第三方点播 → 如实回 cancelled，而不是让它一直挂着 playing
      // （挂 wait=ended 的调用方会白等一个 timeout）。解冻走的是回 idle/恢复档位，不会把它接回来。
      // 先清 this.playback 再上报，免得后续换源又当成「被顶掉」再报一次。
      const interrupted = this.playback;
      if (interrupted) {
        this.playback = null;
        this.reportPlayback(interrupted, 'cancelled', 'frozen');
      }
      // 任务状态气泡：锁一生效就收掉，解冻不补亮
      if (this.workTimer !== null) window.clearTimeout(this.workTimer);
      this.workTimer = null;
      this.workOn = false;
      this.renderBubble();
      console.log(stamp + ' 占用锁生效：冻结（随机链停 + 当前动画暂停 + 任务状态气泡收起）');
      return;
    }
    console.log(stamp + ' 占用锁解除：恢复');
    // 解冻：非终态工作状态回档位循环，否则回 idle 一次，播完由 handleEnded 接回随机链。
    if (this.resumeWorkStatusAnim()) return;
    if (this.animations.idle.length) this.playOnce(S.pick(this.animations.idle, this.anim));
  }

  /**
   * 锁叶子 → 冻结 / 解冻。
   *
   * expiresAt 已经过去 = 没有锁：窗口重载后拿到的陈旧叶子必须这么判，不能只看 locked。
   * 宿主不会到点推「锁没了」，所以这里自己定时解除，两端的「到点」因此同源。
   */
  setLock(state) {
    if (this.lockTimer !== null) {
      window.clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    const expiresAt = state && state.locked === true ? state.expiresAt : 0;
    this.applyFreeze(expiresAt > Date.now());
    if (expiresAt <= Date.now()) return;
    this.lockTimer = window.setTimeout(
      () => {
        this.lockTimer = null;
        this.applyFreeze(false);
      },
      Math.max(0, expiresAt - Date.now()),
    );
  }

  // 动画链（纯逻辑在 shared）
  playIdle() {
    // 占用锁：锁生效时不掷骰。这里是随机链的唯一入口（动画播完才会走到），一句判断就把随机动画、
    // 随机转向与自主走位一起停住——宠物停在最后一帧，等持锁者的下一条指令（走 /anim，不经这里）。
    if (this.frozen) return;
    this.stopMove();
    const { animations, animationWeights } = { animations: this.animations, animationWeights: this.weights };
    const roll = Math.random();
    // 宠物固定：掷骰时把「转向 / 移动」两档权重按 0 算，随机链不再让宠物自己翻朝向或走开；
    // 菜单点播与 /anim 不走这里，不受影响。
    const k = S.rollKind(roll, animationWeights, { fixed: this.pet.fixedEnabled });
    let next;
    if (k === 'idle') {
      next = S.pick(animations.idle, this.anim);
    } else if (k === 'turn') {
      next = S.pick(animations.turn, this.anim);
    } else if (k === 'move') {
      const moved = this.tryMove();
      if (moved === false) {
        const act = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim);
        next = act.name;
      } else if (typeof moved === 'string') {
        next = moved;
      } else {
        // 已有一场移动进行中：重播当前动画，不另设（绝不加载不存在的动作）
        this.playOnce(this.anim);
        return;
      }
    } else {
      const act = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim);
      next = act.name;
    }
    this.playOnce(next);
  }

  handleEnded() {
    // 播放回执：前台视频真的播完了 → 如实回 ended。放在拖拽守卫之前——「播完了」是既成事实，
    // 拖拽守卫管的是动画链怎么推进，不该影响回执的准确性。
    if (this.playback) {
      const done = this.playback;
      this.playback = null; // 先清再上报：后续链式换源不该把它当成「被打断」
      this.reportPlayback(done, 'ended');
    }
    if (this.dragState.active) return;
    // 占用锁：冻结期间动画链一律不推进，事件动画播完就停在最后一帧。下面几条路都会换源播放，
    // 而它们读的是实时 workState、与 workTick 无关，onWorkTick 的门禁拦不住——尤其「事件动画播完
    // 恢复档位」：持锁者每投一次带 anim 的气泡，说话动画播完就把工作状态动画点回来。
    // 播放回执已在上面上报，不受这一行影响。
    if (this.frozen) return;
    const { animations } = { animations: this.animations };
    // 事件动画播完：回 idle（与 drag/clicks 同分支，不进随机链）；气泡由定时器自动消失，与动画解耦
    const isEvent = S.isEventAnim(animations.events, this.anim);
    if (isEvent) {
      // 工作状态多候选档位：播完一段自动轮换到下一候选，长时间状态不单段重复；仅非终态档位轮换，
      // 终态播完即止；单候选档位由 loop 无限循环（不触发 ended，走不到这里）。
      const nonTerminal = this.workState && this.workState !== 'success' && this.workState !== 'error';
      const nextWork = nonTerminal ? S.nextWorkStatusAnim(animations.events?.workStatus ?? [], this.anim) : null;
      if (nextWork !== null) {
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            this.pet.id +
            ' workStatus 档内轮换: ' +
            this.anim +
            ' -> ' +
            nextWork,
        );
        this.playOnce(nextWork); // 继续播一遍（once=true）→ ended 再轮换
        return;
      }
      // 非 workStatus 事件动画（余额/碎碎念）播完：workStatus 仍非终态 → 立即恢复档位循环动画，
      // 不进随机链（长事件期间状态不变，随机链会一直播到状态切换才被拉回）
      if (this.resumeWorkStatusAnim()) return;
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    if (animations.turn.includes(this.anim)) {
      const next = this.facing === 'left' ? 'right' : 'left';
      this.facing = next; // 立即同步：翻转后的 pickNext 用新朝向过滤 noMirror
    }
    if (animations.drag.includes(this.anim) || animations.clicks.includes(this.anim)) {
      // 互动动画播完：workStatus 非终态时恢复状态循环，否则回 idle（与浏览器同一语义）
      if (this.resumeWorkStatusAnim()) return;
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    this.playIdle();
  }

  // 互动/事件动画播完后恢复工作状态档位循环：非终态 → 按当前档位重选动画（避开当前段）；
  // 终态/空闲 → false 不接管，调用方走原逻辑。
  resumeWorkStatusAnim() {
    // 占用锁：冻结期间不许由这条路把工作状态动画点回来——它读的是实时 workState，与 workTick 无关，
    // 持锁者每投一次带 anim 的气泡，说话动画播完就会走到这里。解冻路径是先置 frozen=false 再调它。
    if (this.frozen) return false;
    const state = this.workState;
    if (!state || state === 'success' || state === 'error') return false;
    const pool = this.animations.events?.workStatus;
    if (!pool || pool.length === 0) return false;
    const idx = S.WORK_STATUS_INDEX[state];
    const slot = pool[idx];
    if (slot === undefined) return false;
    const name = S.pickSlot(slot, this.anim); // 避开当前正播动画（避免连续重复）
    console.log(
      '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + this.pet.id + ' 恢复工作状态动画: ' + name,
    );
    const rotating = Array.isArray(slot) && slot.length > 1;
    if (rotating)
      this.playOnce(name); // 多候选：播完由 handleEnded 轮换
    else this.switchTo(name, false); // 单候选：无限循环
    return true;
  }

  // 漫游（rAF 驱动，动画首尾各 leadSec/tailSec 秒原地不动；几何在 shared/planMove）。
  // preferredName 传入时固定用该动画（菜单点播移动动画），否则与随机链一致随机选。
  tryMove(preferredName, playbackId) {
    if (this.moveRef !== null || this.pendingMove || this.throwRef !== null) return true;
    const moves = this.animations.moves;
    const actions = moves.actions;
    if (!actions.length) return false;
    const chosen = preferredName
      ? actions.find((a) => a.name === preferredName) || null
      : actions[Math.floor(Math.random() * actions.length)];
    if (!chosen) return false;
    const mp = Object.assign({}, moves.default, chosen.params || {});
    // 朝向 → 走路方向：只看当前 facing。turn 播完会立即同步朝向，所以这里不能再做 XOR 修正，
    // 否则方向会多翻一次（镜像朝右、人往左走）。
    const dir = this.facing === 'right' ? 1 : -1;
    const W = VIEW.w;
    const H = VIEW.h;
    const distScale = this.size / S.PET_REF_WIDTH;
    const cx = this.currentCenterX();
    const cy = this.currentCenterY();
    // 落点按显示器判定：默认走并集（能骑缝跨屏，但走不进外接矩形里的空洞）。confineToScreen 开启时
    // 只按宠物现在所在那块屏判定，屏缝与空洞一样当墙、越界那一步直接取消。抛掷是逐帧物理边界，
    // 漫游是一次性落点规划、没有反弹语义；宠物落在空洞里时 resolveRect 取最近那块屏，仍走得动。
    const wanderArea = this.confineToScreen ? S.resolveRect(AREAS, cx, cy) : null;
    const plan = S.planMove({
      cx,
      cy,
      W,
      H,
      dir,
      minDist: mp.minDist * distScale,
      maxDist: mp.maxDist * distScale,
      margin: mp.margin, // 同 position() 的 marginX/marginY：配置值不再乘 scale
      halfW: this.halfW,
      sideAllow: this.sideAllow,
      areas: wanderArea ? [wanderArea] : AREAS,
    });
    if (!plan) return false;
    this.pendingMove = { ...plan, dir, leadSec: mp.leadSec, tailSec: mp.tailSec };
    this.anim = chosen.name;
    this.once = true;
    this.switchTo(chosen.name, true, playbackId);
    return chosen.name;
  }

  startMoveDrive(el) {
    const pm = this.pendingMove;
    if (!pm || this.moveRef !== null) return;
    this.pendingMove = null;
    const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
    const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
    const token = ++this.moveToken;
    const W = VIEW.w;
    const H = VIEW.h;
    const step = () => {
      if (this.moveToken !== token) return;
      const t = el.currentTime || 0;
      let ratioX;
      if (t <= leadSec) ratioX = startRatio;
      else if (t >= duration - tailSec) ratioX = targetRatio;
      else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
      // 移动的是窗口（宠物包围盒跟随），sprite 在本窗口内不动
      this.sendBounds(ratioX * W - this.halfW, startYRatio * H - this.halfH);
      if (t < duration - tailSec) {
        this.moveRef = requestAnimationFrame(step);
      } else {
        this.moveRef = null;
        this.customPos = { rx: targetRatio, ry: startYRatio };
      }
    };
    this.moveRef = requestAnimationFrame(step);
  }

  stopMove() {
    this.pendingMove = null;
    this.moveToken++;
    if (this.moveRef !== null) {
      cancelAnimationFrame(this.moveRef);
      this.moveRef = null;
    }
    // 位置指令的弹簧也是自主移动：停走路时一并停掉，否则两套运动系统会同时改窗口位置。
    this.stopPosFollow();
  }

  // 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹）
  stopDragFollow() {
    this.dragFollowToken++;
    if (this.dragFollow !== null) {
      cancelAnimationFrame(this.dragFollow);
      this.dragFollow = null;
    }
    this.dragTarget = null;
    this.dragVel = { vx: 0, vy: 0 };
  }

  /** rAF 弹簧跟随：窗口朝拖拽目标过阻尼追赶（不再硬贴指针），抹平高频抖动 */
  startDragFollow() {
    if (this.dragFollow !== null) return;
    const token = ++this.dragFollowToken;
    let last = performance.now();
    const step = () => {
      if (this.dragFollowToken !== token) return;
      const target = this.dragTarget;
      if (!target) {
        this.dragFollow = null;
        return;
      }
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const vel = this.dragVel;
      let x = this.pos.x;
      let y = this.pos.y;
      vel.vx = S.springStep(vel.vx, x, target.x, dt, this.physics.throwPower);
      vel.vy = S.springStep(vel.vy, y, target.y, dt, this.physics.throwPower);
      x += vel.vx * dt;
      y += vel.vy * dt;
      this.sendBounds(x, y); // 移动的是窗口（this.pos 实时更新）；sprite 在本窗口内不动
      this.dragFollow = requestAnimationFrame(step);
    };
    this.dragFollow = requestAnimationFrame(step);
  }

  /** 停止抛掷（空中被抓/点菜单/回家时定格在当前落点）。必须同时清 throwState——否则「抓住后温柔放下」
   *  会残留最后一次飞行速度，静止的宠物点一下就被误判成飞行中。 */
  stopThrow() {
    this.throwToken++;
    if (this.throwRef !== null) {
      cancelAnimationFrame(this.throwRef);
      this.throwRef = null;
    }
    this.throwState = null;
  }

  /** 抛掷驱动：重力 + 边缘反弹 + 落地摩擦，落定后写入 customPos */
  startThrow(px, py, vx, vy) {
    this.stopDragFollow();
    this.stopMove();
    // 边界 = 工作区并集：空洞是墙，屏缝不是墙（跨屏弹跳照旧）。confineToScreen 开启时改为锁定
    // 松手这一刻所在的那块屏，飞行途中不重取；relayout 改了屏数时由 throwStepRegion 退回不锁定。
    const lockScreen = this.confineToScreen ? S.screenOfBox(this.throwSpaceOf(), px, py) : -1;
    const token = ++this.throwToken;
    let state = { x: px, y: py, vx, vy };
    let last = performance.now();
    let prevGrounded = false; // 落地 Q 弹：只在空中→地面转换帧触发一次
    const step = () => {
      if (this.throwToken !== token) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const fallingVy = state.vy; // 本帧积分前的竖直速度（正=下落）：即落地冲击速度
      // 每帧重取：显示器变化时 relayout() 会让缓存失效，res.screen 必须与这一份对应
      const sp = this.throwSpaceOf();
      // 细分积分：弹弓没有速度上限，一帧可能跨过上百 px；不拆会跳过落地/反弹那几帧，
      // Q 弹、地面摩擦与 atRest 判定都会漏。普通甩抛算出 1 步，与单步积分逐位相同。
      const substeps = S.throwSubsteps(state.vx, state.vy, dt);
      let res = S.throwStepRegion(state, dt / substeps, sp, this.physics, lockScreen);
      for (let i = 1; i < substeps && !res.atRest; i++) {
        res = S.throwStepRegion(res, dt / substeps, sp, this.physics, lockScreen);
      }
      state = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
      this.throwState = state;
      // 上报飞行状态（节流 ~30ms）：主进程 broker 汇聚后广播，其它窗口据此做跨窗碰撞检测；
      // broker 协议单位是物理像素，这里 ×scale。
      if (window.petBridge && window.petBridge.reportFlight && now - this.lastFlightReport > 30) {
        window.petBridge.reportFlight({
          x: toScreen(state.x),
          y: toScreen(state.y),
          vx: toScreen(state.vx),
          vy: toScreen(state.vy),
          size: toScreen(this.size),
          bottomPad: toScreen(this.bottomPad),
        });
        this.lastFlightReport = now;
      }
      // 宠物间碰撞（仅 petCollision 开启）：飞行中的自己撞到其它宠物 → 动量弹开
      if (this.physics && this.physics.petCollision) {
        const myBody = S.bodyPixelBox({ x: state.x, y: state.y, size: this.size, bottomPad: this.bottomPad });
        for (const pid of Object.keys(this.others)) {
          const o = this.others[pid];
          if (!o || !o.size) continue;
          const otherBody = S.bodyPixelBox({ x: o.x, y: o.y, size: o.size, bottomPad: o.bottomPad });
          if (!S.rectsOverlap(myBody, otherBody)) continue;
          const hit = S.collidePet(
            { x: state.x, y: state.y, vx: state.vx, vy: state.vy, size: this.size },
            { x: o.x, y: o.y, vx: o.vx, vy: o.vy, size: o.size },
          );
          if (hit) {
            // 飞行方：按动量结果继续弹开；被撞方：主进程转发给目标窗口 → 目标窗 startThrow
            state.vx = hit.fvx;
            state.vy = hit.fvy;
            this.throwState = state;
            if (window.petBridge && window.petBridge.reportCollide) {
              // 被撞方初速同为 broker 物理像素协议：×scale
              window.petBridge.reportCollide(pid, toScreen(hit.hvx), toScreen(hit.hvy));
            }
            break; // 一帧只处理一次碰撞（避免连锁触发抖动）
          }
        }
      }
      this.sendBounds(res.x, res.y);
      // 落地 Q 弹：只在空中→地面转换帧触发一次，力度随冲击速度；「地面」是当前所在屏的底边。
      const curBounds = sp.bounds[res.screen] || sp.bounds[0];
      const grounded = curBounds ? res.y >= curBounds.maxY - 1 : false;
      if (res.bounced && grounded && !prevGrounded) {
        const frontEl = this.front === 0 ? this.videoA : this.videoB;
        this.startSquash(frontEl, S.landingSquash(fallingVy));
      }
      prevGrounded = grounded;
      if (res.atRest) {
        this.throwRef = null;
        this.throwState = null;
        this.customPos = { rx: (this.pos.x + this.halfW) / VIEW.w, ry: (this.pos.y + this.halfH) / VIEW.h };
        window.__dshPetDebug.lastDragRelease = { x: this.pos.x, y: this.pos.y };
        return;
      }
      this.throwRef = requestAnimationFrame(step);
    };
    this.throwRef = requestAnimationFrame(step);
  }

  // 位置 / 抛掷指令（POST /position、POST /throw）
  stopPosFollow() {
    this.posFollowToken++;
    if (this.posFollow !== null) {
      cancelAnimationFrame(this.posFollow);
      this.posFollow = null;
    }
  }

  /**
   * 位置指令：把宠物中心挪到归一化坐标 (rx, ry)，与 customPos 同一套语义。
   * mode 三选一：instant 一帧到位；spring 走过阻尼弹簧；line 在 duration 毫秒里直线走完
   * （duration <= 0 等同 instant）。用户正按着宠物时整拍静默丢弃——手指底下的东西不该跑。
   * 归一化空间是工作区并集的外接矩形，落点会被夹到 AREAS 并集（空洞不可达）。
   */
  moveToCenter(rx, ry, mode, duration) {
    if (this.dragState.active) return; // 用户交互优先
    this.stopThrow(); // 先显式接管：停掉飞行与走路（stopMove 顺带停掉上一次的位置跟随）
    this.stopMove();
    // 归一化空间是外接矩形，不规则布局里含大片空洞；position() 的 customPos 分支零夹取，
    // 不夹的话落进空洞的坐标会把宠物放进看不见的地方。鼠标拖拽到不了那里不是因为代码在拦，
    // 而是光标物理上出不去屏幕——位置接口必须自己补这道守卫：把身体中心夹到 AREAS 并集。
    const c = S.clampPointToRegion(AREAS, rx * VIEW.w, ry * VIEW.h);
    // 夹取后的比例才是要写进 customPos 的值：position() 会按它重算窗口位置。
    const fx = c.x / VIEW.w;
    const fy = c.y / VIEW.h;
    const px = c.x - this.halfW;
    const py = c.y - this.halfH;
    if (mode === 'instant' || (mode === 'line' && duration <= 0)) {
      this.sendBounds(px, py);
      this.customPos = { rx: fx, ry: fy };
      return;
    }
    const token = ++this.posFollowToken;
    if (mode === 'line') {
      // 直线补间：在像素空间插值——按归一化比例插值会把斜线走歪（外接矩形不是正方形）
      const fromX = this.pos.x;
      const fromY = this.pos.y;
      const t0 = performance.now();
      const step = () => {
        if (this.posFollowToken !== token) return;
        const p = Math.min((performance.now() - t0) / duration, 1);
        if (p >= 1) {
          // 精确落位：终点不留残余偏差（弹簧那条靠收敛阈值收尾，这条靠 p 到 1）
          this.posFollow = null;
          this.sendBounds(px, py);
          this.customPos = { rx: fx, ry: fy };
          return;
        }
        this.sendBounds(fromX + (px - fromX) * p, fromY + (py - fromY) * p);
        this.posFollow = requestAnimationFrame(step);
      };
      this.posFollow = requestAnimationFrame(step);
      return;
    }
    // spring：过阻尼弹簧跟随——没有行程时间，靠收敛判定自己收尾
    let last = performance.now();
    const vel = { vx: 0, vy: 0 };
    const step = () => {
      if (this.posFollowToken !== token) return;
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      let x = this.pos.x;
      let y = this.pos.y;
      vel.vx = S.springStep(vel.vx, x, px, dt, this.physics.throwPower);
      vel.vy = S.springStep(vel.vy, y, py, dt, this.physics.throwPower);
      x += vel.vx * dt;
      y += vel.vy * dt;
      this.sendBounds(x, y);
      // 收敛判定：足够近且足够慢 → 精确落位并提交。拖拽跟手靠指针松手结束，这条得自己判。
      if (Math.abs(px - x) < 0.5 && Math.abs(py - y) < 0.5 && Math.abs(vel.vx) < 1 && Math.abs(vel.vy) < 1) {
        this.posFollow = null;
        this.sendBounds(px, py);
        this.customPos = { rx: fx, ry: fy };
        return;
      }
      this.posFollow = requestAnimationFrame(step);
    };
    this.posFollow = requestAnimationFrame(step);
  }

  /**
   * 抛掷指令：角度（度，0 = 正右，逆时针为正）+ 力度倍率 → 初速度，交给 startThrow；
   * 下游的重力/反弹/摩擦/落地 Q 弹/跨窗碰撞全是既有行为。
   */
  throwWith(angleDeg, power) {
    if (this.dragState.active) return; // 用户交互优先
    const v = S.throwVelocity(angleDeg, power);
    this.startThrow(this.pos.x, this.pos.y, v.vx, v.vy);
  }

  /** 被撞回调（跨窗碰撞 broker 转发）：停当前动作，从落点以新初速抛出去（全复用现有物理） */
  onDeskHit(vx, vy) {
    this.stopMove();
    this.stopDragFollow();
    this.stopThrow();
    this.startThrow(this.pos.x, this.pos.y, vx, vy);
  }

  /** Q 弹挤压：前台视频垂直压扁（贴地锚定再回弹），曲线在 shared。depth = 下压幅度
   *  （点击固定 0.55，落地按冲击速度动态取）；reduce-motion 时跳过。 */
  startSquash(el, depth = S.SQ_SQUASH) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const token = ++this.squashToken;
    if (this.squashRef !== null) cancelAnimationFrame(this.squashRef);
    const origin = el.style.transformOrigin;
    el.style.transformOrigin = 'bottom';
    const t0 = performance.now();
    const step = () => {
      if (this.squashToken !== token) return;
      const u = Math.min((performance.now() - t0) / S.SQ_DURATION_MS, 1);
      const scale = S.squashScale(u, depth);
      el.style.transform = (this.facing === 'right' ? 'scaleX(-1) ' : '') + 'scaleY(' + scale + ')';
      if (u < 1) {
        this.squashRef = requestAnimationFrame(step);
      } else {
        this.squashRef = null;
        el.style.transformOrigin = origin;
        // 恢复纯镜像（若期间 switchTo 重置过 transform，也以镜像为准）
        el.style.transform = this.facing === 'right' ? 'scaleX(-1)' : '';
      }
    };
    this.squashRef = requestAnimationFrame(step);
  }

  stopSquash() {
    this.squashToken++;
    if (this.squashRef !== null) {
      cancelAnimationFrame(this.squashRef);
      this.squashRef = null;
    }
  }

  // 点击 vs 拖拽（阈值/抓取偏移/释放回循环待机；移动的是窗口）
  onPointerDown(e) {
    // 只认左键：右键进入拖拽判定会与右键菜单打架
    if (e.button !== 0) return;
    // 占用锁：用户点了或拖了这只宠物 = 用户接管，立刻撤掉第三方占用。这是唯一一处「渲染端 → 宿主」
    // 的锁上报——宿主看不见鼠标，而锁在它手里（/lock/release 的 force 形态）。
    // 先本地解冻再上报：等叶子往返会让宠物「点了半天才动」，而此刻 frozen 为真说明这次释放必然成功。
    if (this.frozen) {
      if (this.lockTimer !== null) {
        window.clearTimeout(this.lockTimer);
        this.lockTimer = null;
      }
      this.applyFreeze(false);
      S.postAction(BASE + '/lock/release?pet=' + encodeURIComponent(this.pet.id), { force: true }).then((ok) => {
        if (!ok) console.warn('[dsh-pet] 用户接管上报未送达 pet=' + this.pet.id);
      });
    }
    // 抓取速度日志：stopThrow 之前读，否则飞行速度就没了；静止时记录 0
    const grabState = this.throwState;
    console.log(
      '[dsh-pet] ' +
        new Date().toTimeString().slice(0, 8) +
        ' pet=' +
        this.pet.id +
        ' grab vx=' +
        (grabState ? Math.round(grabState.vx) : 0) +
        ' vy=' +
        (grabState ? Math.round(grabState.vy) : 0) +
        ' |v|=' +
        (grabState ? Math.round(Math.hypot(grabState.vx, grabState.vy)) : 0),
    );
    // 点击积分：按下瞬间即触发（不等松开）。读 stopThrow 之前的飞行速度，达标就爆发 + 弹窗；
    // pressScoreFired 标记本次按下已触发，松开的 click 据此不再重复弹、也不再播普通点击动画。
    this.pressScoreFired = false;
    // 修饰键+点击是「呼出 DSH」快捷键：不弹积分，避免快捷键顺手刷分
    if (grabState && !isOpenShortcut(e)) {
      const grabSpeed = Math.hypot(grabState.vx, grabState.vy);
      if (grabSpeed >= S.SCORE_MIN_SPEED) {
        this.pressScoreFired = true;
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            this.pet.id +
            ' click-score speed=' +
            Math.round(grabSpeed) +
            ' size=' +
            this.size +
            ' -> +' +
            S.clickScore(grabSpeed, this.size),
        );
        S.spawnScoreBurst(e.clientX, e.clientY);
        S.mountScorePopup({
          x: e.clientX,
          y: e.clientY,
          score: S.clickScore(grabSpeed, this.size),
          speed: grabSpeed,
          size: this.pet.size,
        });
      }
    }
    this.stopThrow(); // 空中抓取：从当前落点开始新拖拽（this.pos 实时）
    this.stopDragFollow();
    this.stopMove();
    this.dragTrail = [];
    // 弹弓：按下时记时刻、按下时比对——间隔 = 两次按下之间的距离，与这次拖了多久无关，
    // 也没有「待拉」状态或超时清理。
    const pressNow = performance.now();
    const sling = pressNow - this.lastPressAt < S.SLINGSHOT_DOUBLE_MS;
    this.lastPressAt = sling ? 0 : pressNow; // 命中就清掉，免得连点三下弹两次
    this.hit.classList.add('dragging');
    // 收起悬浮提示：拖拽期间指针始终在身体内，不主动收提示会跟着宠物一路飘（松手后由 onPointerUp 复位）
    this.setTip(false);
    this.stopMove();
    try {
      this.hit.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略捕获失败 */
    }
    // client 坐标是相对窗口内容区的：窗口搬走多少它就反向变化多少，与宠物位移相加正好抵消。
    // 位移见 onPointerMove；sx/sy 只留痕，不再参与计算。
    this.dragState = {
      active: true,
      dragging: false,
      clientX: e.clientX,
      clientY: e.clientY,
      sx: toLocal(e.screenX),
      sy: toLocal(e.screenY),
      petX: this.pos.x,
      petY: this.pos.y,
    };
    // 拖拽信号：主进程兜底通道按光标与窗口矩形判定，而窗口比身体大一圈；拖拽中宠物滞后于光标，
    // 光标可能出窗 → 翻回穿透 → 收不到 pointermove/pointerup。这里上报「我正在用输入」。
    this.syncInputBusy();
    // 弹弓：把本次是否拉弓与按下时的宠物中心补进同一次拖拽状态。放在上报之后是为了不稀释
    // 源码守卫（它要求 busy 必须在建立状态后紧跟着上报）。
    this.dragState.sling = sling;
    this.dragState.anchorX = this.pos.x + this.halfW;
    this.dragState.anchorY = this.pos.y + this.halfH;
    // 舞台「拍平」不能在这里做：纯点击会让人物瞬移上移再落下，只有拖拽超过阈值才拍平。
  }

  onPointerMove(e) {
    const d = this.dragState;
    if (!d.active) return;
    // 指针位移（CSS 像素）与**单位无关**的算法：Δ指针 = 宠物/窗口自身位移 + client 增量。
    // 不能用 e.screenX：它的口径不统一（物理像素 / DIP / 已被页面缩放除过一次），而本窗口同时开着
    // force-device-scale-factor 与页面缩放（setZoomFactor(CONFIG.scale)）——旧写法 `Δ = toLocal(screenX)`
    // 在 151% 缩放下多除了一次，指针走 100px 宠物只走 63px，拖到屏幕边宠物还留在中间。
    const dx = this.pos.x - d.petX + (e.clientX - d.clientX);
    const dy = this.pos.y - d.petY + (e.clientY - d.clientY);
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < S.DRAG_THRESHOLD) return;
      d.dragging = true;
      // 真正开始拖拽才把舞台拍平（人物随光标拿起）
      this.stage.style.transform = 'none';
      if (this.animations.drag.length) {
        this.playOnce(S.pick(this.animations.drag));
      }
      this.syncInputBusy(); // 拖拽成立：主进程兜底通道闭嘴（见 inputBusy）
    }
    // 记录指针轨迹（与位移同一套 CSS 坐标，初速估算/甩抛力度才不会被缩放带偏）
    const now = performance.now();
    this.dragTrail.push({ t: now, x: d.petX + dx, y: d.petY + dy });
    this.dragTrail = S.trimTrail(this.dragTrail, now);
    // 弹簧目标 = 按下时的宠物位置 + 指针屏幕增量（窗口怎么动都不影响坐标），由 rAF 逐帧追赶
    this.dragTarget = { x: d.petX + dx, y: d.petY + dy };
    this.startDragFollow();
  }

  onPointerUp(e) {
    const d = this.dragState;
    const wasDragging = d.dragging;
    d.active = false;
    d.dragging = false;
    this.hit.classList.remove('dragging');
    this.stopDragFollow(); // 弹簧跟随立即停（位置定格在实时 this.pos）
    this.stage.style.transform = 'translateY(' + this.bottomPad + 'px)';
    this.syncInputBusy(); // 拖拽结束：交还给常规判定（幂等，非拖拽时多调一次不发 IPC）
    // 提示复位：点击/拖拽期间收起，指针仍在命中区内就恢复。用 hitRect 而不是 getBoundingClientRect
    // ——命中区是窗口坐标里的权威几何，与 onMouseMove 同源。必须留在 syncInputBusy() 之后：
    // 源码守卫只扫本函数开头 400 字符找上报调用，插到前面会把上报挤出窗口。
    if (e && Number.isFinite(e.clientX)) {
      const r = this.hitRect;
      const px = e.clientX - (this.margin.l - this.body.x);
      const py = e.clientY - (this.margin.t - this.body.y);
      // 先按松手位置更新光标再摆位/显示，否则会重现拖拽前的位置（与浏览器 placeTip 同一处理）
      this.tipCursor = {
        x: this.pos.x + this.body.x - this.margin.l + e.clientX,
        y: this.pos.y + this.body.y - this.margin.t + e.clientY,
      };
      this.setTip(px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
    }
    if (wasDragging) {
      this.justDragged = true;
      setTimeout(() => {
        this.justDragged = false;
      }, 100);
      if (e && Number.isFinite(e.screenX)) {
        // 原始输入留痕（实机排查用：验证指针屏幕坐标与窗口位移是否一致，如 DPI 缩放问题）
        window.__dshPetDebug.lastDragRaw = {
          petX: d.petX,
          petY: d.petY,
          sxDown: d.sx,
          syDown: d.sy,
          xUp: e.screenX,
          yUp: e.screenY,
        };
      }
      // 拖拽松手：非终态工作状态恢复档位循环，否则回 idle。必须用 playOnce：switchTo(idle,false)
      // 会 loop 播放、ended 永不触发，随机链就再也回不来。
      if (!this.resumeWorkStatusAnim()) {
        if (this.animations.idle.length) this.playOnce(S.pick(this.animations.idle, this.anim));
      }
      // 释放位置 = 弹簧跟随后的实际包围盒左上角（不是指针目标：滞后时落点应跟随宠物实际位置）
      const px = this.pos.x;
      const py = this.pos.y;
      if (d.sling) {
        // 弹弓：力度 = 拉距（与手速无关），方向 = 拉的反方向；拉向量用宠物实际中心算
        // （弹簧有滞后，用户看到的是宠物被拉出去多远）。之后与甩抛走同一条 startThrow。
        const pullX = px + this.halfW - d.anchorX;
        const pullY = py + this.halfH - d.anchorY;
        const dist = Math.hypot(pullX, pullY);
        const rawPower = S.slingshotPower(dist, this.size);
        const v = S.slingshotVelocity(S.pullAngle(pullX, pullY), rawPower, this.physics.throwPower);
        this.dragTrail = [];
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            this.pet.id +
            ' sling dist=' +
            Math.round(dist) +
            ' power=' +
            rawPower.toFixed(2) +
            ' vx=' +
            Math.round(v.vx) +
            ' vy=' +
            Math.round(v.vy),
        );
        this.startThrow(px, py, v.vx, v.vy);
      } else {
        // 初速估算：够快就抛掷，否则原地放下
        const vel = S.estimateReleaseVelocity(this.dragTrail, performance.now(), this.physics);
        this.dragTrail = [];
        if (vel) {
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              this.pet.id +
              ' release vx=' +
              Math.round(vel.vx) +
              ' vy=' +
              Math.round(vel.vy) +
              ' |v|=' +
              Math.round(Math.hypot(vel.vx, vel.vy)),
          );
          this.startThrow(px, py, vel.vx, vel.vy);
        } else {
          // customPos 语义 = 宠物中心的比例（position() 用 rx*W - halfW 还原左上角），松手无边界夹取
          this.customPos = { rx: (px + this.halfW) / VIEW.w, ry: (py + this.halfH) / VIEW.h };
          this.position();
          // 释放后的最终窗口位置：冒烟断言「释放不位移」用
          window.__dshPetDebug.lastDragRelease = { x: this.pos.x, y: this.pos.y };
        }
      }
    }
  }

  /**
   * 本窗口是否必须保持可交互（= 我正在用这个窗口的鼠标输入）。
   *
   * 来源是拖拽中 / 右键菜单开着 / 对话弹窗开着（外加可点的余额气泡）：它们都靠窗口级鼠标事件驱动，
   * 窗口一变回穿透输入链就断（拖拽定格、松手也没人报 pointerup）。
   * 这是渲染端专有的知识，主进程无从推断；同时上报控件矩形，菜单/聊天框外仍继续穿透。
   */
  inputBusy() {
    // 可点的余额气泡是第四个来源：它长在窗口里、靠窗口级 click 触发，却悬在平时穿透的余量区，
    // 正需要借 busy + 控件矩形把它圈出来。
    return this.dragState.active || this.menuOpen || this.chatOpen || this.balanceClickable();
  }

  /** 余额气泡当前有几页：custom 取 views.length；内置 windows 是收起/展开两页；其余一页。 */
  balancePageCount() {
    const s = this.balanceState;
    if (!s || !s.ok) return 1;
    if (s.shape === 'custom') {
      const views = S.customViews(s);
      return views ? Math.max(1, views.length) : 1;
    }
    return s.shape === 'windows' ? 2 : 1;
  }

  /** 余额气泡此刻是否可点切页：页数多于 1 且气泡正在显示。 */
  balanceClickable() {
    if (!this.bubbleOn || this.balanceWrap) return false;
    return this.balancePageCount() > 1;
  }

  /**
   * 上报一次「要不要保持可交互」。所有状态变化点都走这里（幂等，值没变不发 IPC）。
   * 与 setInteractive 的分工：后者表达光标在不在身体上，本方法表达我有没有在用输入（优先级更高）。
   */
  syncInputBusy() {
    this.syncMargin(); // 菜单/对话窗开关会改余量（它们要地方），与 busy 同源
    this.syncInputRegions();
    const busy = this.inputBusy();
    if (busy === this._inputBusy) return;
    this._inputBusy = busy;
    window.__dshPetDebug.inputBusy = busy;
    if (window.petBridge) window.petBridge.setInputBusy(busy);
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
   * @param mg 理想余量
   * @returns 夹取后的余量
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
   * 气泡只往上长（按气泡相对主体盒的真实溢出量补）。所有分支都过 clampMarginToSpace。
   * @returns {{l:number,t:number,r:number,b:number}} 余量（CSS 像素）
   */
  desiredMargin() {
    const pad = IDLE_MARGIN_PX;
    const m = this.size * WINDOW_MARGIN_RATIO;
    const fontConf = this.pet.font || config.font || S.DEFAULT_FONT;
    // ① 菜单 / 对话窗：四边都要地方（它们是交互态，此刻宠物不必贴边）
    if (this.needsRoom()) {
      const r = Math.max(m, MENU_ROOM_PX);
      return this.clampMarginToSpace({ t: Math.max(r, S.bubbleTopMarginPx(fontConf, this.size)), r, b: r, l: r });
    }
    // ② 只有气泡：按气泡**相对主体盒的溢出量**补余量（气泡靠上、可能比身体宽）
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
    // ③ 空闲：窗口≈主体盒
    return { l: pad, t: pad, r: pad, b: pad };
  }

  /** 是否正有"长在余量里"的覆盖层需要空间（右键菜单 / 对话窗）。 */
  needsRoom() {
    return !!(this.menuOpen || this.chatOpen);
  }

  /** 菜单刚开（宽限期内）：此时 blur / mouseleave 多半是本进程改窗口尺寸/形状引起的，不该据此关菜单 */
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
   * 上报窗口形状（Linux `shape` 输入模型，见 main.js 的 INPUT_MODE）。
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

  syncInputRegions() {
    this.syncShape(); // 形状与控件矩形同源：覆盖层一出现就得一起更新（见 syncShape）
    if (!window.petBridge || !window.petBridge.setInputRegions) return;
    const rects = [];
    // 控件矩形 = 主进程允许接收点击的区域，矩形外继续穿透。可点的余额气泡悬在余量区，不登记就点不到。
    const controls = [...document.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat, .pet-bubble.is-clickable')];
    for (const el of this.inputRegionElements) {
      if (!controls.includes(el)) {
        this.inputRegionResize.unobserve(el);
        this.inputRegionElements.delete(el);
      }
    }
    for (const el of controls) {
      if (!this.inputRegionElements.has(el)) {
        this.inputRegionElements.add(el);
        this.inputRegionResize.observe(el);
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        rects.push({ x: toScreen(r.x), y: toScreen(r.y), width: toScreen(r.width), height: toScreen(r.height) });
      }
    }
    const input = { dragging: this.dragState.active, rects };
    const key = JSON.stringify(input);
    if (key === this._inputRegions) return;
    this._inputRegions = key;
    window.petBridge.setInputRegions(input);
  }

  setInteractive(flag) {
    const next = !!flag;
    if (next === this._interactive) return; // 只在状态变化时发 IPC，避免逐帧刷屏
    this._interactive = next;
    window.__dshPetDebug.interactive = next;
    if (window.petBridge) window.petBridge.setInteractive(next);
  }

  /**
   * 悬浮提示显隐。
   *
   * 由 onMouseMove 的「光标在不在身体命中区」驱动，而不是 pointerenter/leave：身体外整窗穿透，
   * 光标离开身体时 pointerleave 未必派发，提示会赖在屏幕上不走；几何判定与穿透翻转同源才只有一种口径。
   */
  setTip(on) {
    const next = !!on;
    if (next === this.tipOn) return;
    this.tipOn = next;
    this.renderTip();
    this.syncShape(); // 提示在窗口形状之外就看不见：显示/收起都要同步形状
  }

  /**
   * 悬浮提示渲染：文本 = 宠物显示名（宿主已保证非空）；位置 = 光标右下（装不下自动翻边），
   * 摆位判据与浏览器端共用 shared 的 tooltipPlacement。
   *
   * 光标存的是视口坐标，而提示是 position:fixed、DOM 坐标相对窗口，所以这里减掉窗口原点。
   * 存视口坐标而非窗口坐标，是因为窗口会随宠物移动：只在这里按当前原点重算一次，贴光标不会漂。
   */
  renderTip() {
    if (this.tip.textContent !== this.pet.name) this.tip.textContent = this.pet.name;
    const cursor = this.tipCursor;
    if (cursor) {
      const wr = this.winRect();
      const winX = wr.x;
      const winY = wr.y;
      const winW = wr.w;
      const winH = wr.h;
      // 允许显示范围 = 窗口 ∩ 光标所在屏的工作区：只按窗口夹会画到屏幕外，只按工作区夹会落到
      // 窗口外（html/body 是 overflow:hidden，一样看不见）。
      const area = S.resolveRect(WORK_AREAS, cursor.x, cursor.y) ?? { x: winX, y: winY, width: winW, height: winH };
      const x0 = Math.max(winX, area.x);
      const y0 = Math.max(winY, area.y);
      const x1 = Math.min(winX + winW, area.x + area.width);
      const y1 = Math.min(winY + winH, area.y + area.height);
      const p = S.tooltipPlacement(
        { x: cursor.x - winX, y: cursor.y - winY },
        { w: this.tip.offsetWidth, h: this.tip.offsetHeight },
        { x: x0 - winX, y: y0 - winY, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
        this.size * S.TOOLTIP_GAP_RATIO,
      );
      this.tip.style.left = p.x + 'px';
      this.tip.style.top = p.y + 'px';
    }
    this.tip.classList.toggle('is-on', this.tipOn);
    window.__dshPetDebug.tooltipOn = this.tipOn;
  }

  onMouseMove(e) {
    // 拖拽态下所有按键已松开：说明 pointerup/pointercancel/lostpointercapture 全丢了，
    // 就地按松手收尾，否则 dragState.active 与 inputBusy 永久为 true（穿透永不恢复）。
    if (this.dragState.active && e.buttons === 0) {
      this.onPointerUp(e);
      return;
    }
    // 拖拽中窗口逐帧跟随光标，指针相对窗口有帧级抖动——强制保持可交互，绝不翻转（翻转会断拖拽）
    if (this.dragState.active) {
      this.setInteractive(true);
      return;
    }
    // 右键菜单/对话弹窗开启：整窗保持可交互，关闭后恢复命中区判定
    if (this.menuOpen || this.chatOpen) {
      this.syncInputRegions(); // 级联菜单按悬停增减面板，及时更新占用区域
      this.setInteractive(true);
      this.setTip(false); // 菜单/弹窗期间提示让位，不跟浮层抢注意力
      return;
    }
    const r = this.hitRect;
    // forwarded 事件坐标以窗口为原点；转换到 sprite 坐标要扣减窗口余量。异常时退回屏幕坐标推导：
    // ÷scale 后减去窗口屏幕原点即窗口内坐标（hitRect/pos 均为 CSS 系）。
    const wx = Number.isFinite(e.clientX)
      ? e.clientX
      : toLocal(e.screenX) - (this.pos.x + this.body.x + VIEW.x - this.margin.l);
    const wy = Number.isFinite(e.clientY)
      ? e.clientY
      : toLocal(e.screenY) - (this.pos.y + this.body.y + VIEW.y - this.margin.t);
    const px = wx - (this.margin.l - this.body.x);
    const py = wy - (this.margin.t - this.body.y);
    const inBody = px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    // 光标存视口坐标（窗口原点 + 窗口内坐标）：窗口随宠物移动时贴光标不会漂。必须在 setTip 之前
    // 更新——setTip 变显隐时会立刻渲染一次，晚一步就会用上一次的光标摆位。
    if (inBody)
      this.tipCursor = {
        x: this.pos.x + this.body.x - this.margin.l + wx,
        y: this.pos.y + this.body.y - this.margin.t + wy,
      };
    this.setInteractive(inBody);
    // 悬浮提示与可交互判定同源（同一个 inBody）：进身体出现，离开收起
    this.setTip(inBody);
    // 跟随光标：位置依赖光标，每次移动都要重摆（setTip 只在显隐变化时渲染）
    if (this.tipOn) this.renderTip();
  }

  onClick(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged) return;
    // Ctrl（macOS 为 Cmd）+ 左键 = 呼出 DSH：与菜单「打开网站」同一动作，只是快捷键——
    // 不播点击动画、也不参与积分，避免「摸一下宠物」变成「开窗口」。
    if (isOpenShortcut(e)) {
      this.stopThrow();
      this.stopMove();
      if (window.petBridge) window.petBridge.openDshSite(ORIGIN);
      return;
    }
    // 积分判定已在 onPointerDown（按下即触发）完成：已触发过就只收手停住，不再播普通点击动画
    if (this.pressScoreFired) {
      this.pressScoreFired = false;
      this.stopThrow();
      this.stopMove();
      return;
    }
    this.stopThrow(); // 点击飞行中的宠物 = 收手停住（再播点击回应）
    this.stopMove();
    // 点击音效与浏览器同位置：放在「按下已触发积分」的早退之后、点击动画判断之前
    playClickSound();
    if (!this.animations.clicks.length) return;
    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）
    this.playOnce(S.pick(this.animations.clicks));
  }

  // 右键菜单（统一自绘组件：树与渲染都来自 shared-core 的同一份 menu 模块）
  // 菜单/弹窗可视矩形（窗口局部坐标）= 窗口 ∩ 工作区：宠物贴边时外扩余量伸出屏幕，窗口内固定定位的
  // 菜单会走进被屏幕裁掉的部分。把菜单约束到这个矩形内即可完整显示，窗口与宠物零移动；
  // 退化（可视区过小/窗口整体出屏）返回 null，调用方按窗口视口兜底。
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

  onContextMenu(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged || this.menuOpen) return;
    e.preventDefault();
    this.stopThrow(); // 菜单弹出前停住飞行中的宠物
    this.stopMove(); // 菜单悬停期间宠物不漫游
    // 桌面专属工具根项 + 共享菜单树（动作 → 分类 → 具体动画）。碎碎念/对话无条件显示：手动触发
    // 不受 whisperEnabled 限制（该字段只影响自动轮询）。首项文案随宿主形态变：桌面宿主说「打开软件」。
    const tools = [
      {
        label: OPEN_TARGET === 'desktop' ? '打开软件' : '打开网站',
        action: 'open-site',
        hint: OPEN_SHORTCUT_HINT,
      },
    ];
    // 「查看余额」无条件显示：关了 balanceEnabled 的宠物也能点，手动请求不受开关限制，点了一定给答复。
    tools.push({ label: '查看余额', action: 'show-balance' });
    tools.push(
      { label: '碎碎念', action: 'whisper' },
      { label: '对话', action: 'chat' },
      { label: '回到初始位置', action: 'home' },
      // 显示位置（仅网页/仅桌面/两者/都不）：改这只宠物的 display 配置，由宿主重载生效。
      // 与浏览器端注入同一份子菜单，两端文案与取值不会漂移。不就地开关窗：窗口是进程启动时按
      // DSH_PET_PETS 一次性建的，就地增删既改不了磁盘配置也改不了窗口数量。
      S.displayMenuBranch(),
      // 重载配置：请宿主重启桌面 Helper，全部窗口按最新配置重建。放在最后——它是维护动作。
      { label: '重载配置', action: 'reload' },
    );
    // 第三方菜单项统一收在「更多」下：0 项不出现；某个 owner 只有 1 项时跳过 owner 那层直接平铺。
    // 放在整棵动作树之后——「更多」不插在工具项与动作之间。
    const more = S.buildMoreBranch(this.menuItems);
    const tree = tools.concat(S.buildMenuTree(this.animations), more ? [more] : []);
    if (!tree.length) return;
    this._marginBeforeMenu = { l: this.margin.l, t: this.margin.t };
    this.menuOpen = true;
    this.menuOpenedAt = performance.now(); // 宽限期起点：改窗口尺寸引发的 blur/leave 不算数
    this.setInteractive(true); // 菜单是窗口内 DOM：悬停期间整窗保持可交互，关闭后恢复命中区穿透
    this.syncInputBusy();
    // 开菜单会让余量变大，窗口原点随之左移/上移；e.clientX/Y 是**旧窗口**的坐标，
    // 必须按余量差补偿，否则菜单整体错位、还会跳一下（见 syncMargin）。
    const mDx = this.margin.l - this._marginBeforeMenu.l;
    const mDy = this.margin.t - this._marginBeforeMenu.t;
    window.__dshPetDebug.menuOpen = true;
    const m = S.mountContextMenu({
      tree,
      x: e.clientX + mDx,
      y: e.clientY + mDy,
      // 只允许在「窗口 ∩ 工作区」内显示：宠物贴边时外扩余量伸出屏幕，菜单走进那里会被 OS 裁掉
      clamp: this.visibleClampRect(),
      onAction: (leaf) => this.onMenuAction(leaf),
      // 菜单被点外/Esc 关闭（非菜单项路径）：同样复位可交互标记，恢复命中区判定
      onClose: () => {
        this.menuOpen = false;
        window.__dshPetDebug.menuOpen = false;
        this.syncInputBusy();
        if (!this.inputBusy()) this.setInteractive(false);
      },
    });
    this.menuClose = m.close;
    this.syncInputRegions(); // mountContextMenu 完成布局后才能读取菜单矩形
  }

  /** keepFacing = 调用方已显式指定朝向：跳过下面「文字类动画点播前强制朝左」的镜像修正，显式值优先。 */
  onMenuAction(leaf, keepFacing) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    if (leaf.action === 'third-party') {
      // 第三方菜单项：只把 (owner, label) 交给宿主，具体做什么由注册方自己查 /menu/events。
      // 带上宠物 id——同一条菜单项在不同宠物上被点，注册方要能分辨是哪只。
      if (leaf.owner) {
        S.postAction(BASE + '/menu/click', { owner: leaf.owner, label: leaf.label, pet: this.pet.id }).catch(() => {
          /* 上报失败不影响本地：注册方下次轮询自然拿不到这次触发 */
        });
      }
      return;
    }
    if (leaf.action === 'open-site') {
      if (window.petBridge) window.petBridge.openDshSite(ORIGIN); // 系统默认浏览器打开（等效 Ctrl+点击链接）
      return;
    }
    if (leaf.action === 'show-balance') {
      this.showBalanceFromMenu(); // 立即拉余额并展示（无需等 1s 触发轮询，展示路径与周期触发一致）
      return;
    }
    if (leaf.action === 'whisper') {
      this.showWhisperFromMenu(); // 立即让 host 强制新生成一句并展示（绕过节流；展示路径与周期触发一致）
      return;
    }
    if (leaf.action === 'chat') {
      this.showChatFromMenu(); // 打开对话弹窗（记忆经 host /chat 读写，浏览器/桌面同一实例共享）
      return;
    }
    if (leaf.action === 'home') {
      this.goHome(); // 停漫游/移动，清会话位置，回配置角落
      return;
    }
    if (leaf.action === 'set-display') {
      this.setPetDisplay(leaf.display); // 改这只宠物的显示位置：写 display 配置，由宿主重载生效
      return;
    }
    if (leaf.action === 'reload') {
      this.reloadDesktop(); // 请宿主重启桌面 Helper：全部桌面宠物窗口按最新配置重建
      return;
    }
    if (!leaf.anim) return;
    // 回执归属：这一段若来自第三方点播，编号跟着换源走（自播动画传 null）
    const playbackId = typeof leaf.playbackId === 'string' && leaf.playbackId ? leaf.playbackId : null;
    // 文字类（noMirror）朝右是镜像的：点播前强制朝左，避免文字镜像。keepFacing 时跳过（显式值优先）。
    if (!keepFacing && S.isNoMirrorAnimation(this.animations.categories, leaf.anim) && this.facing === 'right') {
      this.facing = 'left';
    }
    // 点播移动动画：走真实移动（与随机游走同一套），只有「选哪个动画」由菜单决定；挪不动则退化纯播放。
    if (this.animations.moves.actions.some((a) => a.name === leaf.anim)) {
      const moved = this.tryMove(leaf.anim, playbackId);
      if (moved === false) this.playOnce(leaf.anim, playbackId);
      // moved === true = 已有移动/抛掷在进行中（没换源）：本段不会真的播起来 → 如实回 failed/busy
      else if (moved === true && playbackId) this.reportPlayback(playbackId, 'failed', 'busy');
      return;
    }
    this.playOnce(leaf.anim, playbackId);
  }

  closeMenu() {
    if (this.menuClose) {
      this.menuClose();
      this.menuClose = null;
    }
    this.menuOpen = false;
    window.__dshPetDebug.menuOpen = false;
    this.syncInputBusy(); // 菜单关：若没有别的占用（拖拽/弹窗）则交还常规判定
    if (!this.inputBusy()) this.setInteractive(false);
  }

  // 「查看余额」菜单：POST 动作让宿主刷新余额。结果这里什么都不用做——写叶子会让版本号变，
  // 挂着的长轮询那一拍立刻返回并展示（同一展示路径）。数据只有一个出口（S），菜单只负责让它刷新。
  // 不做 balanceEnabled 门控：手动请求不受开关限制，关了余额的宠物被点一次也该看到数据。
  showBalanceFromMenu() {
    S.postAction(BALANCE_URL)
      .then((ok) => {
        if (!ok) console.warn('[dsh-pet] 菜单查看余额：刷新动作未成功');
      })
      .catch((e) => {
        console.error('[dsh-pet] 菜单查看余额异常', e);
      });
  }

  // 「碎碎念」菜单：POST 动作让宿主立即新生成一句（写进 S）。动作不回文本，文本随版本号变化由
  // 挂着的长轮询送达。手动触发不受 whisperEnabled 限制（该字段只关自动周期）。
  showWhisperFromMenu() {
    // surface 必填：本窗口就是桌面端
    S.postAction(WHISPER_URL + '?pet=' + encodeURIComponent(this.pet.id) + '&surface=desktop')
      .then((ok) => {
        if (!ok) console.warn('[dsh-pet] 菜单碎碎念：生成动作未成功 pet=' + this.pet.id);
      })
      .catch((e) => {
        console.warn('[dsh-pet] 菜单碎碎念异常', e);
      });
  }

  // 「对话」菜单：最简输入框（shared 组件）——回车发送后弹窗消失，回复用碎碎念同款显示（说话动画 +
  // 气泡 10s），只多一步用户输入。记忆经宿主 /chat 读写，同一实例的浏览器与桌面共享。
  // 弹窗跟随身体命中区 this.hit（桌宠在视频中间，视频框右上角 ≠ 宠物右上角），超出视口自动夹回；
  // 弹窗是窗口内 DOM，期间整窗保持可交互，关闭后恢复命中区穿透。
  showChatFromMenu() {
    if (this.chatClose) {
      this.chatClose();
      this.chatClose = null;
      return; // 已开着：先关旧的
    }
    const m = S.mountChatDialog({
      petId: this.pet.id,
      baseUrl: BASE + '/chat',
      surface: 'desktop',
      x: Math.max(4, this.hit.getBoundingClientRect().right + 6),
      y: Math.max(4, this.hit.getBoundingClientRect().top + 6),
      // 弹窗同菜单：只允许在「窗口 ∩ 工作区」内显示，贴边时不被屏幕裁掉
      clamp: this.visibleClampRect(),
      onSent: () => {
        // 发送成功：回复已写进 S → 版本号变 → 挂着的长轮询立刻返回并弹气泡
        console.info('[dsh-pet] 对话已发送 pet=' + this.pet.id);
      },
      onClose: () => {
        this.chatClose = null;
        this.chatOpen = false;
        window.__dshPetDebug.chatOpen = false;
        this.syncInputBusy(); // 弹窗关：交还常规判定（菜单还开着的话仍保持忙）
        if (!this.menuOpen) this.setInteractive(false); // 无菜单时恢复命中区穿透
      },
    });
    this.chatClose = m.close;
    this.chatOpen = true; // 穿透守卫：弹窗期间整窗保持可交互
    window.__dshPetDebug.chatOpen = true;
    this.syncInputBusy();
    this.setInteractive(true);
  }

  // 「回到初始位置」菜单：停掉漫游/移动，清掉会话位置，回到配置角落
  goHome() {
    this.stopThrow();
    this.stopMove();
    this.customPos = null;
    this.position();
  }

  // 「重载配置」菜单：请宿主重启桌面 Helper，与设置页「保存」同一条重启路径（宿主 POST /reload →
  // syncDesktop）。不在渲染端就地重拉：窗口数量/display/size 由宿主按 DSH_PET_PETS 建，且全局轮询是
  // 一次性启动的（loopsStarted），就地重建会漏启新循环或留下旧定时器。
  // 本请求由即将被重启的进程发出，响应可能永远不回（宿主杀进程时回调地址已失效），故不 await、
  // 不重试，失败只记日志——重载本身就是把本进程换掉。
  reloadDesktop() {
    fetch(BASE + '/reload', { method: 'POST' }).catch((e) => {
      console.warn('[dsh-pet] 重载配置请求失败（宿主不可达？）', e);
    });
  }

  // 「显示位置」菜单：改这一只宠物的 display，写它自己的配置，再由宿主重载生效。取值直接来自菜单项，
  // 渲染端不做推导（当前状态以配置为准）。不就地开关窗：窗口是进程启动时按 DSH_PET_PETS 一次性建的。
  // 与 reloadDesktop 同一处境：选「仅网页/都不」时本进程会在重载中被换掉，故不 await、不重试。
  setPetDisplay(display) {
    if (!display) return;
    fetch(BASE + '/pet-display', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.pet.id, display }),
    }).catch((e) => {
      console.warn('[dsh-pet] 显示位置请求失败（宿主不可达？）', e);
    });
  }

  /**
   * 自定义节点树 → DOM（custom 形态的渲染器）。
   *
   * tag 与样式白名单在 shared 的解析层已裁过，这里只做映射：不用 innerHTML，文本走 createTextNode，
   * 第三方内容因而没有注入面。样式键是 camelCase，直接赋给 el.style 即可。
   */
  renderTree(node) {
    const el = document.createElement(node.tag);
    if (node.style) {
      for (const [key, value] of Object.entries(node.style)) el.style[key] = value;
    }
    if (node.tag === 'img') {
      el.src = node.src || '';
      el.alt = '';
      return el;
    }
    // 文本与子节点可同时存在：先文本、后子节点（与 textContent + appendChild 的顺序一致）
    if (node.text) el.appendChild(document.createTextNode(node.text));
    for (const child of node.children || []) el.appendChild(this.renderTree(child));
    return el;
  }

  renderBubble() {
    // 气泡单槽：同一时刻只显示一个（优先级：终态任务 > 碎碎念/对话 > 余额 > 非终态任务）。
    // 终态任务不让位：完成/失败气泡只活 10s，被顶掉就彻底看不到；非终态气泡常驻，让位零损失。
    // 工作气泡与碎碎念同款样式（宽度自适应 + 自动换行）；配图标记交给 CSS（带图时取消 min-width）。
    // 图片 URL 与视频同规则：传 BASE 前缀（桌面是 file:// 页面，必须绝对地址），素材根同理。
    const workOn = !!(this.workOn && this.workText);
    const whisperOn = !!(this.whisperOn && this.whisperView);
    const balanceOn = !!(this.bubbleOn && this.balanceView);
    const workTerminal = this.workState === 'success' || this.workState === 'error';
    const slot =
      workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : balanceOn ? 'balance' : workOn ? 'work' : 'none';
    // 配图两种形态二选一：url 用完整地址，image 按素材根拼表情包路径；样式/class 共用。
    const whisperImg =
      slot === 'whisper'
        ? this.whisperUrl
          ? S.createMemeImageFromUrl(this.whisperUrl)
          : S.createMemeImage(this.whisperImage, BASE, this.assetRoot)
        : null;
    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」也套紧凑变体：字号更小、宽度下限更窄，多行说明更紧凑
      slot === 'whisper' || slot === 'work' || (slot === 'balance' && this.balanceWrap),
    );
    this.bubble.classList.toggle(S.MEME_BUBBLE_CLASS, !!whisperImg);
    // 可点/展开两个状态类：可点 → 气泡参与命中区（见 syncInputRegions）；index>0 → 更宽的盒与紧凑字号
    const clickable = slot === 'balance' && this.balanceClickable();
    const expanded = clickable && this.balanceViewIndex > 0;
    this.bubble.classList.toggle('is-clickable', clickable);
    this.bubble.classList.toggle('is-expanded', expanded);
    if (slot === 'none') {
      // 三者都没有可显示的内容：隐藏（不占位，也就不会挡住任何一层）
      this.bubble.classList.remove('is-on');
      window.__dshPetDebug.lastBubbleTitle = '';
      this.syncInputBusy(); // 气泡没了 → 撤销它的控件矩形与 busy 标记（否则整窗还留着可点区域）
      return;
    }
    this.bubble.innerHTML = '';
    if (slot === 'work') {
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.workText;
      this.bubble.appendChild(line);
    } else if (slot === 'whisper') {
      // 配图（shared 生成的 <img> + 共用样式）：先看图再读话
      if (whisperImg) this.bubble.appendChild(whisperImg);
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.whisperView[0]?.text ?? '';
      this.bubble.appendChild(line);
    } else if (this.balanceState && S.customViews(this.balanceState)) {
      // custom 形态：第三方自己的节点树。页索引取当前页；页数变少时夹到最后一页，不显示残页。
      const views = S.customViews(this.balanceState);
      const page = views[Math.min(this.balanceViewIndex, views.length - 1)];
      if (page) this.bubble.appendChild(this.renderTree(page));
    } else {
      // 展开态的行在这里现算：renderBubble 是只读渲染路径，不缓存（余额每轮都在变，缓存反而要同步失效）
      const rows =
        clickable && this.balanceViewIndex > 0 && this.balanceState
          ? S.balanceDetailView(this.balanceState)
          : this.balanceView;
      const hasTier = rows.some((r) => r.role === 'tier');
      if (hasTier) {
        // deepseek 余额单行：余额（峰/谷）¥x — 档位字着色
        const line = document.createElement('div');
        line.className = 'pet-bub-row';
        for (const r of rows) {
          const span = document.createElement('span');
          if (r.role === 'tier') span.className = 'pet-bub-tier pet-bub-tier-' + r.tier;
          span.textContent = r.text;
          line.appendChild(span);
        }
        this.bubble.appendChild(line);
      } else {
        for (const r of rows) {
          // 展开态一行 = 一个窗口：窗口名 + 进度条 + 已用百分比 + 重置倒计时，四段 flex 同行，条吃剩余宽度。
          if (r.role === 'quota') {
            const row = document.createElement('div');
            row.className = 'pet-bub-quota';
            const label = document.createElement('span');
            label.className = 'pet-bub-quota-label';
            label.textContent = r.label;
            const bar = document.createElement('span');
            bar.className = 'pet-bub-quota-bar';
            const fill = document.createElement('i');
            fill.className = 'pet-bub-quota-fill pet-bub-quota-' + r.tone;
            fill.style.width = Math.max(0, Math.min(100, r.percent)) + '%';
            bar.appendChild(fill);
            const used = document.createElement('span');
            used.className = 'pet-bub-quota-used';
            used.textContent = r.usedText;
            const reset = document.createElement('span');
            reset.className = 'pet-bub-quota-reset';
            reset.textContent = r.resetText;
            row.append(label, bar, used, reset);
            this.bubble.appendChild(row);
            continue;
          }
          const div = document.createElement('div');
          if (r.role === 'error') div.className = 'pet-bub-err';
          else if (r.role === 'sub') div.className = 'pet-bub-row pet-bub-sub';
          else div.className = 'pet-bub-row';
          div.textContent = r.text;
          this.bubble.appendChild(div);
        }
      }
    }
    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
    // 气泡内容/尺寸变了 → 重报控件矩形并同步 busy 标记。这里是所有显隐与换内容的汇聚点。
    this.syncInputBusy();
  }
}
