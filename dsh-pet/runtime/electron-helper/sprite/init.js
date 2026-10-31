/**
 * 构建期初始化：DOM 骨架、事件绑定、各面板与驱动的初值、跨窗碰撞订阅。
 *
 * 只由 constructor 调用一次；运行期的行为在 sprite-playback / sprite-motion / sprite-input。
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * @module dsh-pet/runtime/electron-helper/sprite-init
 */
'use strict';

Object.assign(PetSprite.prototype, {
  initPlayback(pet) {
    // 动画池与权重由拍平层按条目注入（renderer 的 S.flattenConfigPets），条目缺 animations 就是配置不全：
    // 明确报错交给 boot 的红条与 5s 重试，绝不回落到没有定义的全局（那只会变成一句 ReferenceError）。
    if (!pet.animations) throw new Error('宠物缺少 animations 段：' + String(pet.id ?? ''));
    this.animations = pet.animations;
    this.weights = pet.animationWeights;
    this.front = 0; // 0 = A, 1 = B
    this.pending = null;
    this.gen = 0;
    this.anim = this.animations.idle[0] ?? '';
    this.once = true;
    // 播放回执：当前正在播的第三方点播编号（null = 自播动画，不上报）。单独一个字段是因为
    // 动画名分不出「这一段该不该上报」——菜单点播与第三方 /anim 可以播同名动画。
    this.playback = null;
    // 朝向走 accessor：赋值即标记实况脏。初始化阶段直接写 `_facing`，避免其它字段就绪前触发上报。
    this._facing = 'left';
    this.poseTimer = null; // 实况上报的节流定时器（见 markPoseDirty）
  },

  /** 拖拽 / 抛掷 / 移动 / 挤压的帧句柄与状态；stop 之前这些只有一份。 */
  initMotion() {
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
    this.moveRef = null;
    this.moveToken = 0;
    this.pendingMove = null;
    this.customPos = null; // 拖拽后的会话内位置（{rx, ry} 比例）；restart 回角落
  },

  /** 菜单、气泡、提示、余额、碎碎念、工作状态、占用锁与对话弹窗的开关状态。 */
  initPanels() {
    // 第三方菜单项（/state 的 sections.menu 快照）：只在右键那一刻拼进菜单，不参与渲染。
    this.menuItems = [];
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
    this.balanceState = null; // 最近一次余额读数（展开态按页现算窗口明细与用量；balanceView 只是收起态的行）
    this.balanceViewIndex = 0; // 当前页：点一下切下一页（windows 是收起 / 窗口明细 / 用量，有用量才有第三页；custom 是 views.length 页）
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
    // 睡觉：sleeping = 此刻处于睡觉态（含「起来」那段过渡），sleepSet = 宿主挑定的三段名，
    // sleepPhase = 当前段（start / loop / end）。阶段由 handleEnded 推进——视频播完只有渲染端知道。
    this.sleeping = false;
    this.sleepSet = null;
    this.sleepPhase = null;
    // 对话弹窗：当前挂载句柄（close / startHear / stopHear）+ 开启标记。chatOpen 是穿透守卫——
    // 弹窗是窗口内 DOM，期间整窗保持可交互，否则光标移到输入框就会被 onMouseMove 翻回穿透、点击全被透传。
    this.chatMount = null;
    this.chatOpen = false;
    // 快捷键「按住 M 说话」：按下开录、松手收尾。状态机在 shared（自动重复与失焦都要拦），
    // 本实例只负责把两个键盘事件原样送进去，动作落到 menu 的 startHearChat / stopHearChat。
    // 闸门两条：鼠标在宠物身上，或光标还在宠物自己的弹窗里——弹窗一开焦点就在输入框，
    // 那时恰恰是最想按住说话的时候（判定不看焦点，开录时由 chat/dom 把输入框 blur 掉）。
    this.hearHold = S.createHearHold({
      isArmed: () =>
        Boolean(this.hoverBody) || Boolean(this.chatMount && this.chatMount.el.contains(document.activeElement)),
      onPress: () => this.startHearChat(),
      onRelease: () => this.stopHearChat(),
    });
    // 待办面板：与对话弹窗同一套穿透守卫（面板同样是窗口内 DOM，而且比对话窗更大）。
    // todoPanel 是面板句柄（占气泡槽，节点塞在 this.bubble 里），todoOpen 是穿透守卫标记。
    this.todoPanel = null;
    this.todoOpen = false;
  },

  /** 建 DOM 并把首帧位置落到窗口；布局数值全部来自上面算好的 geometry。 */
  buildDom() {
    // DOM：sprite 钉在窗口内 (margin.l, margin.t)；宠物"位置"= sprite 位置，窗口随余量外扩
    this.el = document.createElement('div');
    this.el.className = 'pet-sprite';
    this.el.style.left = this.margin.l + 'px';
    this.el.style.top = this.margin.t + 'px';
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
  },

  /** 绑定指针、窗口与碰撞广播；一次性 AbortController 在 dispose 里统一取消。 */
  bindEvents() {
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
    // 拖一张图到宠物身上：直接开对话并挂成待发送图（浏览器端同一套判据）
    this.hit.addEventListener('dragover', (e) => this.onDragOverImage(e), { signal: ac.signal });
    this.hit.addEventListener('drop', (e) => this.onDropImage(e), { signal: ac.signal });
    // 悬停时按键：L 开对话、按住 M 说话、D 开关待办、S 切换睡/醒。
    // 窗口未被聚焦时收不到按键（透明窗用 showInactive 显示，不抢焦点）
    window.addEventListener('keydown', (e) => this.onHotkey(e), { signal: ac.signal });
    // 按住说话靠 keyup 收尾：这条必须在按住期间一直有效，与 keydown 同一生命周期
    window.addEventListener('keyup', (e) => this.onHotkeyUp(e), { signal: ac.signal });
    // 文本输入拿到焦点时补一次系统键盘焦点：X11/KWin 不会因为 DOM 聚焦就把键盘焦点给窗口，
    // 不补的话光标在闪、按键却落到上一个窗口。判据复用 shared 的 isTypingTarget，
    // 对话弹窗与待办面板都是窗口内 DOM，一处委托全覆盖。
    document.addEventListener(
      'focusin',
      (e) => {
        if (S.isTypingTarget(e.target) && window.petBridge && window.petBridge.requestKeyboardFocus) {
          window.petBridge.requestKeyboardFocus();
        }
      },
      { signal: ac.signal },
    );
    // 点击穿透：窗口默认整窗穿透，光标进出身体命中区时翻转可交互；穿透期间 mousemove 由主进程
    // 转发进来（forward:true），mouseleave 保证光标离开窗口立即恢复穿透。
    window.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal: ac.signal });
    window.addEventListener(
      'blur',
      () => {
        // 切到其它应用后旧菜单不该继续占着透明窗口；丢失松手时也释放拖拽。
        this.closeMenu();
        // 切走时松手收不到 keyup：不在这里收尾，录音会一直开到 24 秒上限
        this.hearHold.release();
        if (this.dragState.active) this.onPointerUp();
        if (!this.chatOpen && !this.todoOpen) this.setInteractive(false);
      },
      { signal: ac.signal },
    );
    window.addEventListener(
      'mouseleave',
      () => {
        // 光标离开窗口：菜单若开着立刻收起（窗口内 DOM，离开即不可达），再恢复穿透。
        // 拖拽中与对话弹窗开着都不恢复：前者会绕过 busy 并丢失 pointerup，后者要留光标回来点输入框。
        this.closeMenu();
        if (!this.chatOpen && !this.todoOpen && !this.dragState.active) this.setInteractive(false);
      },
      { signal: ac.signal },
    );

    this.subscribeCollision();
  },

  /**
   * 宠物间碰撞（跨窗 broker）：订阅其它宠物状态广播 + 「被撞」事件 → onDeskHit。
   * 退订由窗口销毁自然回收（webContents 销毁后 ipc 事件不再派发），无需显式取消。
   */
  subscribeCollision() {
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
  },
});
