/**
 * 桌面 Helper 的事件联动：余额、碎碎念、第三方点播与工作状态的展示与轮询。
 *
 * 展示与 tick 回调挂在 PetSprite.prototype 上，必须在 sprite.js 之后加载（顶层就改写原型）；startLoops 是全部轮询的
 * 唯一入口，boot 成功后调用。不负责动画播放与气泡渲染本身（见 sprite.js）。依赖 constants.js / sprite.js。
 *
 * @module dsh-pet/runtime/electron-helper/events
 */
'use strict';

// 工作状态联动：容器每秒轮询 /state，counter 变化才递增 tick，各宠物按 workStatusEnabled 门控。
// 气泡驻留：thinking/working/result/waiting 常驻到状态切走，success/error 10s 自动收起，state=null 收起。
// 动画：进行中档位循环播，终态播一遍回 idle 链；回空闲时把正在循环的那段改成「播完即停」。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  // 占用锁：锁生效时不响应工作状态——它是自动来源（任务事件驱动），没有「用户手动要」这条路。
  // 判在 tick 消费之后：占用期间的变化当过去了，解冻时由 applyFreeze 重新对齐当前状态。
  // 宿主侧不挡这个全局段：sections.workStatus 是所有宠物共用一份，跳过写入会连带静音别的宠物。
  if (this.frozen) return;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (!state) {
    // 回空闲：把正在循环播的进行中档位动画改成「播完即停」。进行中档位走 switchTo(name, false)
    // （loop=true、onended=null），ended 永不触发；这里不切动画，链就拿不到推进信号，
    // 宠物会卡在那段工作动画上。只改当前段：它结束后走 handleEnded → playIdle。
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
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，避开当前正播动画（与浏览器一致）
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
  // 气泡文本：任务详情优先，否则从条目级 workStatusTexts[档位] 随机抽一句；整档缺失则只播动画。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;
  const terminal = state === 'success' || state === 'error';
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick 不重新点亮已自动收起的终态气泡，否则会被反复弹回。
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
  // 循环语义：终态播一遍回 idle；非终态多候选档位播一遍 → ended 轮换到下一候选；
  // 非终态单候选档位无限循环。
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
};

// 余额事件：自动轮询按 balanceEnabled 门控，手动请求无条件。
// manual = 这次刷新是用户主动要的（右键「查看余额」/ `/balance` 命令）：不受开关限制，一律给答复。
PetSprite.prototype.onBalanceTick = function onBalanceTick(state, tick, manual) {
  if (!this.pet.balanceEnabled && !manual) return; // 自动轮询受开关门控；手动无条件通过（与浏览器一致）
  if (tick === 0 || tick === this.prevTick) return;
  this.prevTick = tick;
  // 占用锁：锁生效时不看自动余额（那是宠物自己的行为），手动请求照常（用户交互优先）。
  // 判在 tick 消费之后：占用期间这一拍就当过去了，解冻后不补播（事件是瞬时的）。
  if (this.frozen && !manual) return;
  this.showBalanceNow(state, manual);
};

// 余额不可用（服务商未登记 / 缺凭证 / 抓取失败）：只弹文字说明气泡，不播档位动画。
// 显隐与定时和成功路径同一套；不 stopMove——本次没有动画要抢前台。
// 门控：自动轮询要求 balanceEnabled，手动请求无条件弹（包括「服务商不支持」这件事）。
PetSprite.prototype.showBalanceNotice = function showBalanceNotice(state, manual) {
  if (!this.pet.balanceEnabled && !manual) return; // 自动轮询受开关门控；手动无条件通过
  if (this.frozen && !manual) return; // 占用锁：自动来源不看；手动照常（用户问了就得有答复）
  if (!state || state.ok) return;
  this.bubbleOn = true;
  this.balanceWrap = true; // 文字说明可能多行：renderBubble 据此套用紧凑变体（字号缩到 0.75、宽度下限更窄）
  this.balanceView = S.balanceBubbleView(state);
  this.balanceState = state; // 留着：不可用状态不可展开，但要防止上一次的余额读数残留在字段里
  this.balanceViewIndex = 0; // 文字说明只有一页（页数由 balancePageCount 从 state 算）
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// 碎碎念 / 命令气泡 / 对话回复 / 清空走同一条通道：都写进 S 的 pets.<id>.say，
// 由 /state 统一轮询分发到对应宠物（见 applySayLeaf）——本窗口只装一只宠物，按 id 命中即可。

// 收起说话气泡（POST /bubble/clear 的落点）。只动气泡：正在播的动画、余额气泡、
// 工作状态气泡都不碰——气泡与动作是两把锁、分别释放。与浏览器端 clearWhisperBubble 同一语义。
PetSprite.prototype.clearWhisper = function clearWhisper() {
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = null;
  this.whisperOn = false;
  this.whisperView = null;
  this.whisperImage = '';
  this.whisperUrl = '';
  this.renderBubble();
};

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（与余额同一套定时语义）。
// image 是 host 随机抽定的配图名；url 是第三方自带的完整地址：两者二选一（host 判定层保证），
// 由字段名区分、不靠嗅探。anim === false 时整段跳过动画联动（不查池、不换源、不 stopMove），
// 于是缺 events.whisper 时只弹气泡也走得通。duration === 0 表示这一条不显示，且不动当前气泡
// （要收起请用 POST /bubble/clear，两件事不重叠）。
PetSprite.prototype.showWhisper = function showWhisper(text, image, url, duration, anim) {
  let name = null;
  if (anim !== false) {
    const pool = this.animations.events?.whisper;
    if (!pool || pool.length === 0) {
      console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
      return;
    }
    // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
    name = S.pickSlot(S.pick(pool, this.anim), this.anim);
  }
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' whisper pet=' +
      this.pet.id +
      (name === null ? ' （不联动动画）' : ' -> [' + name + ']') +
      ' 「' +
      text +
      '」' +
      (image ? ' [' + image + ']' : ''),
  );
  // 先起动画：它与气泡时长是两个独立参数（duration=0 时动画照播、只是不弹泡）
  if (name !== null) {
    this.stopMove();
    this.playOnce(name);
  }
  if (duration === 0) return;
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.whisperImage = typeof image === 'string' ? image : '';
  this.whisperUrl = typeof url === 'string' ? url : '';
  this.renderBubble();
  // 气泡定时消失（与动画解耦，与余额同一语义；重复触发先清旧定时器）
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = window.setTimeout(() => {
    this.whisperOn = false;
    this.renderBubble();
  }, duration ?? BUBBLE_DURATION_MS);
};

// 余额展示（气泡 + 档位动画）：周期轮询与菜单点播共用同一展示路径，视觉与行为严格一致。
// 弹气泡：手动请求无条件弹（哪怕关了 balanceEnabled、哪怕没有百分比语义）；自动轮询要求有内容可展示，
// custom 形态不看百分比。档位动画只属于启用余额的宠物，且必须有百分比依据，关掉开关的点菜单也不演。
PetSprite.prototype.showBalanceNow = function showBalanceNow(state, manual) {
  if (!state || !state.ok) return;
  const p = S.balancePercent(state);
  if (!manual && p === undefined && state.shape !== 'custom') return; // 自动轮询没有百分比语义：没有档位依据，不弹（手动仍要给答复）
  this.bubbleOn = true;
  this.balanceWrap = false; // 正常余额气泡用常规尺寸，别继承上一次文字说明的紧凑变体
  this.balanceView = S.balanceBubbleView(state);
  this.balanceState = state; // 展开态按页现算窗口明细与用量行（balanceView 只是收起态那两行）
  this.balanceViewIndex = 0; // 新一轮查询一律从第一页开始（与浏览器一致）
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  // 档位动画：开关关闭的宠物不演；没有百分比语义（纯余额金额）也没有档位可映射
  if (!this.pet.balanceEnabled) return;
  if (p === undefined) return;
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
  this.playOnce(name);
};

// 点余额气泡：切到下一页（末页回第一页），页数由 balancePageCount 决定。
// 淡出 → 换内容 → 淡入（250ms 后才重绘，否则内容会在半透明时被替换 = 硬切）；同时重置 10s 定时器，
// 否则第 8 秒才点开就只剩 2 秒。命中区由 renderBubble 末尾的 syncInputBusy() 重报。
PetSprite.prototype.toggleBalanceDetail = function toggleBalanceDetail() {
  if (!this.balanceClickable()) return;
  this.balanceViewIndex = (this.balanceViewIndex + 1) % this.balancePageCount();
  this.bubble.classList.add('is-fading');
  if (this.balanceFadeTimer !== null) window.clearTimeout(this.balanceFadeTimer);
  this.balanceFadeTimer = window.setTimeout(() => {
    this.balanceFadeTimer = null;
    this.bubble.classList.remove('is-fading');
    this.renderBubble(); // 重绘内容 + 重报控件矩形（展开态/换页宽度变了，矩形也得跟着变）
  }, BALANCE_FADE_MS);
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// 轮询组装：容器统一拉取与触发，与浏览器端同一套路径。

// 余额不可用 → 文字说明气泡（周期轮询与手动 /balance 共用这一条路径，判定在 shared）：
// explicit（手动触发）一律弹；自动轮询只在原因（含服务商）变化时弹一次，避免反复刷同一句话。
function applyBalanceNotice(state, explicit) {
  const notice = S.decideBalanceNotice(state, balanceNoticeKey, explicit);
  balanceNoticeKey = notice.key;
  if (notice.show) for (const s of sprites) s.showBalanceNotice(state, explicit);
  // 未登记服务商是配置事实（已由气泡说明），不再刷 console；其余原因照旧显式报错，绝不伪造余额
  if (state.reason !== 'unsupported') {
    console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
  }
}

// 统一轮询（GET /state，长轮询）：与浏览器同一份数据来源与渲染入口。
// 每个叶子 = { counter, data }：首拉只记基线（不渲染），之后 counter 变了才渲染。
let stateBaseline = null;
/** 我手里这份 S 的版本号（undefined = 首拉，不带参数 → 立刻拿全量） */
let stateSince;
/** 宿主支持长轮询吗？响应带 counter = 支持；不带 = 老宿主（会立刻返回全量，必须退避） */
let stateLongPoll = true;

/** 余额叶子 → 展示（成功播档位动画 + 气泡；不可用按 shared 判定弹文字说明） */
function applyBalanceLeaf(leaf) {
  const hit = S.readBalance(leaf);
  if (!hit) return;
  balance = hit.state;
  window.__dshPetDebug.lastBalanceOk = hit.state && hit.state.ok === true;
  if (hit.state.ok) {
    balanceTick++;
    for (const s of sprites) s.onBalanceTick(hit.state, balanceTick, hit.manual);
  } else {
    // 不可用：manual（用户主动要的）一律弹，周期刷新只在原因变化时弹一次
    applyBalanceNotice(hit.state, hit.manual);
  }
}

/** 说话叶子 → 对应宠物播说话动画 + 气泡。`kind: 'clear'` = 收起气泡，其余 = 弹一个气泡。 */
function applySayLeaf(petId, leaf) {
  const said = S.readSay(leaf);
  if (!said) return;
  for (const s of sprites) {
    if (s.pet.id !== petId) continue;
    if (said.kind === 'clear') s.clearWhisper();
    else s.showWhisper(said.text, said.image, said.url, said.duration, said.anim);
  }
  // 两端各判各的：叶子点名 desktop 才念，没点名或点了网页端就只弹气泡
  if (said.kind === 'say') S.playSayVoice(said);
}

/** 工作状态叶子 → 各宠物切档位动画 + 气泡（含回到空闲：state=null 用于收起常驻气泡） */
function applyWorkStatusLeaf(leaf) {
  const snap = S.toWorkStatus(leaf.data);
  if (!snap) return;
  workTick++;
  for (const s of sprites) s.onWorkTick(snap, workTick);
}

/** 点播动画叶子 → 对应宠物播该动画。
 *  name 复用右键菜单同一个处理函数（镜像修正、移动类走真实位移），url 是第三方完整地址、
 *  只换源播一次。facing 必须在换源之前赋给 sprite——switchTo 在 onReady 里按它贴 scaleX(-1)。
 *  没给 facing 就保持宠物当前朝向；给了则跳过「文字类动画点播前强制朝左」的修正。 */
function applyAnimLeaf(petId, leaf) {
  const hit = S.readAnim(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id !== petId) continue;
    const explicitFacing = hit.facing !== undefined;
    if (explicitFacing) s.facing = hit.facing; // 必须在换源前：switchTo 里按它贴 scaleX(-1)
    if (hit.url !== undefined) s.playUrlOnce(hit.url, hit.playbackId);
    else if (hit.name !== undefined)
      s.onMenuAction({ label: hit.name, anim: hit.name, playbackId: hit.playbackId }, explicitFacing);
  }
}

/** 位置指令叶子 → 对应宠物挪过去；复用 sprite.moveToCenter，只分发、不重写运动学。 */
function applyPositionLeaf(petId, leaf) {
  const hit = S.readPosition(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.moveToCenter(hit.x, hit.y, hit.mode, hit.duration);
  }
}

/** 抛掷指令叶子 → 按角度/力度飞出去；初速换算在 shared，下游全是既有抛掷物理。 */
function applyThrowLeaf(petId, leaf) {
  const hit = S.readThrow(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.throwWith(hit.angle, hit.power);
  }
}

/** 占用锁叶子 → 对应宠物冻结/解冻。它不是指令而是状态：sprite 自己按 expiresAt 定时解除，
 *  因为宿主侧过期是懒判的、不会推「锁没了」。 */
function applyLockLeaf(petId, leaf) {
  const hit = S.readLock(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.setLock(hit);
  }
}

/** 第三方菜单快照叶子 → 灌进各宠物（右键菜单据此拼「更多」）。它是当前状态、不是事件，
 *  注册与覆盖时写一次，所有窗口共用同一份快照。 */
function applyMenuLeaf(leaf) {
  const items = S.readMenuItems(leaf ? leaf.data : null, 'desktop');
  for (const s of sprites) s.menuItems = items;
}

/** 跑一拍 /state。返回 true = 按长轮询命中（宿主支持长轮询，可以立刻再请求）。 */
async function pollStateOnce() {
  try {
    const s = await S.fetchState(
      STATE_URL,
      stateLongPoll && stateSince !== undefined ? { since: stateSince, timeoutMs: STATE_WAIT_MS } : undefined,
    );
    if (!s) return false;
    // 响应带 counter = 宿主支持长轮询；不带 = 老宿主（不认识 since/timeout，会立刻返回全量），
    // 这时必须退回固定间隔轮询，否则这个循环就是忙等。
    stateLongPoll = typeof s.counter === 'number';
    if (stateLongPoll) stateSince = s.counter;
    if (stateBaseline === null) {
      stateBaseline = S.flattenCounters(s); // 首拉：只记基线，不渲染（避免启动/重载时重放旧气泡）
      // 第三方菜单项是状态而不是事件：首拉就要装上，否则 helper 重启后要等下次注册才出现
      applyMenuLeaf(s.sections ? s.sections.menu : null);
      return true;
    }
    for (const change of S.takeChanged(s, stateBaseline)) {
      if (change.leaf.data === null) continue;
      if (change.path === 'sections.balance') applyBalanceLeaf(change.leaf);
      else if (change.path === 'sections.workStatus') applyWorkStatusLeaf(change.leaf);
      else if (change.path === 'sections.menu') applyMenuLeaf(change.leaf);
      else if (change.path.startsWith('pets.') && change.path.endsWith('.say')) {
        // 宠物 id 允许含点号：按前缀/后缀切片，绝不 split('.')
        applySayLeaf(change.path.slice('pets.'.length, -'.say'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.anim')) {
        // 点播动画：同样按前缀/后缀切片（counter 每次写入都递增，连点两次也会分发两次）
        applyAnimLeaf(change.path.slice('pets.'.length, -'.anim'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.position')) {
        // 位置指令：同样按前缀/后缀切片，绝不 split('.')
        applyPositionLeaf(change.path.slice('pets.'.length, -'.position'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.throw')) {
        // 抛掷指令：同上
        applyThrowLeaf(change.path.slice('pets.'.length, -'.throw'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.lock')) {
        // 占用锁：同上切片，绝不 split('.')。它是状态而不是指令（见 applyLockLeaf）
        applyLockLeaf(change.path.slice('pets.'.length, -'.lock'.length), change.leaf);
      }
    }
    return true;
  } catch {
    /* 轻量轮询失败静默：下一拍再试 */
    return false;
  }
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 语音状态一变就重绘气泡：转圈 → 喇叭（或退回无角标）要立刻反映出来，
  // 不能等到下一条消息把气泡重画。桌面端没有 react，只能靠订阅手动重绘。
  S.subscribeVoiceState(() => {
    for (const s of sprites) s.renderBubble();
  });

  // 统一轮询是自调度的长轮询（请求 → 处理 → 立刻再请求）：宿主在版本没变时挂起，空闲时
  // 1 请求/秒，叶子一变立刻收到。本窗口只装一只宠物，所以每个窗口各跑一份；全局计数器意味着
  // 任意写入会唤醒所有窗口（有意为之）。
  const stateLoop = async () => {
    const hit = await pollStateOnce();
    setTimeout(() => void stateLoop(), hit && stateLongPoll ? 0 : 1000);
  };
  void stateLoop();
}
