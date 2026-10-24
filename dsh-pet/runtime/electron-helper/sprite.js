/**
 * dsh-pet desktop helper —— 宠物本体（PetSprite 类）。
 *
 * 播放 / 拖拽抛掷 / 跨窗碰撞 / 点击穿透 / 右键菜单 / 聊天弹窗 / 气泡渲染。
 * 事件联动（余额 / 碎碎念 / 广播 / 工作状态）不在此文件——见 events.js。
 * 依赖 constants.js 的全局（CONFIG / VIEW / BASE / S / config / sprites 等），须后加载。
 */
'use strict';

// 左键 + 修饰键 = 「呼出 DSH」的快捷键。Windows / Linux 用 Ctrl；macOS 上 Ctrl+左键是系统右键
//（先触发 contextmenu、拿不到 click），所以改用 Cmd（⌘）。快捷键文案按平台取，判定统一走 isOpenShortcut。
const OPEN_SHORTCUT_HINT = /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Cmd+左键' : 'Ctrl+左键';
/** 本次点击是否按住了「呼出 DSH」的修饰键（Ctrl / Cmd） */
const isOpenShortcut = (e) => !!(e && (e.ctrlKey || e.metaKey));

// ---------- 多宠摆位去重（静态重叠避让） ----------
// 每只桌面宠物是独立进程/窗口，启动有先后，互相不知道对方最终停在哪。跨窗 broker 只负责
// **运动**碰撞（飞行中撞到别人），对「多只配了同一个角落、静止时叠罗汉」无能为力——
// 于是在开机后自检一次：我的配置角落里是否已经站着别的宠物；是则按 petIndex 绕四角轮换，
// 同角落内第 5 只起再沿水平轴级联错开（LAYOUT_GAP 为视觉间距）。
const LAYOUT_CHECK_MS = 1500;
const LAYOUT_GAP = 80;
// 自检撞上飞行/漫游（开机轻推的滑行可长达数秒）时的改期重试总上限：超过则认命
// （broker 的静止轻推仍会保证不重叠，只是不再有漂亮的四角分布）。
const LAYOUT_CHECK_MAX_WAIT = 5000;

// ---------- 点击音效（内置 assets/sound/click-duck.wav） ----------
// 与浏览器端 client/pet.ts 同一套参数：单例 <audio>、音量 0.5、100ms 节流、失败静默。
// 复用素材通道：bridge 模式由主进程取回音频，普通模式仍走 HTTP。
// 自定义协议已声明 stream / bypassCSP，无需另开未经宿主鉴权的 HTTP 请求。
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

// ---------- 单只宠物（行为与浏览器 PetCard 一致；纯逻辑来自 src/shared） ----------
class PetSprite {
  constructor(pet) {
    this.pet = pet; // 这只宠物的配置段（拍平后的成品实例，条目级字段已吹入：动画池/权重/周期）
    // 页面级缩放（main 对窗口 setZoomFactor(CONFIG.scale)，见 DESIGN.md §3.5）统一放大整窗：
    // pet.size 即 CSS 像素基准，**不再手工乘 CONFIG.scale**——固定 px UI（菜单/积分/聊天）
    // 随同一缩放自动恢复 DIP 观感；跨进程交换（bounds/几何/碰撞）由 constants.js 的
    // toScreen/toLocal 收口换算，这里与 shared 组件一样零乘除。
    this.size = pet.size;
    this.height = (this.size * 9) / 16;
    this.halfW = this.size / 2;
    this.halfH = this.height / 2;
    this.bottomPad = (this.size * (9 / 16) * (S.CANVAS_H - S.FEET_Y)) / S.CANVAS_H;
    // 窗口高 = 舞台高 + 脚底垫高（stage 被 translateY(bottomPad) 下移的余量，防底部被窗口裁剪）
    this.winH = this.height + this.bottomPad;
    // 窗口内【可交互区域】= 身体命中区（像素，窗口坐标）。浏览器 overlay 只有 .dsh-pet-hit 是
    // pointer-events:auto（root/stage/气泡全 none）——桌面严格对齐：命中区外含透明像素一律穿透到下层应用。
    // HIT_BOX 是 640×360 舞台坐标：x 按窗口宽缩放；y 除舞台高外还要加 bottomPad（舞台被下移）。
    this.hitRect = {
      x: (S.HIT_BOX.x0 / 640) * this.size,
      y: this.bottomPad + (S.HIT_BOX.y0 / 360) * this.height,
      w: ((S.HIT_BOX.x1 - S.HIT_BOX.x0) / 640) * this.size,
      h: ((S.HIT_BOX.y1 - S.HIT_BOX.y0) / 360) * this.height,
    };
    window.__dshPetDebug.hitRect = this.hitRect;
    // 左右透明边余量（视频盒内宠物身体居中）：让边界按"身体"贴边——宠物能走到屏幕边缘，
    // 但身体永不越界（漫游/拖拽都不会弄丢宠物）。与浏览器 overlay 的 sideAllow 同一套语义。
    this.sideAllow = (S.HIT_BOX.x0 / 640) * this.size;
    window.__dshPetDebug.sideAllow = this.sideAllow;
    // 窗口四周外扩：左右下 = WINDOW_MARGIN_RATIO×宠物尺寸（既有取值，不动）；
    // **上边距按气泡最大高度算**——气泡锚字号、窗口余量锚宠物，两者本就会脱钩：宠物变小
    // （或关掉 followPet 把字号固定）时半只宠物的余量装不下气泡，气泡顶端会被窗口上边缘切掉。
    // 余量是透明且点击穿透的，加高没有副作用（与菜单贴边那类"屏幕裁切"问题是两回事）。
    // 注意：余量自此**不再四边相等**，主进程不能再按「窗口宽/4」反推命中区，故 setBounds 一并上报余量。
    const m = this.size * WINDOW_MARGIN_RATIO;
    const fontConf = pet.font || config.font || S.DEFAULT_FONT;
    this.margin = { t: Math.max(m, S.bubbleTopMarginPx(fontConf, this.size)), r: m, b: m, l: m };
    window.__dshPetDebug.winMargin = this.margin;
    // 宠物包围盒左上角在【工作区】坐标系里的位置（本窗口的位置 = 宠物的位置）
    this.pos = { x: 0, y: 0 };

    // 播放状态（与浏览器同构）
    // 动画池与权重按宠物取：文件宠物（pet/ 目录定义，extra）自带**完整独立**动画池；
    // main 等常规宠物（无 anims 段）用全局 cfg.animations（与浏览器 pet.ts 同一语义）。
    this.animations = pet.animations || cfg.animations;
    this.weights = pet.animationWeights || cfg.animationWeights;
    // 第三方菜单项（/state 的 sections.menu 快照，由 events.js 的 applyMenuLeaf 灌进来）：
    // 只在右键那一刻拼进菜单，不参与渲染。空数组 = 没有第三方项，菜单里不出现「更多」。
    this.menuItems = [];
    // 拖拽抛掷物理参数（顶层全局；拍平已吹入实例，兜底回全局/默认）
    this.physics = pet.physics || config.physics || S.DEFAULT_PHYSICS;
    // 字体（全局一份；拍平已吹入实例，兜底回主条目/默认）：字号按本宠物尺寸算（resolveFontPx），
    // 字体族不在这里用——它是全局变量、由 renderer.js 注入 documentElement。
    // fontConf 已在上面算窗口上边距时取好（上边距要用同一份字号）
    this.font = fontConf;
    // 抛掷锁定在当前屏幕（根字段；拍平已吹入实例，兜底回主条目/默认）：
    // true = 甩出去只在松手时所在那块屏内弹（屏缝当墙），false = 照常跨屏飞行
    this.confineToScreen = pet.confineToScreen === true || config.confineToScreen === true;
    // 素材根按 assetRoot（文件宠物 = 配置文件前缀，多实例共享同一素材目录）或宠物 id 回落
    this.assetRoot = pet.assetRoot || pet.id;
    this.assetBase = BASE + '/thumb/' + encodeURIComponent(this.assetRoot) + '/';
    this.front = 0; // 0 = A, 1 = B
    this.pending = null;
    this.gen = 0;
    this.anim = this.animations.idle[0] ?? '';
    this.once = true;
    // 播放回执（issue #122 第 3 项）：当前正在播的**第三方点播**编号（null = 自播动画，不上报）。
    // 为什么要单独一个字段：this.anim 只是动画名，右键菜单点播与第三方 /anim 可以播同名动画，
    // 光看名字分不出"这一段该不该上报回执"。
    this.playback = null;
    // 朝向走 accessor（见下方 get/set facing）：赋值即标记实况脏，交给节流上报。
    // 构造函数里**直接写 `_facing`**，避免在其它字段就绪前就触发一次上报。
    this._facing = 'left';
    this.poseTimer = null; // 实况上报的节流定时器（见 markPoseDirty）
    // 交互/移动
    this.dragState = { active: false, dragging: false, sx: 0, sy: 0, petX: 0, petY: 0 };
    this.justDragged = false;
    // 上一次**按下**的时刻（0 = 还没记过）：弹弓的判定依据是「两次按下之间隔了多久」。
    // 按下记、按下比——这次按了多久、什么时候松手都不参与判定（见 onPointerDown）。
    this.lastPressAt = 0;
    this._interactive = null; // 已上报的可交互状态（setInteractive 去重用）
    this._inputBusy = null; // 已上报的"正在用输入"状态（syncInputBusy 去重用）
    // 拖拽抛掷物理（与浏览器 pet.ts 同构；纯计算在 shared-core S.*）：
    // 拖拽中弹簧跟随目标（包围盒左上角，工作区 px），松手按指针轨迹估速 → 抛掷（重力+边缘反弹）
    this.dragTrail = []; // 指针轨迹采样（screenX/Y + performance.now()，初速估算用）
    this.dragTarget = null;
    this.dragVel = { vx: 0, vy: 0 };
    this.dragFollow = null; // 弹簧跟随 rAF handle
    this.dragFollowToken = 0;
    this.throwRef = null; // 抛掷 rAF handle
    this.throwToken = 0;
    // 位置指令（POST /position）的跟随 rAF（spring 与 line 共用同一个句柄）：与拖拽跟手分开——
    // 拖拽没有终点（指针一直喂目标），这条有终点，收敛/到点后必须自己收掉，否则 rAF 永远转下去
    this.posFollow = null;
    this.posFollowToken = 0;
    this.space = null; // 抛掷空间（逐屏 AABB）缓存；显示器变化时由 relayout() 置空重建
    // Q 弹挤压（点击回应 / 抛掷落地）：rAF + 待压标记（等新动画成为前台再压，压新首帧）
    this.squashRef = null;
    this.squashToken = 0;
    this.pendingSquash = false;
    this._interactive = null; // 当前可交互状态（null=未定；只在变化时发 IPC，避免逐帧刷屏）
    this.moveRef = null;
    this.moveToken = 0;
    this.pendingMove = null;
    this.customPos = null; // 拖拽后的会话内位置（{rx, ry} 比例）；restart 回角落
    this.userPlaced = false; // customPos 是否来自**用户**操作（拖拽松手/甩抛落定）——
    // 抛掷落定/漫游落点/relayout 拉回也写 customPos，但那是系统驱动的位置，不是用户意图；
    // 摆位避让只尊重 userPlaced 的位置，否则开机轻推的滑行落点会被误判成"用户摆过"而放弃避让。
    this.layoutShifted = false; // 摆位避让：开机自检发现配置角落被占 → 按 petIndex 轮换（见 scheduleLayoutCheck）
    // 右键菜单（统一自绘组件，两端共用同一份：树+渲染均来自 shared-core）
    this.menuOpen = false; // 菜单开启期间强制整窗可交互（悬停菜单不触发穿透翻转）
    this.menuClose = null; // 当前菜单的 close()（打开时挂载，关闭后置空）
    // 余额气泡
    this.bubbleOn = false;
    this.bubbleTimer = null;
    // 悬浮提示（替代原生 title 属性）：显隐 + 最近一次光标位置（**视口坐标**，见 renderTip）
    this.tipOn = false;
    this.tipCursor = null;
    this.balanceView = null;
    this.balanceWrap = false; // true = 当前余额气泡是不可用的「文字说明」（多行，需换行变体）
    this.balanceState = null; // 最近一次余额读数（展开态要用它算三窗口行；balanceView 只是收起态的行）
    this.balanceViewIndex = 0; // 当前页：点一下气泡切下一页（内置 windows 是 收起/展开 两页；custom 是 views.length 页）
    this.balanceFadeTimer = null; // 展开/收起的淡出等待（250ms 后才换内容，避免硬切）
    this.prevTick = 0;
    // 说话（碎碎念 / 命令气泡 / 对话回复三合一）：文本/配图由容器统一轮询 /state 后经
    // showWhisper 送进来，本精灵不再自己轮询（改造前的 whisperLoopTimer / broadcastLoopTimer 已删）
    this.whisperOn = false;
    this.whisperTimer = null;
    this.whisperView = null;
    this.whisperText = '';
    // 配图名称（配置 memes 的键；whisperImageEnabled 开启时由 host 随机抽定，随文本一起来）
    this.whisperImage = '';
    // 配图**地址**（POST /broadcast 的 url 参数；与 whisperImage 二选一，见 showWhisper）。
    // 两种形态由字段名区分，不靠嗅探——地址形态直接用、名称形态才按素材根拼路径。
    this.whisperUrl = '';
    // 工作状态联动（DSH 会话状态）：容器 1s 轮询 /state 递增 workTick → 本宠物按档位播动画+气泡。
    // 气泡单槽优先级 终态任务 > whisper > balance > 非终态任务（见 renderBubble）；
    // workStatusEnabled 未启用时完全免疫（与浏览器一致）
    this.workOn = false;
    this.workTimer = null;
    this.workText = null;
    this.workState = null; // 最近一次工作状态（互动/事件动画播完恢复档位循环用）
    this.prevWorkState = null; // 上一档状态（气泡只在状态变化时点亮/收起，Bug 2）
    this.prevWorkTick = 0;
    // 占用锁（issue #122 第 4 项）：frozen = 本宠物此刻正被第三方占用（与浏览器 PetCard.frozenRef 同义）。
    // lockTimer = 按叶子里的 expiresAt 自己到点解除（宿主侧过期是懒判的，不会推"锁没了"）。
    this.frozen = false;
    this.lockTimer = null;
    // 对话弹窗（shared 组件）：当前挂载的 close() 句柄 + 开启标记
    // （chatOpen 是穿透守卫：弹窗是窗口内 DOM，期间整窗保持可交互，与 menuOpen 同语义——否则
    //   光标移到输入框（不在身体命中区）就会被 onMouseMove 翻回穿透，点击全被透传）
    this.chatClose = null;
    this.chatOpen = false;

    // DOM：sprite 钉在窗口内 (margin.l, margin.t)；宠物"位置"= sprite 位置，窗口随余量外扩
    this.el = document.createElement('div');
    this.el.className = 'pet-sprite';
    this.el.style.left = this.margin.l + 'px';
    this.el.style.top = this.margin.t + 'px';
    this.el.style.setProperty('--pet-size', this.size + 'px');
    // 字号（配置 font）：按本宠物尺寸算好最终 px 注入 —— 气泡与悬浮提示的 CSS 读这两个变量
    // （与浏览器端同一套变量名、同一份换算 S.resolveFontPx，见 shared/fonts.ts）
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
    // 原先这里挂 title（原生系统提示）：已换成自绘浮层，但无障碍名称不能跟着丢
    this.hit.setAttribute('aria-label', this.pet.name);
    this.bubble = document.createElement('div');
    this.bubble.className = 'pet-bubble';
    // 余额气泡可点时：点一下切换展开/收起。内容与显隐都归 renderBubble，这里只做两件事——
    // 就地吞掉事件（别让这次点击落到下面的本体命中层），以及交给 events.js 的 toggleBalanceDetail。
    this.bubble.addEventListener('click', (e) => {
      if (!this.balanceClickable()) return;
      e.stopPropagation();
      e.preventDefault();
      this.toggleBalanceDetail();
    });
    // 悬浮提示：与气泡同处 this.el 内的绝对定位浮层，位置/翻转由 renderTip 决定，
    // 样式走 shared 的 TOOLTIP_CSS（renderer.js 注入，与浏览器端同一份）
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
    // 多宠不叠：等兄弟窗口上电后自检配置角落是否被占（整个会话只此一次）
    this.scheduleLayoutCheck();

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
    // 点击穿透：窗口默认整窗穿透（main 设 setIgnoreMouseEvents(true, {forward:true})），
    // 光标进/出身体命中区时翻转可交互；穿透期间 mousemove 由 main 转发进来（forward:true），
    // mouseleave 保证光标离开窗口立即恢复穿透（透明像素不挡下层应用，与浏览器一致）。
    window.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal: ac.signal });
    window.addEventListener(
      'blur',
      () => {
        // 切到其它应用后旧菜单不应继续占着整个透明窗口；丢失松手时也释放拖拽。
        this.closeMenu();
        if (this.dragState.active) this.onPointerUp();
        if (!this.chatOpen) this.setInteractive(false);
      },
      { signal: ac.signal },
    );
    window.addEventListener(
      'mouseleave',
      () => {
        // 光标离开窗口：菜单若开着立刻收起（菜单是窗口内 DOM，离开即不可达），再恢复穿透。
        // 拖拽中与对话弹窗开着都不恢复：前者会绕过 busy 造成穿透并丢失 pointerup，
        // 后者要留光标回来点输入框。
        this.closeMenu();
        if (!this.chatOpen && !this.dragState.active) this.setInteractive(false);
      },
      { signal: ac.signal },
    );

    // 宠物间碰撞（跨窗 broker）：订阅其它宠物状态广播（碰撞检测用）+ 「被撞」事件 → onDeskHit。
    // 注意：退订由窗口销毁自然回收（webContents 销毁后 ipc 事件不再派发），无需显式取消。
    this.others = {}; // petId -> {x,y,vx,vy,size,bottomPad}（其它宠物的最新状态，来自主进程广播）
    this.sawOverlap = false; // 开机窗口期内是否见过别的宠物压着我的配置角落（锁存，见 noteLayoutOverlap）
    this.layoutCheckDone = false; // 摆位自检已跑过（之后不再锁存，漫游碰撞不触发重摆）
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
            // 碰撞 broker 协议单位是物理像素（与窗口 bounds 一致）：÷scale 进本窗口 CSS 系（§3.5）
            x: toLocal(Number(s && s.x) || 0),
            y: toLocal(Number(s && s.y) || 0),
            vx: toLocal(Number(s && s.vx) || 0),
            vy: toLocal(Number(s && s.vy) || 0),
            size: toLocal(Number(s && s.size) || 0),
            bottomPad: toLocal(Number(s && s.bottomPad) || 0),
          };
        }
        this.others = next;
        this.noteLayoutOverlap();
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

  // 目标包围盒左上角（视口相对坐标）→ 移动窗口：窗口 = sprite + 四周外扩余量
  // （sprite 钉在窗口 (margin.l, margin.t)，气泡/弹窗显示在余量里）。
  // setContentBounds 要**屏幕**坐标：pos 是视口（桌面外接矩形）相对坐标，先加 VIEW.x/y
  // 再统一 ×scale 回物理像素（§3.5 IPC 收口）——主进程收到的数字与线性化旧行为逐位一致，
  // 主进程侧（bounds/去重/碰撞 broker）完全不用改。
  // ---- 实况（位置 + 朝向）上报（issue #122 第 1 条：取得有效实例及其位置、朝向）----
  //
  // 第三方用 `GET /pose` 读桌面端这一份快照。**网页端不走这条路**——它的位置天生每个页面一份
  // （两个标签页本来就不同），走页面内的 Cordis 只读服务 `petApi7340`（见 src/client/pose.ts）；
  // 两边字段名与坐标口径**完全一致**，只是取法不同。
  //
  // 收口设计（0 个额外调用点）：
  //   - 位移：全仓**只有 sendBounds 会调 petBridge.setBounds**，所以只要在它末尾标脏，就覆盖了
  //     全部位移场景（重排/回角落、自主走位、拖拽跟手、抛掷逐帧、/position 三种模式）。
  //   - 朝向：变化**不一定伴随位移**（原地转身），所以用 accessor 让赋值自动标脏。
  //
  // 节流：见 constants.js 的 POSE_THROTTLE_MS（trailing edge，到点读**当前值**推一次）。

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
   * 把当前实况推给宿主（`POST /pose/report`）。**读的是当前值**，所以节流窗口内的连续变化只留下
   * 最后一帧——这正是要的：第三方要的是"现在在哪"，不是中间过程。
   *
   * 坐标与 `POST /position` 同一口径：宠物**中心**的归一化 0~1；桌面端的基准是**所有屏的并集矩形**
   * （VIEW，与 position() 算窗口位置用的是同一套）——不这样读回来的值就喂不回 /position。
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
      // 完整状态一次捎带：size/bottomPad 让静止宠物从首帧起就登记进碰撞站场
      // （此前只有 report-flight 带尺寸，从没飞过的宠物 size=0 被碰撞检测直接跳过）；
      // vx/vy 带当前速度——飞行中实时值、静止/拖拽 = 0，避免落地后残留上次飞行速度干扰碰撞动量。
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
    // 位置变了（宠物漫游/拖拽/飞行，窗口跟着动）：提示若正显示必须重摆一次——它跟的是光标，
    // 而光标存的是视口坐标，窗口一移，光标相对窗口的位置就变了，不重摆提示会跟着窗口漂走。
    // 只在显示时重摆：漫游逐帧调本函数，没显示提示时不做无谓的 DOM 写入。
    if (this.tipOn) this.renderTip();
    // 实况标脏（节流上报，见 markPoseDirty）：所有位移都收口在本函数，所以这里一处就够
    this.markPoseDirty();
  }

  // 角落/边距 → 窗口位置；拖拽后按会话内位置（比例）还原——**松手无任何边界夹取**，
  // 宠物停在哪就算哪（与浏览器一致：可以完全拖出工作区/屏幕；漫游仍有 planMove 边界检查兜底）
  position() {
    const W = VIEW.w;
    const H = VIEW.h;
    let x;
    let y;
    if (this.customPos) {
      x = this.customPos.rx * W - this.halfW;
      y = this.customPos.ry * H - this.halfH;
    } else {
      // 角落取**主屏**而不是外接矩形：不规则多屏布局下外接矩形的角落可能不属于任何显示器
      // （实测右倒 T 型双屏，top-left 落在主屏上方的空洞里），配了该角落的宠物开机即隐身。
      // 摆位避让：角落/边距经 layoutAnchor() 轮换（未触发避让时与配置逐字相同）
      const pos = this.layoutAnchor();
      const anchor = S.anchorPixel({
        corner: pos.corner,
        // marginX/marginY 是配置里的绝对像素：页面级缩放（§3.5）已统一放大整窗，
        // 配置值不再手工乘 CONFIG.scale——150% 屏上与「线性化 + 旧 CONFIG.scale 补偿」观感一致
        marginX: pos.marginX,
        // macOS 顶部边距对齐身体命中盒，扣掉动画画布头顶留白。
        marginY: pos.marginY - (pos.corner.startsWith('top-') ? this.size * CONFIG.topInsetRatio : 0),
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

  /**
   * 初始摆位（无 customPos 时）：默认即配置角落；开机自检发现被别的宠物占着
   * （scheduleLayoutCheck 置 layoutShifted）后，按 petIndex 轮换到空角落——
   * 以配置角落为起点绕四角（BL→BR→TL→TR），第 5 只起同角落内沿水平轴级联错开。
   * 用户拖过的宠物走 customPos 不受影响；「回到初始位置」回到避让后的角落，不会又叠回去。
   */
  layoutAnchor() {
    const base = this.pet.position || {};
    const corner = typeof base.corner === 'string' ? base.corner : 'bottom-left';
    const marginX = Number(base.marginX) || 0;
    const marginY = Number(base.marginY) || 0;
    // 本窗口只承载一只宠物，petIndex 由主进程按 DSH_PET_PETS 顺序注入（renderer.js 用同一个
    // 下标取 pet），因此它就是「桌面可见宠物全量列表」里的序号，轮换直接拿它当轮换下标。
    const idx = Number(CONFIG.petIndex) || 0;
    if (!this.layoutShifted || idx <= 0) return { corner: corner, marginX: marginX, marginY: marginY };
    const order = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
    const start = order.indexOf(corner) >= 0 ? order.indexOf(corner) : 0;
    const rot = order[(start + idx) % 4];
    const intra = Math.floor(idx / 4);
    const dir = rot.endsWith('left') ? 1 : -1;
    return { corner: rot, marginX: marginX + dir * intra * (this.size + LAYOUT_GAP), marginY: marginY };
  }

  /** 我的**配置角落**对应的身体包围盒（即还没被避让改动过的那个角落） */
  configCornerBox() {
    const base = this.pet.position || {};
    const corner = typeof base.corner === 'string' ? base.corner : 'bottom-left';
    const anchor = S.anchorPixel({
      corner: corner,
      marginX: Number(base.marginX) || 0,
      marginY: (Number(base.marginY) || 0) - (corner.startsWith('top-') ? this.size * CONFIG.topInsetRatio : 0),
      size: this.size,
      W: VIEW.w,
      H: VIEW.h,
      area: PRIMARY_AREA || undefined,
    });
    return S.bodyPixelBox({ x: anchor.x, y: anchor.y, size: this.size, bottomPad: this.bottomPad });
  }

  /**
   * 摆位避让自检（开机一次，LAYOUT_CHECK_MS 后）：配置角落里是否已经站着别的宠物。
   * 判定素材 = 碰撞站场广播的其它宠物实时包围盒（this.others，主进程 broker 汇聚，
   * 与跨窗碰撞检测同一份）；只在"真的会叠"时才轮换——用户给不同宠物配了不同角落时
   * 不该被擅自改掉。兄弟窗口各自独立进程、启动有先后：本轮没看到任何人就不判，
   * 后启动的宠物会看到我、由它们自己避让。
   *
   * 为什么判据用"锁存的 sawOverlap"而不是当场重算：静止轻推（broker 的 REST 分支）
   * 比本自检触发得早——状态一对上 broker 就把叠在一起的宠物滑开了，等 1.5s 后自检时
   * 大家早已不重叠，当场重算永远错过。锁存标志在每次广播时更新，第一次广播（此时宠物
   * 还压在配置角落里）就记下"会叠"，自检时照判不误。
   */
  noteLayoutOverlap() {
    if (this.sawOverlap || this.layoutShifted || this.layoutCheckDone) return;
    if (this.customPos && this.userPlaced) return;
    const others = this.others || {};
    const ids = Object.keys(others).filter((pid) => others[pid] && others[pid].size > 0);
    if (ids.length === 0) return;
    const mine = this.configCornerBox();
    this.sawOverlap = ids.some((pid) => {
      const o = others[pid];
      return S.rectsOverlap(mine, S.bodyPixelBox({ x: o.x, y: o.y, size: o.size, bottomPad: o.bottomPad }));
    });
  }

  scheduleLayoutCheck() {
    if (this.layoutShifted) return;
    window.setTimeout(() => this.layoutCheckBody(), LAYOUT_CHECK_MS);
  }

  /** 摆位避让自检体（scheduleLayoutCheck 延时后跑；忙碌时由本体重试） */
  layoutCheckBody() {
    this.layoutCheckDone = true;
    if (this.layoutShifted) return;
    if (this.customPos && this.userPlaced) return;
    if (this.dragState.active || this.menuOpen || this.chatOpen) return;
    if (this.throwRef !== null || this.moveRef !== null) {
      // 位置正被飞行/漫游驱动：改期重试而不是放弃——开机轻推的滑行可长达数秒，
      // 当场放弃等于这一局再也不摆位。最多重试到 LAYOUT_CHECK_MAX_WAIT 后认命。
      // 注意：重试的是**检查体**（500ms 后直接重跑），不是 scheduleLayoutCheck——
      // 后者会重设 LAYOUT_CHECK_MS(1500ms) 定时器，改期节奏会被拖成 2s 一轮。
      this.layoutCheckTries = (this.layoutCheckTries || 0) + 1;
      if (this.layoutCheckTries * 500 >= LAYOUT_CHECK_MAX_WAIT) return;
      this.layoutCheckDone = false;
      window.setTimeout(() => this.layoutCheckBody(), 500);
      return;
    }
    if (!this.sawOverlap) return;
    this.layoutShifted = true;
    this.position();
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
   * 显示器几何变化（改分辨率/缩放、插拔屏、旋转）后就地重挂：
   * 抛掷空间作废，并把宠物从可能变成空洞的位置拉回可见区。
   * 拖拽中不动它（用户正握着，位置由指针决定）；飞行中也不动（下一帧物理自会按新边界夹取）。
   *
   * prevView 是**变化前**的视口原点/尺寸（renderer 在 applyDeskGeometry 之前取）。
   * 宠物位置是「视口相对」坐标，而视口原点会随显示器拓扑平移（外接屏在主屏左侧时合盖，
   * hull 原点从 −2560 变 0）。旧实现直接把旧坐标当新坐标去夹取：宠物被误判越界、夹到最近屏
   * 边缘，夹取后的比例在新拓扑里又不对应原位置 —— 每开合一次漂一次（#193）。这里改由
   * S.rebaseCenter 做「世界坐标守恒 + 越界才夹」，并把比例**无条件**跟着新视口重写。
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
    // customPos 非空 = 用户摆过的位置，语义是「相对视口的比例」：视口变了就必须重写，
    // 否则同一个比例在新视口里是另一个世界坐标。customPos 为空 = 角落模式：没越界就保持
    // 「跟主屏角落」的配置语义，只有真的越界才转成锁定坐标。
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
   * 播放回执上报（issue #122 第 3 项）：把这一段点播的**真实**状态告诉 host。
   *
   * 只对第三方点播（带 playbackId）上报；自播动画（随机链 / 点击 / 拖拽 / 碎碎念 / 余额…）不报。
   * 为什么必须有这一层：host 只知道"受理了"，不知道播没播完——动画在这里播，只有这里知道真相。
   * S.postAction 自带 body 序列化且从不抛异常；再加一层 then 只为留一条排障日志。
   */
  reportPlayback(playbackId, status, reason) {
    if (!playbackId) return;
    const body = reason ? { status, reason } : { status };
    void S.postAction(BASE + '/playback/' + encodeURIComponent(playbackId) + '/report', body).then((ok) => {
      if (!ok) console.warn('[dsh-pet] 播放回执未送达 pet=' + this.pet.id + ' id=' + playbackId + ' status=' + status);
    });
  }

  // 双缓冲切换（与浏览器同一套：前台 opacity 切换 + 降级视频清 handler 并停播，防残留 ended 雪崩）
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
      // 这次点播的目标**本来就在播**（没换源，但确实在播）→ 如实回 playing，
      // 否则调用方只能干等到 timeout（host 对终态幂等，重复上报无害）
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
    // 素材地址两条路（POST /anim 的 url 参数）：url 形态直接用第三方给的**完整地址**——宿主已把
    // scheme 卡在 http/https，这里**不经 bridge、也不拼 BASE**（地址本身就与本页 origin 无关）；
    // name 形态照旧按「素材根 + 名字」拼（名字即文件名）。
    el.src = url || this.assetBase + encodeURIComponent(next) + (S.ANIMATION_EXT || '.webm');
    el.loop = !nextOnce;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = nextOnce ? () => this.handleEnded() : null;
    // 加载兜底（与浏览器 web 端 fetch+blob 的 10s 超时同义）：素材加载失败或卡住时必须释放
    // pending，否则它永久挂起——之后相同目标会被防重分支吞掉、不同目标靠 gen 覆盖，
    // 表现就是"点了没反应"（#62 报告的就是 web 端同一类问题，桌面端此前完全没有兜底）。
    const loadGuard = (why) => {
      if (!this.pending || this.pending.gen !== gen) return;
      this.pending = null;
      console.warn('[dsh-pet] 素材加载失败 pet=' + this.pet.id + ' anim=' + next + '：' + why + '（已释放本次切换）');
      // 播放回执：这一段点播没能播起来 → 如实回 failed（而不是让调用方干等到 timeout）
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
        // 被换下去的那一段若属第三方点播且没播完 → 如实回 cancelled。
        // （"被新点播顶掉"由 host 在受理时直接标记，这里补的是**非点播**打断：
        //   点击 / 拖拽 / 碎碎念 / 余额 / 工作状态 / 空闲回收。）
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
          // 只有 play() 兑现才代表"确实开始出画"（loadeddata 只代表可解码）
          if (playbackId) this.reportPlayback(playbackId, 'playing');
        })
        .catch(() => {
          // 自动播放被拒 / 元素不可播：既有实现静默吞掉 → 现在如实回 failed（不改播放控制）
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

  // 直接播一个**外部地址**（POST /anim 的 url 参数，issue #122 第 1 条）。
  // 为什么单独一个方法、不复用 onMenuAction：那套是菜单语义（文字类先强制朝左的镜像修正、
  // 移动类走真实位移），裸地址没有"是不是文字类 / 是不是移动类"这些属性。这里只做"插播一段"
  // ——停掉漫游/移动，换源播一次，播完由 handleEnded 回到正常动画链（与菜单点一下的 once 同义）。
  // `name` 位置传地址本身：它同时是 pending 的防重键与日志里的标识，地址天然唯一。
  playUrlOnce(url, playbackId) {
    this.stopMove();
    this.playOnce(url, playbackId, url);
  }

  /**
   * 占用锁（issue #122 第 4 项）：冻结 / 解冻。**与浏览器 PetCard.applyFreeze 同构**。
   *
   * 冻结期间只有四件事被挡住，且都在渲染端：① 随机链（playIdle 一句判断）；
   * ② 当前正在播的自播动画（暂停，定在当前帧）；③ **自动**来源的余额与工作状态表现
   * （见 events.js 里 onBalanceTick / onWorkTick / showBalanceNotice 的判断）；
   * ④ **屏上的任务状态气泡**：锁一生效就收掉（见下 applyFreeze）。解冻不补亮——只在下次档位
   * 变化时重新出现（与浏览器 src/client/pet.ts 同一取舍）。
   * 显式指令（say / anim / position / throw 四个叶子）**一概不挡**——那些是持锁者（或用户手动）
   * 明确要的，正是占用要保护的东西。
   */
  applyFreeze(next) {
    if (this.frozen === next) return;
    this.frozen = next;
    const el = this.front === 0 ? this.videoA : this.videoB;
    const stamp = '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + this.pet.id;
    if (next) {
      // 停住正在播的那一段：宿主停不掉一段视频，"完全静止"只能由渲染端执行。
      // 光堵随机链入口不够——那个入口只在动画**播完**时才被调用，不暂停就会把当前这段播完才停。
      this.stopMove();
      if (el) el.pause();
      // 播放回执（issue #122 第 3 项）：冻结**打断了**正在播的那一次第三方点播——如实回
      // `cancelled`，而不是让回执一直挂着 `playing`（挂 `?wait=ended` 的调用方会白等一个 timeout：
      // 这一场永远不会 ended）。为什么是"打断"而不是"暂停"：解冻走的是回 idle / 恢复档位
      // （= 换源顶掉它），**不会把它接回来**，所以它确实不会再播完。
      // 与浏览器 src/client/pet.ts 的 applyFreeze 同一处、同一 reason。
      // 先清 this.playback 再上报：免得后续换源又把它当成"被顶掉"再报一次。
      const interrupted = this.playback;
      if (interrupted) {
        this.playback = null;
        this.reportPlayback(interrupted, 'cancelled', 'frozen');
      }
      // 任务状态气泡：锁一生效就收掉。解冻不补亮——只在下次档位变化时重新出现（与浏览器同一取舍）。
      if (this.workTimer !== null) window.clearTimeout(this.workTimer);
      this.workTimer = null;
      this.workOn = false;
      this.renderBubble();
      console.log(stamp + ' 占用锁生效：冻结（随机链停 + 当前动画暂停 + 任务状态气泡收起）');
      return;
    }
    console.log(stamp + ' 占用锁解除：恢复');
    // 解冻：回到"该播什么就播什么"——非终态工作状态回档位循环，否则回 idle 一次，
    // 播完由 handleEnded 接回随机链（与浏览器同一语义）。
    if (this.resumeWorkStatusAnim()) return;
    if (this.animations.idle.length) this.playOnce(S.pick(this.animations.idle, this.anim));
  }

  /**
   * 锁叶子 → 冻结 / 解冻（`pets.<id>.lock`，见 events.js 的 applyLockLeaf）。
   *
   * `expiresAt` **已经过去** = 没有锁：窗口重载后才拿到一份陈旧叶子时必须这么判，不能只看 locked。
   * 宿主不会到点推一次"锁没了"，所以这里自己定时解除——两端的"到点"因此同源（见 src/host/lock.ts）。
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

  // 动画链（与浏览器 pickNext 语义一致，纯逻辑在 shared）
  playIdle() {
    // 占用锁（issue #122 第 4 项）：锁生效时**不掷骰**。这里是随机链的**唯一**入口（只有动画播完
    // 才会走到），一句判断就把随机动画、随机转向、自主走位一起停住——宠物停在最后一帧，
    // 等持锁者的下一条指令（那走 /anim，不经这里）。与浏览器 pickNext 同一处判断。
    if (this.frozen) return;
    this.stopMove();
    const { animations, animationWeights } = { animations: this.animations, animationWeights: this.weights };
    const roll = Math.random();
    // 宠物固定（pets[].fixedEnabled）：掷骰时把「转向 / 移动」两档权重按 0 算（与浏览器同一份
    // 决策）——随机链不再让宠物自己翻朝向或走开。右键菜单点播与 /anim 接口不走这里，不受影响。
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
        // 已有一场移动进行中（占用）：与浏览器一致，重播当前动画，不另设（绝不重复加载不存在的动作）
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
    // 播放回执：前台视频真的播完了 → 如实回 ended。放在拖拽守卫**之前**：
    // "播完了"是既成事实，拖拽守卫管的是动画链怎么推进，不该影响回执的准确性。
    if (this.playback) {
      const done = this.playback;
      this.playback = null; // 先清再上报：后续链式换源不该把它当成"被打断"
      this.reportPlayback(done, 'ended');
    }
    if (this.dragState.active) return;
    // 占用锁（issue #122 第 4 项）：冻结期间**动画链一律不推进**——事件动画播完就停在最后一帧。
    // 与浏览器 src/client/pet.ts 的 handleEnded 同一处判断、同一原因：下面四条路都会换源播放，
    // 而它们读的是**当前工作状态**（this.workState），跟 workTick 无关，所以 onWorkTick 那道门禁
    // 拦不住它们——③ 事件动画（余额/碎碎念/**说话**）播完恢复档位最容易被撞上：持锁者每投一次
    // 带 anim 的气泡（默认就是 true），说话动画播完就把工作状态动画点回来，冻结形同虚设。
    // 播放回执已经在上面上报，不受这一行影响。
    if (this.frozen) return;
    const { animations } = { animations: this.animations };
    // 事件动画播完：回 idle（与 drag/clicks 同分支，不进随机链）；气泡由定时器自动消失，与动画解耦
    const isEvent = S.isEventAnim(animations.events, this.anim);
    if (isEvent) {
      // 工作状态多候选档位：播完一段自动轮换到下一候选（排除当前段，避免连抽），继续循环——
      // 长时间状态不单段重复（与浏览器 ended 护栏共用同一决策 nextWorkStatusAnim）。
      // 仅非终态档位轮换；终态（success/error）播完一次即结束，绝不轮换续播。单候选档位由
      // loop 无限循环（不触发 ended，不会走到这里）。
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

  // 互动/事件动画播完后恢复 workStatus 档位循环：非终态 → 按当前状态档位重选动画（多候选档内
  // 随机并避开当前段）；终态/空闲 → false 不接管，调用方走原逻辑（回 idle / 随机池，与浏览器一致）。
  resumeWorkStatusAnim() {
    // 占用锁：冻结期间不许由这条路把工作状态动画点回来（与浏览器端同名方法同一道自防）。
    // 它读的是 this.workState（实时状态），跟 workTick 无关——持锁者每投一次带 anim 的气泡，
    // 说话动画播完就会经 handleEnded 走到这里。解冻路径不受影响：applyFreeze(false) 是先置
    // this.frozen = false 再调它。
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

  // ---- 漫游（rAF 驱动，动画首尾各 leadSec/tailSec 秒原地不动；几何在 shared/planMove） ----
  // preferredName 传入时固定使用该动画（右键菜单点播移动动画），否则与随机链一致随机选
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
    // 朝向 → 走路方向：**只看当前 facing**（与浏览器 pet.ts 的 tryMove 同一条）。原式的 XOR 是用来
    // 补"turn 播完 setFacing 异步、紧随的随机链还读到旧 facing"，双端都改成立即同步之后它反而把方向
    // 多翻一次：turn 播完朝右，这里算出 dir=-1，于是镜像朝右、人往左走。故删掉。
    const dir = this.facing === 'right' ? 1 : -1;
    const W = VIEW.w;
    const H = VIEW.h;
    const distScale = this.size / S.PET_REF_WIDTH;
    const cx = this.currentCenterX();
    const cy = this.currentCenterY();
    // 落点按显示器判定：默认走**并集**——能骑缝跨屏走，但走不进外接矩形里的空洞。
    // confineToScreen（设置页「锁定在当前屏幕」）开启时改成只按**宠物现在所在那块屏**判定：
    // 屏缝与空洞一样当墙，越出当前屏的那一步直接取消（planMove 返回 null ⇒ 本次移动不发车）。
    // 与抛掷锁定的差别：抛掷是逐帧物理边界（撞到屏缝会弹回来），漫游是一次性落点规划、没有反弹语义。
    // 宠物被拖到屏外（落在空洞里）时 resolveRect 取最近那块屏，所以锁定态下依然走得动。
    const wanderArea = this.confineToScreen ? S.resolveRect(AREAS, cx, cy) : null;
    const plan = S.planMove({
      cx,
      cy,
      W,
      H,
      dir,
      minDist: mp.minDist * distScale,
      maxDist: mp.maxDist * distScale,
      margin: mp.margin, // 同 position() 的 marginX/marginY：页面级缩放统一放大，配置值不再乘 scale（§3.5）
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
    // 位置指令的弹簧也是一种"自主移动"：任何停走路的地方都该把它一并停掉，否则两套运动系统会
    // 同时改窗口位置（用户拖拽 / 抛掷 / 事件动画 / 菜单点播都会走到这）。
    this.stopPosFollow();
  }

  // ---- 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹；与浏览器 pet.ts 同构）----
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

  /** 停止抛掷（空中被抓/点菜单/回家时立即定格在当前落点）。
   *  同时清速度状态 throwState——否则「抓住后温柔放下」会残留最后一次飞行速度，
   *  静止的宠物点一下就误判为飞行中。点击积分用的飞行动态由 onPointerDown 提前记录。 */
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
    // 边界 = 显示器工作区**并集**：空洞是墙（宠物再也飞不进不可见区域），屏缝不是墙（跨屏弹跳照旧）
    // confineToScreen 开启时改为锁定**松手这一刻所在的那块屏**：屏缝同样当墙，只在目标屏内弹。
    // 锁定屏在抛掷开始时定下、飞行途中不重取；relayout 改了屏数时由 throwStepRegion 退回不锁定。
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
      // 细分积分：弹弓没有速度上限，一帧可能跨过上百 px——不拆会跳过「落地/反弹」那几帧，
      // Q 弹、地面摩擦与 atRest 判定都会漏。普通甩抛每帧位移远小于 SUBSTEP_PX，
      // 这里算出 1 步，与旧实现的单步积分逐位相同。
      const substeps = S.throwSubsteps(state.vx, state.vy, dt);
      let res = S.throwStepRegion(state, dt / substeps, sp, this.physics, lockScreen);
      for (let i = 1; i < substeps && !res.atRest; i++) {
        res = S.throwStepRegion(res, dt / substeps, sp, this.physics, lockScreen);
      }
      state = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
      this.throwState = state;
      // 上报飞行状态（节流 ~30ms）：主进程 broker 汇聚后广播，其它窗口用它做跨窗碰撞检测；
      // broker 协议单位 = 物理像素，这里 ×scale（§3.5 收口）
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
              // 被撞方初速同为 broker 物理像素协议：×scale（§3.5 收口）
              window.petBridge.reportCollide(pid, toScreen(hit.hvx), toScreen(hit.hvy));
            }
            break; // 一帧只处理一次碰撞（避免连锁触发抖动）
          }
        }
      }
      this.sendBounds(res.x, res.y);
      // 落地 Q 弹：只在空中→地面转换帧触发一次，力度随冲击速度（轻落 0.8 ~ 重砸 0.55）。
      // 「地面」是**当前所在屏**的底边——多屏各有各的地面高度
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

  // ---- 位置 / 抛掷指令（POST /position、POST /throw；与浏览器 pet.ts 同构）----
  stopPosFollow() {
    this.posFollowToken++;
    if (this.posFollow !== null) {
      cancelAnimationFrame(this.posFollow);
      this.posFollow = null;
    }
  }

  /**
   * 位置指令：把宠物**中心**挪到归一化坐标 (rx, ry)（与 this.customPos 同一套语义）。
   * `mode` 三选一——`instant` 一帧到位；`spring` 走拖拽那套过阻尼弹簧（S.springStep）；
   * `line` 在 `duration` 毫秒里**直线**走完（`duration <= 0` 等同 instant）。
   * 用户正按着宠物（`dragState.active` 含点击与拖拽）时**整拍丢弃**——手指底下的东西不该跑；
   * 丢弃是静默的（接口早已回过 ok，与浏览器端同一契约）。
   * 归一化空间 = **全部显示器工作区并集的外接矩形**；落点会被夹到 AREAS 并集（空洞不可达）。
   */
  moveToCenter(rx, ry, mode, duration) {
    if (this.dragState.active) return; // 用户交互优先
    this.stopThrow(); // 先显式接管：停掉飞行与走路（stopMove 顺带停掉上一次的位置跟随）
    this.stopMove();
    // 归一化空间是**外接矩形**（VIEW = AREAS 的 hull），不规则布局里含大片不属于任何屏的空洞
    // （实测右倒 T 双屏：hull 的 23.7% 是空洞）。而 position() 在 customPos 分支**零夹取**
    // （原文"松手无任何边界夹取"），不夹的话落进空洞的坐标会把宠物放进看不见的地方。
    // 注意：鼠标拖拽到不了那里**不是因为代码在拦**，而是光标物理上出不去屏幕——所以位置接口
    // 必须自己补这道守卫。判据与 relayout() 完全一致：把**身体中心**夹到 AREAS 并集。
    // 浏览器端 0~1 就是视口、没有空洞，那边不走本函数。
    const c = S.clampPointToRegion(AREAS, rx * VIEW.w, ry * VIEW.h);
    // 夹取后的**比例**才是要写进 customPos 的值：position() 会按它重算窗口位置，
    // 存原始 rx/ry 等于把刚做的夹取撤销掉。
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
      // 直线补间：在**像素空间**插值——按归一化比例插值会把斜线走歪（外接矩形不是正方形）
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
   * 抛掷指令：角度（度，`0` = 正右，逆时针为正）+ 力度倍率 → 初速度，交给 startThrow。
   * 下游（重力 / 反弹 / 地面摩擦 / 落地 Q 弹 / 宠物间碰撞 / 落定写 customPos）全是**既有行为**。
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

  /** Q 弹挤压：前台视频垂直压扁（贴地锚定，transform-origin:bottom）再回弹；
   *  与浏览器同构，曲线在 shared（S.squashScale）。depth = 下压幅度（点击固定 0.55；
   *  落地按冲击速度 S.landingSquash 动态取）。reduce-motion 时跳过。 */
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

  // ---- 点击 vs 拖拽（与浏览器一致：阈值/抓取偏移/释放回循环待机；移动的是窗口） ----
  onPointerDown(e) {
    // 只认左键：右键进入拖拽判定会与右键菜单打架（右键不拖拽，两端一致）
    if (e.button !== 0) return;
    // 占用锁（issue #122 第 4 项）：用户**点了或拖了**这只宠物 = 用户接管，立刻撤掉第三方占用。
    // 这是唯一一处"渲染端 → 宿主"的锁上报——宿主看不见鼠标，而锁在它手里
    // （/lock/release 的 force 形态；桌面端走 bridge，与播放回执 reportPlayback 同一条路）。
    // 先本地解冻再上报：叶子回来还有一次往返，等它会让宠物"点了半天才动"；此刻 frozen 为真说明
    // 确实有锁，所以这次 force 释放必然成功，乐观是安全的。
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
    // 抓取速度日志：stopThrow 之前读，否则飞行速度就没了；静止时记录 0（与浏览器同构）
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
    // 点击积分：**按下瞬间即触发**（不等松开）。读取 stopThrow 之前的飞行速度，
    // 在飞行中且达标 → 立即粒子爆发 + 积分弹窗；pressScoreFired 标记本次按下已触发，
    // 松开的 click 据此不再重复弹、也不再播普通点击动画（与浏览器同构）。
    this.pressScoreFired = false;
    // 修饰键+点击是「呼出 DSH」快捷键（见 onClick）：不弹积分，避免快捷键顺手刷分
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
    // 弹弓：**按下时**记时刻、**按下时**比对——间隔 = 两次按下之间的距离，
    // 因此这次拖了多久、什么时候松手都不影响判定（拖十分钟也早已超出窗口）。
    // 没有「待拉」状态、没有超时清理（见 shared-core 的弹弓换算）。
    const pressNow = performance.now();
    const sling = pressNow - this.lastPressAt < S.SLINGSHOT_DOUBLE_MS;
    this.lastPressAt = sling ? 0 : pressNow; // 命中就清掉，免得连点三下弹两次
    this.hit.classList.add('dragging');
    // 收起悬浮提示：拖拽期间窗口逐帧跟随光标，指针始终在身体内、onMouseMove 的 inBody 恒为真，
    // 不主动收就会让提示跟着宠物一路飘（松开后由 onPointerUp 按指针位置复位）
    this.setTip(false);
    this.stopMove();
    try {
      this.hit.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略捕获失败 */
    }
    // 记录【按下时的指针屏幕坐标】与【按下时的宠物窗口位置】——之后全部用 e.screenX/Y
    // 做增量：指针屏幕坐标与窗口位置无关，不受窗口被逐帧移动影响（window.screenX 会滞后/缓存）。
    // 屏幕坐标是物理像素，除以 CONFIG.scale 进 CSS 系（§3.5）——增量公式两边同一单位。
    this.dragState = {
      active: true,
      dragging: false,
      sx: toLocal(e.screenX),
      sy: toLocal(e.screenY),
      petX: this.pos.x,
      petY: this.pos.y,
    };
    // 拖拽信号（桌面端专有）：主进程的兜底穿透通道按**光标与窗口矩形**判定，而窗口比宠物身体大一圈；
    // 拖拽中宠物滞后于光标，光标可能跑到窗口外→窗口翻回穿透→本窗口收不到 pointermove/pointerup
    // （宠物"飞"出去，见 pointer-target.js）。这里上报"我正在用输入"，主进程据此绝不翻回穿透。
    this.syncInputBusy();
    // 弹弓：把「本次是否拉弓」与按下时的宠物中心（anchorX/Y）补进同一次拖拽状态。
    // 放在上报之后是为了不稀释上面那条源码守卫（它要求 busy 必须在建立状态后紧跟着上报）。
    this.dragState.sling = sling;
    this.dragState.anchorX = this.pos.x + this.halfW;
    this.dragState.anchorY = this.pos.y + this.halfH;
    // 注意：舞台「拍平」（去掉 translateY(bottomPad)）不能在这里做——
    // 纯点击（按下即松开）会让人物瞬移上移再落下。与浏览器一致：只有拖拽超过阈值才拍平。
  }

  onPointerMove(e) {
    const d = this.dragState;
    if (!d.active) return;
    // 阈值判定用屏幕坐标增量（clientX 会随窗口移动而变化，屏幕坐标稳定）；屏幕坐标 ÷scale 进 CSS 系
    const dx = toLocal(e.screenX) - d.sx;
    const dy = toLocal(e.screenY) - d.sy;
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < S.DRAG_THRESHOLD) return;
      d.dragging = true;
      // 真正开始拖拽才把舞台拍平（人物随光标拿起；与浏览器 dragging 语义一致）
      this.stage.style.transform = 'none';
      if (this.animations.drag.length) {
        this.playOnce(S.pick(this.animations.drag));
      }
      this.syncInputBusy(); // 拖拽成立：主进程兜底通道闭嘴（见 inputBusy）
    }
    // 记录指针轨迹（screenX/Y 采样：与视口坐标只差常数偏移，速度一致；初速估算用；÷scale 进 CSS 系）
    const now = performance.now();
    this.dragTrail.push({ t: now, x: toLocal(e.screenX), y: toLocal(e.screenY) });
    this.dragTrail = S.trimTrail(this.dragTrail, now);
    // 弹簧目标 = 按下时的宠物位置 + 指针屏幕增量（窗口怎么动都不影响坐标）——不再硬贴指针，
    // 由 rAF 弹簧跟随逐帧追赶（抹平高频抖动，与浏览器同构）
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
    // 提示复位：点击/拖拽期间收起的悬浮提示，指针仍在命中区内就恢复（与浏览器 handlePointerUp 同一处理）。
    // 用 hitRect 几何判定而不是 getBoundingClientRect：命中区是窗口坐标里的权威几何，与 onMouseMove 同源。
    // 位置有讲究：必须留在 syncInputBusy() 之后——pointer-target.test.ts 只扫本函数开头 400 字符
    // 来找上报调用，插到它前面会把上报挤出窗口（该断言守的是"松手必上报，否则窗口粘在可交互"）。
    if (e && Number.isFinite(e.clientX)) {
      const r = this.hitRect;
      const px = e.clientX - this.margin.l;
      const py = e.clientY - this.margin.t;
      // 先按松手位置更新光标再摆位/显示，否则会重现拖拽前的位置（与浏览器 placeTip 同一处理）
      this.tipCursor = {
        x: this.pos.x - this.margin.l + e.clientX,
        y: this.pos.y - this.margin.t + e.clientY,
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
      // 拖拽松手：workStatus 非终态时恢复状态循环，否则回 idle（与浏览器 handlePointerUp 一致）
      // 修复：旧实现 switchTo(idle,false)（loop=true，ended 永不触发）→ 随机链永远回不来，
      // 永远卡在同一段待机动画；改为 playOnce（once=true）播一遍 → ended → handleEnded → playIdle 随机链
      if (!this.resumeWorkStatusAnim()) {
        if (this.animations.idle.length) this.playOnce(S.pick(this.animations.idle, this.anim));
      }
      // 用户拖拽/甩抛 = 用户意图位置：此后 customPos 带"用户摆过"语义，
      // 开机摆位避让自检见此退出（不再擅自轮换角落）
      this.userPlaced = true;
      // 释放位置 = 弹簧跟随后的实际包围盒左上角（this.pos 实时；不是指针目标——
      // 跟手滞后时落点跟随宠物实际位置，与浏览器 boxPx 同语义）
      const px = this.pos.x;
      const py = this.pos.y;
      if (d.sling) {
        // 弹弓：力度 = **拉距**（与手速无关），方向 = 拉的**反方向**。
        // 拉向量用宠物实际中心算（弹簧跟随有滞后，用户看到的是宠物被拉出去多远）。
        // 之后与甩抛走同一条 startThrow：重力/反弹/摩擦/落地 Q 弹/跨窗互撞/多屏完全复用。
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
        // 初速估算：够快就抛掷（重力+边缘反弹+落地摩擦），否则原地放下
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
          // customPos 语义 = 宠物**中心**比例（position() 用 rx*W - halfW 还原左上角；
          // startThrow 落定也按同一公式存），松手无边界夹取
          this.customPos = { rx: (px + this.halfW) / VIEW.w, ry: (py + this.halfH) / VIEW.h };
          this.position();
          // 释放后的最终窗口位置（position() 换算后，松手无夹取），冒烟断言"释放不位移"用
          window.__dshPetDebug.lastDragRelease = { x: this.pos.x, y: this.pos.y };
        }
      }
    }
  }

  // ---- 点击穿透（严格对齐浏览器：只有身体命中区可交互，透明像素穿透到下层应用） ----
  /**
   * 本窗口是否**必须保持可交互**（= "我正在用这个窗口的鼠标输入"）。
   *
   * 三个来源：拖拽中 / 右键菜单开着 / 对话弹窗开着（外加可点的余额气泡，见下）——它们都是
   * "窗口内的 DOM 或事件链正在被使用"，而它们的输入全部来自**窗口级鼠标事件**
   * （pointermove/pointerup/click）：窗口一旦变回穿透，输入链就断了（拖拽会定格在最后一次采样上，
   * 松手也没人报 pointerup → 宠物按旧速度飞出去）。
   *
   * 这个信号是**渲染端专有的知识**：只有它知道"我正在用输入"，主进程无从推断（光看光标位置和窗口
   * 位移分不清"拖拽跟手"和"漫游/抛掷"）。同时上报控件矩形：菜单/聊天框外的透明区域继续穿透。
   */
  inputBusy() {
    // 可点的余额气泡是第四个来源：它同样长在窗口里、同样靠窗口级 click 触发，而它悬在宠物头顶的
    // 余量区——那一块平时是穿透的，正需要借 busy + 控件矩形把它"圈"出来（见 syncInputRegions）。
    return this.dragState.active || this.menuOpen || this.chatOpen || this.balanceClickable();
  }

  /**
   * 余额气泡当前有几页：custom 取 views.length；内置 windows 是「收起 / 展开」两页；其余一页。
   * 只有一页 = 不可点（点开也没别的内容），气泡继续穿透、不挡页面。
   */
  balancePageCount() {
    const s = this.balanceState;
    if (!s || !s.ok) return 1;
    if (s.shape === 'custom') {
      const views = S.customViews(s);
      return views ? Math.max(1, views.length) : 1;
    }
    return s.shape === 'windows' ? 2 : 1;
  }

  /**
   * 余额气泡此刻是否可点切页：页数多于 1 且气泡正在显示。
   * `custom` 的判定与浏览器 bubble.ts 完全一致（都是"多于 1 页"）。
   */
  balanceClickable() {
    if (!this.bubbleOn || this.balanceWrap) return false;
    return this.balancePageCount() > 1;
  }

  /**
   * 上报一次"要不要保持可交互"。**所有**状态变化点都走这里（幂等：值没变不发 IPC）。
   * 与 setInteractive 的分工：setInteractive 表达"光标在不在身体上"（常规判定），
   * 本方法表达"我有没有在用输入"（优先级更高，覆写常规判定）。
   */
  syncInputBusy() {
    this.syncInputRegions();
    const busy = this.inputBusy();
    if (busy === this._inputBusy) return;
    this._inputBusy = busy;
    window.__dshPetDebug.inputBusy = busy;
    if (window.petBridge) window.petBridge.setInputBusy(busy);
  }

  syncInputRegions() {
    if (!window.petBridge || !window.petBridge.setInputRegions) return;
    const rects = [];
    // 控件矩形 = 主进程允许接收点击的区域（矩形外的余量区继续穿透）。
    // .pet-bubble.is-clickable 是余额气泡的展开态：它悬在宠物头顶的余量区，不登记就点不到。
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
   * 悬浮提示显隐（替代原先挂在命中层 title 上的原生系统提示）。
   *
   * 由 onMouseMove 的「光标在不在身体命中区」驱动，而不是 pointerenter/pointerleave：
   * 身体外整窗是穿透的（main 的 setIgnoreMouseEvents(true, {forward:true})），光标离开身体时
   * pointerleave 未必派发，提示会赖在屏幕上不走；几何判定与点击穿透翻转同源，才不会有第二种口径。
   */
  setTip(on) {
    const next = !!on;
    if (next === this.tipOn) return;
    this.tipOn = next;
    this.renderTip();
  }

  /**
   * 悬浮提示渲染：文本 = 宠物显示名（host 已保证 name = rawName || id，不会空）；
   * 位置 = 光标右下（装不下自动翻边），摆位判据与浏览器端共用 shared 的 tooltipPlacement。
   *
   * 坐标要绕一次：光标存的是**视口坐标**（this.tipCursor），而提示是 position:fixed、
   * DOM 坐标相对**窗口**，所以这里减掉窗口原点（= 宠物包围盒左上角 − 四周余量）。
   * 为什么要存视口坐标而不是窗口坐标：宠物自己走动/被抛出时窗口会移动，存视口坐标就只需
   * 在这里按当前窗口原点重算一次，贴光标不会漂（sendBounds 每帧会调本函数）。
   */
  renderTip() {
    if (this.tip.textContent !== this.pet.name) this.tip.textContent = this.pet.name;
    const cursor = this.tipCursor;
    if (cursor) {
      const winX = this.pos.x - this.margin.l;
      const winY = this.pos.y - this.margin.t;
      const winW = this.size + this.margin.l + this.margin.r;
      const winH = this.winH + this.margin.t + this.margin.b;
      // 允许显示范围 = 窗口 ∩ 光标所在屏的工作区，两者必须取交集：
      // 只按窗口夹，窗口能贴到屏幕外，提示会被画到看不见的地方；只按工作区夹，提示会落到窗口外
      // （index.html 的 html,body 是 overflow:hidden，一样看不见）。
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
    // 拖拽态下所有按键已松开：说明 pointerup/pointercancel/lostpointercapture 全部丢失，
    // 就地按松手收尾，否则 dragState.active 与 inputBusy 永久为 true（穿透永不恢复）。
    if (this.dragState.active && e.buttons === 0) {
      this.onPointerUp(e);
      return;
    }
    // 拖拽中窗口逐帧跟随光标、指针相对窗口坐标会有帧级抖动——强制保持可交互，绝不翻转（翻转会断拖拽）
    if (this.dragState.active) {
      this.setInteractive(true);
      return;
    }
    // 右键菜单/对话弹窗开启：整窗保持可交互（悬停菜单项/点输入框都不触发穿透翻转）；关闭后恢复命中区判定
    if (this.menuOpen || this.chatOpen) {
      this.syncInputRegions(); // 级联菜单按悬停增减面板，及时更新其真实占用区域
      this.setInteractive(true);
      this.setTip(false); // 菜单/弹窗期间提示让位：光标已不在身体上，也不该跟浮层抢注意力
      return;
    }
    const r = this.hitRect;
    // forwarded 事件坐标以窗口为原点（与页坐标一致）；转换到 sprite 坐标需扣减窗口余量；
    // 异常时退回屏幕坐标 − 窗口屏幕位置推导（hitRect/pos 均为 CSS 系）：屏幕坐标 ÷scale 后
    // 减去窗口屏幕原点（CSS 系）即窗口内坐标
    const wx = Number.isFinite(e.clientX) ? e.clientX : toLocal(e.screenX) - (this.pos.x + VIEW.x - this.margin.l);
    const wy = Number.isFinite(e.clientY) ? e.clientY : toLocal(e.screenY) - (this.pos.y + VIEW.y - this.margin.t);
    const px = wx - this.margin.l;
    const py = wy - this.margin.t;
    const inBody = px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    // 光标位置存**视口坐标**（窗口原点 + 窗口内坐标）：窗口随宠物移动时贴光标不会漂，见 renderTip。
    // 必须在 setTip 之前更新：setTip 变显隐时会立刻渲染一次，晚一步就会用上一次的光标摆位。
    if (inBody) this.tipCursor = { x: this.pos.x - this.margin.l + wx, y: this.pos.y - this.margin.t + wy };
    this.setInteractive(inBody);
    // 悬浮提示与可交互判定同源（同一个 inBody）：光标进身体 → 提示出现，离开 → 收起
    this.setTip(inBody);
    // 跟随光标：位置依赖光标，所以每次移动都得重摆一次（setTip 只在显隐变化时才渲染）
    if (this.tipOn) this.renderTip();
  }

  onClick(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged) return;
    // Ctrl（macOS 为 Cmd）+ 左键 = 呼出 DSH：与右键菜单「打开网站 / 打开软件」同一动作
    //（open-site），只是它的快捷键——不播点击动画、也不参与积分，避免"摸一下宠物"变成"开窗口"。
    if (isOpenShortcut(e)) {
      this.stopThrow();
      this.stopMove();
      if (window.petBridge) window.petBridge.openDshSite(ORIGIN);
      return;
    }
    // 积分判定已在 onPointerDown（按下即触发）完成：
    // 本次按下已触发过积分 → 只收手停住、**不**再播普通点击动画（粒子+弹窗即反馈，与浏览器同构）
    if (this.pressScoreFired) {
      this.pressScoreFired = false;
      this.stopThrow();
      this.stopMove();
      return;
    }
    this.stopThrow(); // 点击飞行中的宠物 = 收手停住（再播点击回应）
    this.stopMove();
    // 点击音效：与浏览器端同位置——放在「按下已触发积分」的早退之后、点击动画判断之前
    playClickSound();
    if (!this.animations.clicks.length) return;
    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）
    this.playOnce(S.pick(this.animations.clicks));
  }

  // ---- 右键菜单（统一自绘组件：树+渲染都来自 shared-core 的同一份 menu 模块） ----
  // 菜单/弹窗可视矩形（窗口局部坐标）= 窗口 ∩ 工作区（#41）：宠物贴屏幕底/右时窗口外扩余量
  // 伸出屏幕，窗口内固定定位的菜单/弹窗会走进被屏幕裁掉的部分。把菜单/弹窗约束到这个矩形内
  // 即可完整显示——**窗口和宠物零移动**，不存在跨进程位移竞态，也就不会瞬移闪帧。
  // 退化（可视区过小/窗口整体出屏，光标也点不到宠物）返回 null → 调用方按窗口视口兜底。
  visibleClampRect() {
    // pos 是视口相对坐标，窗口屏幕位置 = pos + VIEW 原点 − 外扩余量（见 sendBounds）；
    // 比较双方都用屏幕坐标（坐标系不混），返回的夹取矩形仍是窗口局部坐标。
    // 夹取用**宠物所在的那块屏**而不是外接矩形：外接矩形含空洞，按它夹菜单会伸进
    // 不属于任何显示器的区域（看不见）；菜单本来也不该跨屏显示。
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

  onContextMenu(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged || this.menuOpen) return;
    e.preventDefault();
    this.stopThrow(); // 菜单弹出前停住飞行中的宠物
    this.stopMove(); // 菜单悬停期间宠物不漫游
    // 桌面专属工具根项（打开网站 / 查看余额 / 碎碎念 / 对话 / 回到初始位置 / 重载配置）+ 共享菜单树（动作→分类→具体动画）
    // 碎碎念/对话项无条件显示：手动触发不受 whisperEnabled 限制（该字段只影响自动周期轮询）
    // 首项文案随宿主形态变（OPEN_TARGET）：宿主是 DSH 桌面应用时点是"唤起桌面应用窗口"，仍叫「打开网站」会误导
    const tools = [
      {
        label: OPEN_TARGET === 'desktop' ? '打开软件' : '打开网站',
        action: 'open-site',
        hint: OPEN_SHORTCUT_HINT,
      },
    ];
    // 「查看余额」无条件显示（与浏览器端一致）：关了 balanceEnabled 的宠物也能点——手动请求不受开关限制
    //（该开关只关自动轮询与档位动画），点了一定给答复。
    tools.push({ label: '查看余额', action: 'show-balance' });
    tools.push(
      { label: '碎碎念', action: 'whisper' },
      { label: '对话', action: 'chat' },
      { label: '回到初始位置', action: 'home' },
      // 显示位置（仅网页/仅桌面/两者/都不）：改这只宠物的 display 配置 + 宿主重载生效。
      // 与浏览器端注入的是**同一份**子菜单（shared 的 displayMenuBranch），两端文案/取值不会漂移。
      // 为什么不就地关窗/开窗：桌面宠物共用一个 Electron 进程，窗口是进程启动时按 DSH_PET_PETS
      // 一次性建的——就地增删窗口既改不了磁盘配置（下次启动又回来）也改不了窗口数量。
      S.displayMenuBranch(),
      // 改配置文件后免去回设置页点保存：请宿主重启桌面 Helper（全部桌面宠物窗口按最新配置重建）。
      // 放在最后：它是"重新加载"这类维护动作，与上面几个宠物互动项语义不同。
      { label: '重载配置', action: 'reload' },
    );
    // 第三方菜单项统一收在「更多」下（与浏览器端同一份拼装函数）：0 项不出现；
    // 某个 owner 只有 1 项时跳过 owner 那层直接平铺（规则见 shared/menu 的 buildMoreBranch）。
    // 放在整棵动作树之后——「更多」是"别的东西"，不插在工具项和动作之间。
    const more = S.buildMoreBranch(this.menuItems);
    const tree = tools.concat(S.buildMenuTree(this.animations), more ? [more] : []);
    if (!tree.length) return;
    this.menuOpen = true;
    this.setInteractive(true); // 菜单是窗口内 DOM：悬停期间整窗保持可交互，关闭后恢复命中区穿透
    this.syncInputBusy();
    window.__dshPetDebug.menuOpen = true;
    const m = S.mountContextMenu({
      tree,
      x: e.clientX,
      y: e.clientY,
      // 只允许在「窗口 ∩ 工作区」内显示：宠物贴边时外扩余量伸出屏幕，菜单走进那里会被 OS 裁掉（#41）
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

  /** `keepFacing` = 调用方已**显式指定**朝向（POST /anim 的 facing）：跳过下面"文字类动画点播前
   *  强制朝左"那条镜像修正——显式值优先。右键菜单点播不传（保持原语义）。 */
  onMenuAction(leaf, keepFacing) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    if (leaf.action === 'third-party') {
      // 第三方菜单项：只把 (owner, label) 交给宿主，具体做什么由注册方自己去查 /menu/events。
      // 带上本窗口的宠物 id——同一条菜单项在不同宠物上被点，注册方要能分辨是哪只。
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
    // 回执归属：这一段动画若来自第三方点播，编号要跟着换源一起走（自播动画传 null）
    const playbackId = typeof leaf.playbackId === 'string' && leaf.playbackId ? leaf.playbackId : null;
    // 文字类（noMirror）朝右站姿是镜像的：点播前强制朝左，避免文字镜像（与浏览器随机链"朝右不选文字"同语义）。
    // `keepFacing` 时跳过：调用方已显式指定朝向，显式值优先（要 right 就给 right，哪怕文字会镜像）。
    if (!keepFacing && S.isNoMirrorAnimation(this.animations.categories, leaf.anim) && this.facing === 'right') {
      this.facing = 'left';
    }
    // 点播移动动画：走真实移动（与随机游走同一套：边界检查 / 随机距离 / leadSec·tailSec / dir），
    // 仅"选哪个动画"由菜单决定；挪不动（false）退化纯播放
    if (this.animations.moves.actions.some((a) => a.name === leaf.anim)) {
      const moved = this.tryMove(leaf.anim, playbackId);
      if (moved === false) this.playOnce(leaf.anim, playbackId);
      // moved === true = 已有移动/抛掷在进行中（tryMove 提前返回，**根本没换源**）：
      // 本段点播不会真的播起来 → 如实回 failed/busy，而不是让调用方干等到 timeout
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

  // 「查看余额」菜单：POST 动作让 host 刷新余额（写进 S）。
  // 结果**这里什么都不用做**：写叶子会让版本号变，挂着的长轮询那一拍立刻返回并展示
  // （展示走 showBalanceNow/showBalanceNotice 同一路径）。
  // 注意这里不再直接拉余额：数据只有一个出口（S），菜单只负责"让它刷新"。
  // **不做 balanceEnabled 门控**（菜单项也无条件显示）：手动请求不受开关限制——开关只关自动轮询与档位动画，
  // 关掉余额的宠物被点一次菜单也该看到数据（与浏览器端一致）。
  showBalanceFromMenu() {
    S.postAction(BALANCE_URL)
      .then((ok) => {
        if (!ok) console.warn('[dsh-pet] 菜单查看余额：刷新动作未成功');
      })
      .catch((e) => {
        console.error('[dsh-pet] 菜单查看余额异常', e);
      });
  }

  // 「碎碎念」菜单：POST 动作让 host 立即新生成一句（写进 S）。
  // 动作不回文本——文本只有一个出口（S），随"版本号变化"唤醒的那一拍长轮询到达并展示。
  // 手动触发不受 whisperEnabled 限制——该字段只关自动周期，手动永远可用。
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

  // 「对话」菜单：最简输入框（shared 组件，与浏览器同一份）——回车发送后弹窗消失，
  // 回复用**碎碎念同款显示**（说话动画 + 白色气泡 10s），只多一步用户输入。
  // 记忆经 host /chat 读写（memory.json，同一实例的浏览器/桌面共享同一份）。
  // 弹窗跟随宠物：基准是**身体命中区** this.hit（与气泡同一定位源——桌宠在视频中间，
  // 视频框右上角 ≠ 宠物右上角），取身体右上角，超出视口自动夹回（窗口右侧外扩区容纳）；
  // 弹窗是窗口内 DOM，期间整窗保持可交互（可点输入框），关闭后恢复命中区穿透。
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
      // 弹窗同菜单：只允许在「窗口 ∩ 工作区」内显示，贴边时不被屏幕裁掉（#41）
      clamp: this.visibleClampRect(),
      onSent: () => {
        // 发送成功：回复已写进 S → 版本号变 → 挂着的长轮询立刻返回并弹气泡（0 延迟）
        console.info('[dsh-pet] 对话已发送 pet=' + this.pet.id);
      },
      onClose: () => {
        this.chatClose = null;
        this.chatOpen = false;
        window.__dshPetDebug.chatOpen = false;
        this.syncInputBusy(); // 弹窗关：交还常规判定（菜单还开着的话仍保持忙，见 inputBusy）
        if (!this.menuOpen) this.setInteractive(false); // 弹窗关了且无菜单：恢复命中区穿透
      },
    });
    this.chatClose = m.close;
    this.chatOpen = true; // 穿透守卫：弹窗期间整窗保持可交互，光标移到输入框不被翻回穿透
    window.__dshPetDebug.chatOpen = true;
    this.syncInputBusy();
    this.setInteractive(true);
  }

  // 「回到初始位置」菜单：停掉漫游/移动，清掉拖拽/漫游留下的会话位置，回到配置角落
  goHome() {
    this.stopThrow();
    this.stopMove();
    this.customPos = null;
    this.userPlaced = false; // 重回"系统摆位"语义：避让可以再次接手
    this.position();
  }

  // 「重载配置」菜单：请宿主重启桌面 Helper —— 与设置页「保存」**同一条**重启路径
  // （宿主 POST /reload → syncDesktop：串行队列 + 等旧进程真正退出再起新的）。
  // 为什么不在渲染端就地重拉配置：① 每只宠物一个窗口是宿主按 DSH_PET_PETS 建的，
  // 就地重拉改不了宠物数量/display/size；② 本页的余额/工作状态等全局轮询是一次性启动的
  // （events.js 的 loopsStarted 门控），就地重建 sprite 会漏启新循环或留下旧定时器。
  // 本请求由**即将被重启的这个进程**发出：响应可能永远不回（宿主杀进程时回调地址已失效），
  // 故不 await、不重试，失败只记日志——重载本身就是把本进程换掉。
  reloadDesktop() {
    fetch(BASE + '/reload', { method: 'POST' }).catch((e) => {
      console.warn('[dsh-pet] 重载配置请求失败（宿主不可达？）', e);
    });
  }

  // 「显示位置」菜单：改**这一只**宠物的 display（仅网页/仅桌面/两者/都不）—— 写它自己的配置，
  // 再由宿主重载生效。取值直接来自菜单项（shared 的 displayMenuBranch），渲染端不做任何推导：
  // 当前状态以配置为准，推导只会多一处可能与真相不符的猜测（旧实现的 both→web 就是这种猜测）。
  // 为什么不在渲染端就地关窗/开窗：桌面宠物共用一个 Electron 进程，窗口是进程启动时按 DSH_PET_PETS
  // 一次性建的——就地增删窗口既改不了磁盘配置（宿主下次重载它又回来），也改不了窗口数量。
  // 与 reloadDesktop 同一处境：选"仅网页/都不"时本进程就会在重载中被换掉，响应可能永远不回
  // （宿主杀进程时回调地址已失效），故不 await、不重试，失败只记日志。
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
   * 自定义节点树 → DOM（custom 形态的渲染器，与浏览器 bubble.ts 的 treeToNodes 一一对应）。
   *
   * tag 与样式白名单在 shared 的解析层（parse.ts）已经裁过，这里只做映射：**不用 innerHTML**，
   * 文本走 createTextNode —— 第三方交来的内容因而没有注入面。
   * 样式键是 camelCase（与 React style 对象同形），直接 `el.style[key] = value` 即可。
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
    // 为什么终态任务不让位：完成/失败气泡只活 10s，被事件顶掉就彻底看不到了；非终态任务气泡
    // 常驻（不设自动收起），让位 10s 零损失。与浏览器 src/client/pet.ts 的单槽优先级同一套。
    // 工作气泡与碎碎念同款弹窗样式：宽度自适应 + 自动换行（is-whisper：正常 white-space、宽随内容）
    // 配图标记交给 CSS：带图时取消 min-width（样式在 shared 的 MEME_BUBBLE_CSS，两端同一份）。
    // 图片 URL 与视频同规则：传 BASE 前缀（桌面是 file:// 页面，必须绝对地址）
    // 素材根同理（配图的归属与动画一致：pet/<素材根>-memes/ 独占 → 用户目录 → 包内）
    const workOn = !!(this.workOn && this.workText);
    const whisperOn = !!(this.whisperOn && this.whisperView);
    const balanceOn = !!(this.bubbleOn && this.balanceView);
    const workTerminal = this.workState === 'success' || this.workState === 'error';
    const slot =
      workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : balanceOn ? 'balance' : workOn ? 'work' : 'none';
    // 配图两种形态二选一（host 判定层保证）：url 直接用那个完整地址，image 按素材根拼表情包路径。
    // 样式/class 两份共用（都在 shared 的 MEME_BUBBLE_CSS），只是 src 的来源不同。
    const whisperImg =
      slot === 'whisper'
        ? this.whisperUrl
          ? S.createMemeImageFromUrl(this.whisperUrl)
          : S.createMemeImage(this.whisperImage, BASE, this.assetRoot)
        : null;
    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」（不可用状态）同样套用紧凑变体：字号更小、宽度下限更窄，多行说明更紧凑
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
      // 配图（shared 生成的 <img> + 共用样式）：先看图再读话，符合"配图"的阅读顺序
      if (whisperImg) this.bubble.appendChild(whisperImg);
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.whisperView[0]?.text ?? '';
      this.bubble.appendChild(line);
    } else if (this.balanceState && S.customViews(this.balanceState)) {
      // custom 形态：第三方自己的节点树（与浏览器 treeToNodes 同一套 tag/样式语义）。
      // 页索引取当前页；页数变少时夹到最后一页，不显示上一轮的残页（与浏览器同一夹取规则）。
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
          // 展开态一行 = 一个窗口：窗口名 + 进度条 + 已用百分比 + 重置倒计时（四段 flex 同行，
          // 条吃剩余宽度，故条长 = 已用比例）。与浏览器 bubble.ts 的 DOM 结构一一对应。
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
    // 气泡内容/尺寸变了 → 重报控件矩形（可点的余额气泡要靠它拿点击），并同步 busy 标记。
    // 这里是所有显隐/换内容的汇聚点，放在这里就不会漏掉任何一条路径。
    this.syncInputBusy();
  }
}
