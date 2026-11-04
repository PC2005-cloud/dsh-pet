/**
 * 播放状态机：换源、前后台交替、收尾、冻结与占用锁、空闲随机链。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 只读实例状态与 shared-core 的选池函数，副作用是 DOM 视频源与 this.* 字段。
 * @module dsh-pet/runtime/electron-helper/sprite-playback
 */
'use strict';

Object.assign(PetSprite.prototype, {
  switchTo(next, nextOnce, playbackId, url) {
    if (!next) return;
    // 「当前在播哪一段」只在这里写：ended 分流、回空闲补丁、随机链避重都读它。
    // 交给调用方维护时 switchTo(x, false) 会留下过期值，events.js 判「是不是工作动画」就永远不成立。
    this.anim = next;
    this.once = !nextOnce;
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
    el.onended = nextOnce ? () => this.handleEnded() : () => this.restartLoop(el);
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
  },

  /**
   * 循环段收到 ended：原地回起点续播。
   *
   * 循环段本不该有 ended；出现说明素材被截断或解码提前结束，画面已停在末帧。
   * 不换源：换源会重建整条播放链，代价更大，还可能在同一处再次截断。
   */
  restartLoop(el) {
    el.currentTime = 0;
    void el.play().catch(() => {});
  },

  playOnce(name, playbackId, url) {
    this.switchTo(name, true, playbackId, url);
  },

  // 直接播一个外部地址。单独一个方法、不复用 onMenuAction：那套是菜单语义（文字类强制朝左的镜像
  // 修正、移动类走真实位移），裸地址没有这些属性。这里只停掉漫游并换源播一次，播完回到正常动画链；
  // 地址本身同时是 pending 的防重键与日志标识。
  playUrlOnce(url, playbackId) {
    this.stopMove();
    this.playOnce(url, playbackId, url);
  },

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
    // 解冻：睡姿优先接回（冻结只暂停、没换源，续播即可），其次非终态工作状态回档位循环，
    // 否则回 idle 一次，播完由 handleEnded 接回随机链。
    if (this.resumeSleepAnim()) return;
    if (this.resumeWorkStatusAnim()) return;
    if (this.animations.idle.length) this.playOnce(S.pick(this.animations.idle, this.anim));
  },

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
  },

  /**
   * 睡觉叶子 → 进睡 / 醒来（与 setLock 同风格：只认叶子里的值，不往回写）。
   *
   * 三段名由宿主挑定，这里照播不重挑——自己挑会让两端播到不同的一套（蹲着入睡、趴着醒来）。
   * 醒来不立刻清睡觉态：`end` 还得播一遍，清态与回随机链都在 handleEnded 里收尾。
   * @param state - `{ sleeping: true, start, loop, end }` 或 `{ sleeping: false }`。
   */
  setSleep(state) {
    if (!state) return;
    const stamp = '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + this.pet.id;
    if (!state.sleeping) {
      // 没在睡：醒来是幂等的空操作（重复叶子、老宿主，或叫醒一个本来醒着的宠物）
      if (!this.sleeping || this.sleepPhase === 'end') return;
      // 入睡过渡里被叫醒：取消这次入睡，不播「起来」——它不是真的睡着过。
      // 这里不换源：点击路径已自己播了点击回应；菜单叫醒时当前「开始」播完会自然回随机链。
      if (this.sleepPhase === 'start') {
        this.sleeping = false;
        this.sleepSet = null;
        this.sleepPhase = null;
        console.log(stamp + ' 入睡被打断：不播起来');
        return;
      }
      this.sleepPhase = 'end';
      this.stopMove();
      this.playOnce(this.sleepSet.end);
      console.log(stamp + ' 醒来：播 ' + this.sleepSet.end + ' 一遍');
      return;
    }
    // 已在睡（含正在播「起来」的过渡段）：重复叶子不重放，保持原套
    if (this.sleeping) return;
    this.sleeping = true;
    this.sleepSet = { start: state.start, loop: state.loop, end: state.end };
    this.sleepPhase = 'start';
    this.stopMove();
    // 与占用锁同一口径：进睡就把任务状态气泡收掉（醒来不补亮，等下一次状态变化再对齐）
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.renderBubble();
    this.playOnce(state.start);
    console.log(stamp + ' 进睡：' + state.start + ' → ' + state.loop);
  },

  /**
   * 请求进睡 / 叫醒：只发请求，画面等 sleep 叶子回来才动（三段名由宿主挑定）。
   *
   * 点击与右键菜单共用这一条路径；失败只记日志，不弹框——菜单动作不该打断用户。
   * @param action - `'sleep'` = 睡下，`'wake'` = 叫醒。
   */
  postSleepAction(action) {
    const route = action === 'wake' ? '/wake' : '/sleep';
    S.postAction(BASE + route + '?pet=' + encodeURIComponent(this.pet.id)).then((ok) => {
      if (!ok) console.error('[dsh-pet] ' + (action === 'wake' ? '叫醒' : '进睡') + '请求未成功 pet=' + this.pet.id);
    });
  },

  // 动画链（纯逻辑在 shared）
  playIdle() {
    // 占用锁：锁生效时不掷骰。这里是随机链的唯一入口（动画播完才会走到），一句判断就把随机动画、
    // 随机转向与自主走位一起停住——宠物停在最后一帧，等持锁者的下一条指令（走 /anim，不经这里）。
    if (this.frozen) return;
    // 睡觉：随机链整个停住——不掷骰、不自己走、不自己翻朝向。醒来时 setSleep 先播 end，
    // 播完由 handleEnded 清掉睡觉态再回到这里（那时 sleeping 已经为 false）。
    if (this.sleeping) return;
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
  },

  handleEnded() {
    // 播放回执：前台视频真的播完了 → 如实回 ended。放在拖拽守卫之前——「播完了」是既成事实，
    // 拖拽守卫管的是动画链怎么推进，不该影响回执的准确性。
    if (this.playback) {
      const done = this.playback;
      this.playback = null; // 先清再上报：后续链式换源不该把它当成「被打断」
      this.reportPlayback(done, 'ended');
    }
    // 睡觉：动画链的推进归睡觉状态机（start 播完 → loop；end 播完 → 清态回随机链）。
    // 放在拖拽守卫之前：睡着时拖拽不换动画、睡姿照播，start 播完必须照常切 loop，否则松手就停在末帧。
    // 这几条分支都提前 return，其余 ended 逻辑（事件轮换、朝向翻转、随机链）在被拦住时一律不执行。
    if (this.sleeping) {
      const set = this.sleepSet;
      if (set && this.sleepPhase === 'start') {
        this.sleepPhase = 'loop';
        // 循环段：loop=true；万一素材提前 ended，restartLoop 原地续播，不进 handleEnded。
        this.switchTo(set.loop, false);
        return;
      }
      if (this.sleepPhase === 'end') {
        // 醒来收尾：先清睡觉态再回随机链，否则 playIdle 会被自己的门禁挡住
        this.sleeping = false;
        this.sleepSet = null;
        this.sleepPhase = null;
        this.playIdle();
        return;
      }
      // loop 段本不该有 ended；真收到说明前台被别的动画（本地菜单点播）顶掉过，接回睡姿，别停在末帧
      if (set && this.anim !== set.loop) {
        this.switchTo(set.loop, false);
      }
      return;
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
      // 终态播完即止；单候选档位由 loop 无限循环（正常不触发 ended，走不到这里）。
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
  },

  // 互动/事件动画播完后恢复工作状态档位循环：非终态 → 按当前档位重选动画（避开当前段）；
  // 终态/空闲 → false 不接管，调用方走原逻辑。
  resumeWorkStatusAnim() {
    // 占用锁：冻结期间不许由这条路把工作状态动画点回来——它读的是实时 workState，与 workTick 无关，
    // 持锁者每投一次带 anim 的气泡，说话动画播完就会走到这里。解冻路径是先置 frozen=false 再调它。
    if (this.frozen) return false;
    // 睡觉：自动来源不接管动画——睡姿循环整段归睡觉状态机，醒来由 end 播完回随机链。
    if (this.sleeping) return false;
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
  },

  // 睡觉期间被冻结暂停的那段接回播放（冻结只 pause、不换源，原地续播即可，start 播完照样能走 handleEnded）。
  // 不在睡返回 false，让调用方继续走它原来的恢复路径。
  resumeSleepAnim() {
    if (!this.sleeping) return false;
    const el = this.front === 0 ? this.videoA : this.videoB;
    if (el) el.play().catch(() => {});
    return true;
  },

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
    this.switchTo(chosen.name, true, playbackId);
    return chosen.name;
  },
});
