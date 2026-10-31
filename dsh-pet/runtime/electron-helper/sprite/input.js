/**
 * 指针与命中：按下/移动/抬起、点击、可交互区同步与输入租约上报。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 副作用是 DOM 事件与 IPC（setInteractive / syncInputBusy），不碰播放与运动状态机。
 * @module dsh-pet/runtime/electron-helper/sprite-input
 */
'use strict';

Object.assign(PetSprite.prototype, {
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
    // 记录按下时的指针屏幕坐标与宠物窗口位置：增量全部用 screenX/Y 算——屏幕坐标与窗口位置无关，
    // 不受窗口逐帧移动影响（window.screenX 会滞后/缓存）；物理像素 ÷scale 进 CSS 系。
    this.dragState = {
      active: true,
      dragging: false,
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
  },

  onPointerMove(e) {
    const d = this.dragState;
    if (!d.active) return;
    // 阈值判定用屏幕坐标增量（clientX 会随窗口移动变化，屏幕坐标稳定）；÷scale 进 CSS 系
    const dx = toLocal(e.screenX) - d.sx;
    const dy = toLocal(e.screenY) - d.sy;
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < S.DRAG_THRESHOLD) return;
      d.dragging = true;
      // 真正开始拖拽才把舞台拍平（人物随光标拿起）
      this.stage.style.transform = 'none';
      // 睡觉：位置照常跟手，但不换拖拽动画——睡姿循环整段归睡觉状态机，顶掉就回不来了。
      if (this.animations.drag.length && !this.sleeping) {
        this.playOnce(S.pick(this.animations.drag));
      }
      this.syncInputBusy(); // 拖拽成立：主进程兜底通道闭嘴（见 inputBusy）
    }
    // 记录指针轨迹（screenX/Y 采样，速度一致；初速估算用；÷scale 进 CSS 系）
    const now = performance.now();
    this.dragTrail.push({ t: now, x: toLocal(e.screenX), y: toLocal(e.screenY) });
    this.dragTrail = S.trimTrail(this.dragTrail, now);
    // 弹簧目标 = 按下时的宠物位置 + 指针屏幕增量（窗口怎么动都不影响坐标），由 rAF 逐帧追赶
    this.dragTarget = { x: d.petX + dx, y: d.petY + dy };
    this.startDragFollow();
  },

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
      // 拖拽松手：非终态工作状态恢复档位循环，否则回 idle。必须用 playOnce：switchTo(idle,false)
      // 会 loop 播放、ended 永不触发，随机链就再也回不来。
      // 睡觉：拖拽期间没换过动画、睡姿照播，这里不接回 idle，否则会把睡姿顶掉。
      if (!this.sleeping && !this.resumeWorkStatusAnim()) {
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
  },

  /**
   * 本窗口是否必须保持可交互（= 我正在用这个窗口的鼠标输入）。
   *
   * 来源是拖拽中 / 右键菜单开着 / 对话或待办弹窗开着（外加可点的余额气泡）：它们都靠窗口级鼠标事件驱动，
   * 窗口一变回穿透输入链就断（拖拽定格、松手也没人报 pointerup）。
   * 这是渲染端专有的知识，主进程无从推断；同时上报控件矩形，菜单/聊天框外仍继续穿透。
   */
  inputBusy() {
    // 可点的余额气泡是第四个来源：它长在窗口里、靠窗口级 click 触发，却悬在平时穿透的余量区，
    // 正需要借 busy + 控件矩形把它圈出来。
    return this.dragState.active || this.menuOpen || this.chatOpen || this.todoOpen || this.balanceClickable();
  },

  /** 余额气泡当前有几页：规则归共享层（与每页内容同源），这里只补「还没有结果」的兜底。 */
  balancePageCount() {
    const s = this.balanceState;
    return s ? S.balancePageCount(s) : 1;
  },

  /** 余额气泡此刻是否可点切页：页数多于 1 且气泡正在显示。 */
  balanceClickable() {
    if (!this.bubbleOn || this.balanceWrap) return false;
    return this.balancePageCount() > 1;
  },

  /**
   * 上报一次「要不要保持可交互」。所有状态变化点都走这里（幂等，值没变不发 IPC）。
   * 与 setInteractive 的分工：后者表达光标在不在身体上，本方法表达我有没有在用输入（优先级更高）。
   */
  syncInputBusy() {
    this.syncInputRegions();
    const busy = this.inputBusy();
    if (busy === this._inputBusy) return;
    this._inputBusy = busy;
    window.__dshPetDebug.inputBusy = busy;
    if (window.petBridge) window.petBridge.setInputBusy(busy);
  },

  syncInputRegions() {
    if (!window.petBridge || !window.petBridge.setInputRegions) return;
    const rects = [];
    // 控件矩形 = 主进程允许接收点击的区域，矩形外继续穿透。可点的余额气泡悬在余量区，不登记就点不到。
    const controls = [
      ...document.querySelectorAll('.dsh-pet-menu-column, .dsh-pet-chat, .dsh-pet-todo, .pet-bubble.is-clickable'),
    ];
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
  },

  setInteractive(flag) {
    const next = !!flag;
    if (next === this._interactive) return; // 只在状态变化时发 IPC，避免逐帧刷屏
    this._interactive = next;
    window.__dshPetDebug.interactive = next;
    if (window.petBridge) window.petBridge.setInteractive(next);
  },

  /**
   * 悬浮提示显隐。
   *
   * 由 onMouseMove 的「光标在不在身体命中区」驱动，而不是 pointerenter/leave：身体外整窗穿透，
   * 光标离开身体时 pointerleave 未必派发，提示会赖在屏幕上不走；几何判定与穿透翻转同源才只有一种口径。
   */
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
    // 右键菜单/对话弹窗/待办面板开启：整窗保持可交互，关闭后恢复命中区判定
    if (this.menuOpen || this.chatOpen || this.todoOpen) {
      this.syncInputRegions(); // 级联菜单按悬停增减面板，及时更新占用区域
      this.setInteractive(true);
      this.setTip(false); // 菜单/弹窗期间提示让位，不跟浮层抢注意力
      return;
    }
    const r = this.hitRect;
    // forwarded 事件坐标以窗口为原点；转换到 sprite 坐标要扣减窗口余量。异常时退回屏幕坐标推导：
    // ÷scale 后减去窗口屏幕原点即窗口内坐标（hitRect/pos 均为 CSS 系）。
    const wx = Number.isFinite(e.clientX) ? e.clientX : toLocal(e.screenX) - (this.pos.x + VIEW.x - this.margin.l);
    const wy = Number.isFinite(e.clientY) ? e.clientY : toLocal(e.screenY) - (this.pos.y + VIEW.y - this.margin.t);
    const px = wx - this.margin.l;
    const py = wy - this.margin.t;
    const inBody = px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    // 快捷键与拖拽都只在"光标在身体上"时生效，与提示/穿透同源，避免另一套判定
    this.hoverBody = inBody;
    // 光标存视口坐标（窗口原点 + 窗口内坐标）：窗口随宠物移动时贴光标不会漂。必须在 setTip 之前
    // 更新——setTip 变显隐时会立刻渲染一次，晚一步就会用上一次的光标摆位。
    if (inBody) this.tipCursor = { x: this.pos.x - this.margin.l + wx, y: this.pos.y - this.margin.t + wy };
    this.setInteractive(inBody);
    // 悬浮提示与可交互判定同源（同一个 inBody）：进身体出现，离开收起
    this.setTip(inBody);
    // 跟随光标：位置依赖光标，每次移动都要重摆（setTip 只在显隐变化时渲染）
    if (this.tipOn) this.renderTip();
  },

  onClick(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged) return;
    // Ctrl（macOS 为 Cmd）+ 左键 = 呼出 DSH：与菜单首项同一动作，只是快捷键——
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
    // 睡觉：点一下就是叫醒。挤压与音效照常（手感与平时一致），但不播点击回应动画——
    // 叫醒的表现由 /wake 写回的 sleep 叶子驱动（end 播一遍，播完回随机链）。
    // 这里直接压当前前台那一帧：平时靠 pendingSquash 等新动画就位，这条路没有换源。
    if (this.sleeping) {
      playClickSound();
      const front = this.front === 0 ? this.videoA : this.videoB;
      if (front) this.startSquash(front);
      this.postSleepAction('wake');
      // 入睡过渡里被点：这次入睡作废，按普通点击播回应动画——「起来」那段不再播。
      // 先本地清状态：等叶子回来时 setSleep 会因「本来没睡」直接返回，不会插一段 end。
      if (this.sleepPhase === 'start') {
        this.sleeping = false;
        this.sleepSet = null;
        this.sleepPhase = null;
        if (this.animations.clicks.length) this.playOnce(S.pick(this.animations.clicks));
      }
      return;
    }
    // 点击音效与浏览器同位置：放在「按下已触发积分」的早退之后、点击动画判断之前
    playClickSound();
    if (!this.animations.clicks.length) return;
    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）
    this.playOnce(S.pick(this.animations.clicks));
  },

  // 右键菜单（统一自绘组件：树与渲染都来自 shared-core 的同一份 menu 模块）
  // 菜单/弹窗可视矩形（窗口局部坐标）= 窗口 ∩ 工作区：宠物贴边时外扩余量伸出屏幕，窗口内固定定位的
  // 菜单会走进被屏幕裁掉的部分。把菜单约束到这个矩形内即可完整显示，窗口与宠物零移动；
  // 退化（可视区过小/窗口整体出屏）返回 null，调用方按窗口视口兜底。
});

Object.assign(PetSprite.prototype, {
  /**
   * 拖拽经过命中区：只处理带文件的拖拽。
   * 必须 preventDefault，否则窗口会把这个文件当导航打开（页面直接被替换）。
   */
  onDragOverImage(e) {
    if (!S.dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  },

  /** 松手：第一张图片直接开对话并挂成待发送图；不是图片就当没发生。 */
  onDropImage(e) {
    const file = S.firstImageFile(e.dataTransfer);
    if (!file) return;
    e.preventDefault();
    this.showChatFromMenu(file);
  },

  /** 悬停快捷键：按住 M 说话、L 开对话、D 开关待办、S 切换睡/醒。 */
  onHotkey(e) {
    // 按住说话先判：它要吃掉按住期间的自动重复，晚一步就会被输入框收走
    if (this.hearHold.onKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (!this.hoverBody) return;
    if (S.isChatHotkey(e)) {
      e.preventDefault();
      this.showChatFromMenu();
      return;
    }
    if (S.isTodoHotkey(e)) {
      e.preventDefault();
      this.toggleTodo();
      return;
    }
    // 睡觉：与浏览器同为切换语义；该条目没配睡觉动画时整项无效（菜单里也不出现）
    if (S.isSleepHotkey(e) && Array.isArray(this.animations.sleep) && this.animations.sleep.length > 0) {
      e.preventDefault();
      this.postSleepAction(this.sleeping ? 'wake' : 'sleep');
    }
  },

  /** 松手：结束「按住说话」的那次录音（没在按住时什么都不做）。 */
  onHotkeyUp(e) {
    this.hearHold.onKeyUp(e);
  },
});
