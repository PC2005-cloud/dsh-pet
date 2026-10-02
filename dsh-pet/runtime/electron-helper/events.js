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
// 动画循环语义：进行中档位循环播（switchTo once=false），终态档位播一遍回 idle 链；
//   回空闲时把正在循环的那段改成"播完即停"（见下面空闲分支），否则 ended 永不触发、链回不去。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用（与浏览器 workStatusRef 同用途）
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (!state) {
    // 回空闲：把正在**循环播**的进行中档位动画改成"播完即停"（与浏览器 src/client/pet.ts 的空闲分支
    // 同一处修复）。进行中档位走 switchTo(name, false)（el.loop=true、el.onended=null），ended 永不
    // 触发；而这里不切动画（原设计"由常规动画链回待机"），链因此拿不到推进信号 —— 宠物会一直卡在
    // 那段工作动画上。只把当前段改成播完即停：它结束后走 handleEnded → resumeWorkStatusAnim() 返回
    // false → playIdle；工作期间的原生 loop 不受影响。
    if (S.poolIncludes(this.animations.events?.workStatus ?? [], this.anim)) {
      const frontEl = this.front === 0 ? this.videoA : this.videoB;
      if (frontEl) {
        frontEl.loop = false;
        frontEl.onended = () => this.handleEnded();
      }
    }
    // 空闲：收起常驻气泡
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
  const terminal = state === 'success' || state === 'error';
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick（todo 文案更新、其它会话事件搅动 ts）
  // 不重新点亮**已自动收起的终态气泡**——否则"任务完成"的气泡会被后续 ts 变化反复弹回（Bug 2，
  // 与浏览器 workBubbleOn 同一语义）。
  if (stateChanged) {
    this.workOn = true;
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = terminal
      ? window.setTimeout(() => {
          this.workOn = false;
          this.renderBubble();
        }, BUBBLE_DURATION_MS)
      : null; // 非终态：常驻，不设自动收起
  }
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

// 余额不可用（服务商未登记 / 缺凭证 / 抓取失败）：只弹**文字说明**气泡，不播档位动画
// （非 ok 没有百分比语义，档位动画无从映射）。显隐/定时与成功路径同一套（10s 自动消失）；
// 不 stopMove——本次没有动画要抢前台，宠物没必要停下漫游。
PetSprite.prototype.showBalanceNotice = function showBalanceNotice(state) {
  if (!this.pet.balanceEnabled) return; // 门控与成功路径一致（未启用余额的宠物完全免疫）
  if (!state || state.ok) return;
  this.bubbleOn = true;
  this.balanceWrap = true; // 文字说明可能多行：renderBubble 据此套用换行变体（默认 nowrap 会顶出宠物宽度）
  this.balanceView = S.balanceBubbleView(state);
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// ---- 碎碎念 / 命令气泡 / 对话回复（**三合一**）：不再各自轮询 ----
// 改造前这里是两个循环（startWhisperLoop 按 eventsRefreshSec.whisper 轮询 /whisper、
// startBroadcastLoop 1s 轮询 /broadcast）。现在三者都写进 S 的 pets.<id>.say，由上面的
// /state 统一轮询分发到对应宠物（见 applySayLeaf）——本窗口只装一只宠物，按 id 命中即可。

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（10s 消失，与余额同一语义）
// image：host 随机抽定的配图名称（未开配图/池为空则空串，与浏览器端同一契约）
PetSprite.prototype.showWhisper = function showWhisper(text, image) {
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
      '」' +
      (image ? ' [' + image + ']' : ''),
  );
  this.stopMove();
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.whisperImage = typeof image === 'string' ? image : '';
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
  this.balanceWrap = false; // 正常余额气泡是单行（nowrap），别继承上一次文字说明的换行变体
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

// 余额不可用 → 文字说明气泡（周期轮询与手动 /balance 触发共用这一条路径；判定在 shared，与浏览器同一份）：
// explicit=true（手动触发）一律弹——用户问了就该有答复，包括"服务商不支持"这件事；
// 自动轮询仅在原因（含服务商）变化时弹一次，避免每 30 分钟反复刷同一句话。
function applyBalanceNotice(state, explicit) {
  const notice = S.decideBalanceNotice(state, balanceNoticeKey, explicit);
  balanceNoticeKey = notice.key;
  if (notice.show) for (const s of sprites) s.showBalanceNotice(state);
  // 未登记服务商是配置事实（已由气泡说明），不再刷 console；其余原因照旧显式报错，绝不伪造余额
  if (state.reason !== 'unsupported') {
    console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
  }
}

// ---------- 统一轮询（GET /state，1s）：与浏览器同一份数据来源与渲染入口 ----------
// 每个叶子 = { counter, data }：首拉只记基线（不渲染），之后 counter 变了才渲染。
// 各功能逐个接入，旧的独立轮询循环随迁随删。
let stateBaseline = null;

/** 余额叶子 → 展示（成功播档位动画 + 气泡；不可用按 shared 判定弹文字说明） */
function applyBalanceLeaf(leaf) {
  const hit = S.readBalance(leaf);
  if (!hit) return;
  balance = hit.state;
  window.__dshPetDebug.lastBalanceOk = hit.state && hit.state.ok === true;
  if (hit.state.ok) {
    balanceTick++;
    for (const s of sprites) s.onBalanceTick(hit.state, balanceTick);
  } else {
    // 不可用：manual（用户主动要的）一律弹，周期刷新只在原因变化时弹一次
    applyBalanceNotice(hit.state, hit.manual);
  }
}

/** 说话叶子 → 对应宠物播说话动画 + 气泡（碎碎念/命令气泡/对话回复三合一）。
 *  petId 由路径解析出来（pets.<id>.say）；本窗口只装一只宠物，按 id 命中即可。 */
function applySayLeaf(petId, leaf) {
  const said = S.readSay(leaf);
  if (!said) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.showWhisper(said.text, said.image);
  }
}

/** 工作状态叶子 → 各宠物切档位动画 + 气泡（含回到空闲：state=null 用于收起常驻气泡） */
function applyWorkStatusLeaf(leaf) {
  const snap = S.toWorkStatus(leaf.data);
  if (!snap) return;
  workTick++;
  for (const s of sprites) s.onWorkTick(snap, workTick);
}

/** 点播动画叶子 → 对应宠物播该动画（其他插件经 POST /anim 写进 S）。
 *  复用**右键菜单同一个处理函数** onMenuAction，所以镜像修正 / 移动类走真实位移 /
 *  其余播一遍的语义与菜单点一下完全一致，这里不重写一遍。
 *  petId 由路径解析出来（pets.<id>.anim）；本窗口只装一只宠物，按 id 命中即可。 */
function applyAnimLeaf(petId, leaf) {
  const hit = S.readAnim(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.onMenuAction({ label: hit.name, anim: hit.name });
  }
}

/** 跑一拍 /state（1s 定时与「前端动作后立刻刷新」共用同一份实现） */
async function pollStateOnce() {
  try {
    const s = await S.fetchState(STATE_URL);
    if (!s) return;
    if (stateBaseline === null) {
      stateBaseline = S.flattenCounters(s); // 首拉：只记基线，不渲染（避免启动/重载时重放旧气泡）
      return;
    }
    for (const change of S.takeChanged(s, stateBaseline)) {
      if (change.leaf.data === null) continue;
      if (change.path === 'sections.balance') applyBalanceLeaf(change.leaf);
      else if (change.path === 'sections.workStatus') applyWorkStatusLeaf(change.leaf);
      else if (change.path.startsWith('pets.') && change.path.endsWith('.say')) {
        // 宠物 id **允许含点号**：按前缀/后缀切片，绝不 split('.')
        applySayLeaf(change.path.slice('pets.'.length, -'.say'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.anim')) {
        // 点播动画：同样按前缀/后缀切片（counter 每次写入都递增，连点两次也会分发两次）
        applyAnimLeaf(change.path.slice('pets.'.length, -'.anim'.length), change.leaf);
      }
    }
  } catch {
    /* 轻量轮询失败静默：下一拍再试 */
  }
}

/** 立即跑一拍：右键菜单等**前端动作**完成后调用——结果 0 延迟可见，不用等下一个 1s */
function pollStateNow() {
  void pollStateOnce();
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 统一轮询：1s 一拍（余额数据由 host 定时器刷新后写进 S，这里只读）
  const stateLoop = async () => {
    await pollStateOnce();
    setTimeout(() => void stateLoop(), 1000);
  };
  void stateLoop();
}
