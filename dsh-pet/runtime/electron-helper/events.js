/**
 * dsh-pet desktop helper —— 事件联动（余额 / 碎碎念 / 广播 / 工作状态）。
 *
 * 展示与 tick 回调经 PetSprite.prototype 挂载（运行时可解析，顺序无碍）；
 * startLoops 是全部轮询的组装入口（boot 后调用）。依赖 constants.js / sprite.js。
 */
'use strict';

// ---- 工作状态联动（DSH 会话状态，每只宠物按 workStatusEnabled 门控；容器 1s 轮询，ts 变化才递增 tick）----
// 气泡驻留语义与浏览器一致：thinking/working/result/waiting（"事情还没完"）常驻直到状态切走；
//   success/error（"这事结束了"）10s 自动收起；state=null（空闲/回合被打断）收起气泡回待机。
// 动画循环语义：进行中档位循环播（switchTo once=false），终态档位播一遍回 idle 链。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用（与浏览器 workStatusRef 同用途）
  if (!state) {
    // 空闲：收起常驻气泡（动画不处理，由常规动画链回待机）
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.renderBubble();
    return;
  }
  const pool = this.animations.events?.workStatus;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
    return;
  }
  const idx = S.WORK_STATUS_INDEX[state];
  const slot = pool[idx];
  if (slot === undefined) {
    console.error('[dsh-pet] work-status 档位索引越界：state=' + state + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' workStatus pet=' +
      this.pet.id +
      ' state=' +
      state +
      ' -> [' +
      idx +
      '] ' +
      name,
  );
  this.stopMove();
  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位]（数组）随机抽一句；
  // 整字段/整档缺失 = 不弹文本，只播动画（与浏览器同一语义）。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;
  this.workOn = true;
  const terminal = state === 'success' || state === 'error';
  if (this.workTimer !== null) window.clearTimeout(this.workTimer);
  this.workTimer = terminal
    ? window.setTimeout(() => {
        this.workOn = false;
        this.renderBubble();
      }, BUBBLE_DURATION_MS)
    : null; // 非终态：常驻，不设自动收起
  this.renderBubble();
  // 循环语义（与浏览器 setOnce 一致）：终态播一遍回 idle；非终态多候选档位播一遍 →
  // ended 由 sprite.handleEnded 轮换到下一候选（长时间状态不单段重复）；非终态单候选档位无限循环。
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
};

// ---- 余额事件（每只宠物按 balanceEnabled 门控；档位与气泡内容来自 shared） ----
PetSprite.prototype.onBalanceTick = function onBalanceTick(state, tick) {
  if (!this.pet.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevTick) return;
  this.prevTick = tick;
  this.showBalanceNow(state);
};

// ---- 碎碎念（每只宠物独立：按 eventsRefreshSec.whisper 周期轮询自己的句子，用本种类人设生成） ----
PetSprite.prototype.startWhisperLoop = function startWhisperLoop() {
  if (!this.pet.whisperEnabled || this.whisperLoopTimer !== null) return;
  const intervalMs = Math.max(1000, (this.pet.eventsRefreshSec?.whisper ?? 3600) * 1000);
  const refresh = async () => {
    try {
      const petId = encodeURIComponent(this.pet.id);
      const state = await S.fetchWhisperState(WHISPER_URL + '?pet=' + petId);
      if (!this.whisperBaseline) {
        this.whisperBaseline = true; // 首次仅记基线：避免启动/刷新时重放历史事件
        if (state.ok) {
          this.prevWhisperTs = state.ts;
          this.whisperText = state.text;
        }
        return;
      }
      if (!state.ok) {
        console.warn(
          '[dsh-pet] 碎碎念生成失败 pet=' +
            this.pet.id +
            ' reason=' +
            state.reason +
            (state.message ? ' ' + state.message : ''),
        );
        return;
      }
      if (state.ts !== this.prevWhisperTs) {
        this.prevWhisperTs = state.ts;
        this.whisperText = state.text;
        this.showWhisper(state.text);
      }
    } catch (e) {
      console.warn('[dsh-pet] 碎碎念拉取异常 pet=' + this.pet.id, e);
    }
  };
  this.whisperLoopTimer = window.setInterval(() => void refresh(), intervalMs);
  void refresh();
};

// 命令触发气泡（/chat 斜杠命令）：1s 轻量轮询 /broadcast?pet=<id>，ts 变化即弹气泡。
// 与碎碎念周期轮询独立（host 广播缓存是另一条通道）：手动触发语义不受 whisperEnabled 门控
PetSprite.prototype.startBroadcastLoop = function startBroadcastLoop() {
  if (this.broadcastLoopTimer !== null) return;
  const refresh = async () => {
    try {
      const petId = encodeURIComponent(this.pet.id);
      const res = await fetch(BASE + '/broadcast' + '?pet=' + petId, { cache: 'no-store' });
      if (!res.ok) return;
      const d = (await res.json().catch(() => null)) || {};
      const ts = typeof d.ts === 'number' ? d.ts : 0;
      if (!this.broadcastBaseline) {
        // 首拉无条件记基线（含 ts=0）：若 ts=0 提前 return 会跳过基线建立，
        // 导致第一条命令广播被当成基线吃掉（该条永不弹）
        this.broadcastBaseline = true;
        this.prevBroadcastTs = ts;
        return;
      }
      if (ts === 0 || ts === this.prevBroadcastTs) return; // 无广播 / 无变化
      this.prevBroadcastTs = ts;
      if (typeof d.text === 'string' && d.text) this.showWhisper(d.text);
    } catch (e) {
      console.warn('[dsh-pet] 广播拉取异常 pet=' + this.pet.id, e);
    }
  };
  this.broadcastLoopTimer = window.setInterval(() => void refresh(), 1000);
  void refresh();
};

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（10s 消失，与余额同一语义）
PetSprite.prototype.showWhisper = function showWhisper(text) {
  const pool = this.animations.events?.whisper;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
    return;
  }
  // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
  const name = S.pickSlot(S.pick(pool, this.anim), this.anim);
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' whisper pet=' +
      this.pet.id +
      ' -> [' +
      name +
      '] 「' +
      text +
      '」',
  );
  this.stopMove();
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦，与余额同一语义；重复触发先清旧定时器）
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = window.setTimeout(() => {
    this.whisperOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// 余额展示（档位动画 + 气泡）：周期轮询与菜单点播共用同一展示路径，视觉/行为严格一致
PetSprite.prototype.showBalanceNow = function showBalanceNow(state) {
  if (!state || !state.ok) return;
  const p = S.balancePercent(state);
  if (p === undefined) return; // 当前数据源没有百分比语义：不触发档位动画
  const pool = this.animations.events?.balance;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
    return;
  }
  const idx = S.balanceEventIndex(p);
  const slot = pool[idx];
  if (!slot) {
    console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  this.stopMove();
  this.bubbleOn = true;
  this.balanceView = S.balanceBubbleView(state);
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// ---------- 轮询组装（容器统一拉取/触发，与浏览器 PetMulti 同一套路径；boot 成功后调用） ----------
function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 是否存在启用余额功能的宠物：全禁用时跳过余额轮询（不拉取，避免无意义的周期请求——与浏览器一致）
  const anyBalanceEnabled = sprites.some((s) => s.pet.balanceEnabled);

  // 余额周期轮询：eventsRefreshSec.balance（秒），成功递增 balanceTick 触发事件动画
  if (anyBalanceEnabled) {
    const intervalMs = Math.max(1000, (config.refreshSec?.balance ?? 1800) * 1000);
    const balanceLoop = async () => {
      try {
        const state = await S.fetchBalanceState(BALANCE_URL);
        balance = state;
        window.__dshPetDebug.lastBalanceOk = state && state.ok === true;
        if (state.ok) {
          balanceTick++;
          for (const s of sprites) s.onBalanceTick(state, balanceTick);
        } else if (state.reason !== 'unsupported') {
          console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
        }
      } catch (e) {
        console.error('[dsh-pet] 余额拉取异常', e);
      }
      setTimeout(() => void balanceLoop(), intervalMs);
    };
    void balanceLoop();
  }

  // 碎碎念：每只启用宠物独立轮询（startWhisperLoop）——各自周期、各自人设、各自一句话（与浏览器一致）
  for (const s of sprites) s.startWhisperLoop();
  // 命令触发气泡：每只宠物独立 1s 轻轮询（startBroadcastLoop）——/chat 命令写入即展示
  for (const s of sprites) s.startBroadcastLoop();

  // 手动 /balance 触发：1s 轻量轮询触发计数（端点已禁止缓存），计数变化且余额启用时立即刷新余额并递增 tick
  let triggerBaseline = null;
  const triggerLoop = async () => {
    try {
      const count = await S.fetchTriggerCount(TRIGGER_URL);
      if (count < 0) return;
      if (triggerBaseline === null) {
        triggerBaseline = count; // 首次仅记基线：避免启动时重放历史触发
      } else if (count !== triggerBaseline) {
        triggerBaseline = count;
        if (anyBalanceEnabled) {
          const state = await S.fetchBalanceState(BALANCE_URL);
          balance = state;
          if (state.ok) {
            balanceTick++;
            for (const s of sprites) s.onBalanceTick(state, balanceTick);
          } else {
            console.error(
              '[dsh-pet] 手动触发余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''),
            );
          }
        }
      }
    } catch {
      /* 轻量轮询失败静默：下一周期再试 */
    }
    setTimeout(() => void triggerLoop(), 1000);
  };
  if (anyBalanceEnabled) void triggerLoop();

  // 工作状态联动：任一宠物启用才轮询 /work-status（1s；避免无意义的周期请求——与浏览器一致）。
  // ts 变化（含回到空闲：host 在状态变化时更新 ts，切走 = 新 ts，用于收起常驻气泡）才递增 workTick →
  // 各启用宠物播档位动画+气泡；首拉仅记基线，启动/刷新不重放历史状态。
  const anyWorkStatusEnabled = sprites.some((s) => s.pet.workStatusEnabled);
  if (anyWorkStatusEnabled) {
    let workBaseline = null;
    const workLoop = async () => {
      try {
        const snap = await S.fetchWorkStatus(WORK_STATUS_URL);
        const ts = snap && typeof snap.ts === 'number' ? snap.ts : 0;
        if (workBaseline === null) {
          workBaseline = ts; // 首拉仅记基线
        } else if (ts !== workBaseline) {
          workBaseline = ts;
          workTick++;
          for (const s of sprites) s.onWorkTick(snap, workTick);
        }
      } catch {
        /* 轻量轮询失败静默：下一周期再试 */
      }
      setTimeout(() => void workLoop(), 1000);
    };
    void workLoop();
  }
}
