/**
 * 「桌宠配置」面板的全局部分：开关、语音、外观、物理、移动端、对话模型与落盘位置。
 *
 * 全部读写 state.globals（main 条目的全局字段），由 ./pets 的保存一并提交。
 * 卡片按 builder 数组返回，渲染时机由 ./pets 决定——这里不自己找容器。
 * @module dsh-pet/src/standalone/settings-page/script/globals
 */

/** 生成全局卡片片段。 */
export function globalsScript(): string {
  return `
function globalCards() {
  return [globalFlagsCard, voiceCard, fontCard, physicsCard, motionCard, modelCard, environmentCard, advancedCard];
}

function setGlobal(key, value) {
  state.globals[key] = value;
}

function globalFlagsCard() {
  const g = state.globals;
  return card('全局开关', '对所有宠物生效；保存后立即写盘。', [
    toggleRow('g-notify', '系统通知', '对话完成、生成失败、权限申请等事件弹出系统通知。', g.notificationsEnabled, (value) => setGlobal('notificationsEnabled', value)),
    toggleRow('g-notify-focused', '前台聚焦时也提醒', '开着本页、窗口在前台时照样弹通知、照样播报工作状态语音。默认关闭。', g.notifyWhenFocused, (value) => setGlobal('notifyWhenFocused', value)),
    toggleRow('g-click', '点击音效', '点击宠物时播放内置音效。', g.clickSoundEnabled, (value) => setGlobal('clickSoundEnabled', value)),
    toggleRow('g-whisper-image', '碎碎念配图', '碎碎念时允许模型挑一张表情包。', g.whisperImageEnabled, (value) => setGlobal('whisperImageEnabled', value)),
    toggleRow('g-chat-image', '对话配图', '对话时把表情包清单交给模型按语境选图。', g.chatImageEnabled, (value) => setGlobal('chatImageEnabled', value)),
    toggleRow('g-chat-anim', '对话动作联动', '对话时让模型挑一个动作当场表演。', g.chatAnimationEnabled, (value) => setGlobal('chatAnimationEnabled', value)),
    toggleRow('g-confine', '锁定在当前屏幕', '抛掷与自主漫游只在当前所在的这块屏幕里活动。', g.confineToScreen, (value) => setGlobal('confineToScreen', value)),
    toggleRow('g-tray', '系统托盘图标', '桌面模式常驻托盘；关掉后只能从任务栏找回。', g.trayEnabled, (value) => setGlobal('trayEnabled', value)),
  ]);
}

function environmentCard() {
  const g = state.globals;
  const feedback = make('p', { class: 'fieldHint', text: '', hidden: true });
  const show = (text) => {
    feedback.textContent = text;
    feedback.hidden = false;
  };
  const input = make('input', { type: 'text', id: 'g-env-city', value: g.environmentCity || '' });
  input.placeholder = '留空 = 自动定位';
  input.addEventListener('input', () => {
    setGlobal('environmentCity', input.value);
    markDirty(true);
    feedback.hidden = true;
  });
  // 检测走宿主已有的环境查询（不带 pet = 纯查询，不点亮气泡），把 IP 定位结果回填。
  // 必带 fresh=1：不带就会读到 10 分钟内的缓存定位，用户点了检测却拿到旧城市。
  // 必带 ip=1：不带就会把配置里已填的城市原样回显，检测按钮等于没作用。
  // 回填后不自动保存——用户可能还要改，统一走页面底部的保存。
  const detect = button('检测', () => {
    detect.textContent = '检测中…';
    detect.disabled = true;
    callApi('POST', '/environment?fresh=1&ip=1')
      .then((facts) => {
        if (!facts || typeof facts.city !== 'string' || !facts.city) {
          show('宿主没有返回城市（IP 定位失败），请手动填写。');
          return;
        }
        input.value = facts.city;
        setGlobal('environmentCity', facts.city);
        markDirty(true);
        show('已填入：' + facts.city + '（点保存生效）');
      })
      .catch((error) => show('检测失败：' + (error && error.message ? error.message : String(error))))
      .finally(() => {
        detect.textContent = '检测';
        detect.disabled = false;
      });
  });
  return card('环境与定位', '天气查哪座城市。留空 = 按出口 IP 自动定位；填了城市名就按它查。', [
    fieldRow('g-env-city', '城市', make('div', { class: 'row' }, [input, detect]), '填城市名即可，「扬州」和「扬州市」都行。'),
    feedback,
  ]);
}

function voiceCard() {
  const g = state.globals;
  // 运行时目录优先：宿主注册了 Edge / DeepSeek 就都列出来；拉不到回落构建期的内置清单
  const voices = state.voiceOptions && state.voiceOptions.length > 0
    ? state.voiceOptions
    : VOICES.map((voice) => ({ id: voice.id, name: voice.name, tag: voice.tag, provider: voice.provider }));
  const speechProviders = state.speechProviders || [];
  return card('语音', '四类语音各一个开关，互不从属；音色、识别实现与音量共用。', [
    toggleRow('g-voice', '手动播报', '右键菜单与斜杠命令触发的碎碎念、对话回复念出来。', g.voiceEnabled, (value) => setGlobal('voiceEnabled', value)),
    selectField('g-voice-name', '音色', g.voiceName, voices.map((voice) => ({ value: voice.id, label: voice.name + (voice.tag ? ' · ' + voice.tag : ''), group: voice.provider })), (value) => setGlobal('voiceName', value)),
    numberField('g-voice-volume', '音量（0–1）', g.voiceVolume, (value) => setGlobal('voiceVolume', clampNumber(value, 0, 1, 1)), { min: 0, max: 1, step: 0.05 }),
    toggleRow('g-voice-whisper', '周期碎碎念也念出来', '定时生成的那句碎碎念念出来。', g.voiceWhisperEnabled, (value) => setGlobal('voiceWhisperEnabled', value)),
    toggleRow('g-voice-todo', '待办提醒也念出来', '到点的待办提醒念出来。', g.voiceTodoEnabled, (value) => setGlobal('voiceTodoEnabled', value)),
    toggleRow('g-voice-notify', '通知播报', '任务完成、出错、等你确认时念一句配置的工作状态文案；页面被藏起来也照样念。', g.voiceNotifyEnabled, (value) => setGlobal('voiceNotifyEnabled', value)),
    selectField('g-speech-provider', '语音识别', g.speechProvider, speechProviders.map((item) => ({ value: item.id, label: item.name })), (value) => setGlobal('speechProvider', value), '按住录音后交给哪个实现转写。装了对应插件才会出现多个选项；选中的实现不可用时识别会明确报错，不会自动换一个。'),
  ]);
}

function fontCard() {
  const g = state.globals;
  return card('外观与字体', '气泡、悬浮提示与对话窗共用的字体。', [
    selectField('g-font-family', '字体', g.font.family, FONT_IDS.map((id) => ({ value: id, label: id })), (value) => { g.font = Object.assign({}, g.font, { family: value }); }),
    numberField('g-font-size', '字号（px）', g.font.size, (value) => { g.font = Object.assign({}, g.font, { size: clampNumber(value, 4, 200, 21) }); }, { min: 4, max: 200, step: 1, hint: '只影响气泡与悬浮提示，对话窗字号不变。' }),
    toggleRow('g-font-follow', '字号随宠物大小缩放', '关掉后恒为上面的字号，不随窗口尺寸变化。', g.font.followPet, (value) => { g.font = Object.assign({}, g.font, { followPet: value }); }),
  ]);
}

function physicsCard() {
  const g = state.globals;
  return card('拖拽与抛掷手感', '所有宠物共用；数值改动保存后生效。', [
    make('div', { class: 'grid2' }, [
      numberField('g-gravity', '重力加速度（px/s²）', g.physics.gravity, (value) => { g.physics = Object.assign({}, g.physics, { gravity: clampNumber(value, 0, 10000, 1400) }); }, { min: 0, max: 10000, step: 10 }),
      numberField('g-restitution', '碰壁弹性（0–1）', g.physics.restitution, (value) => { g.physics = Object.assign({}, g.physics, { restitution: clampNumber(value, 0, 1, 0.78) }); }, { min: 0, max: 1, step: 0.01 }),
    ]),
    make('div', { class: 'grid2' }, [
      numberField('g-friction', '接触面摩擦（/s）', g.physics.groundFriction, (value) => { g.physics = Object.assign({}, g.physics, { groundFriction: clampNumber(value, 0, 30, 2.5) }); }, { min: 0, max: 30, step: 0.1 }),
      numberField('g-power', '总力度', g.physics.throwPower, (value) => { g.physics = Object.assign({}, g.physics, { throwPower: clampNumber(value, 0.1, 5, 1) }); }, { min: 0.1, max: 5, step: 0.1 }),
    ]),
    toggleRow('g-ceiling', '顶部反弹', '关掉后上方没有边界，抛掷可以飞出屏幕顶部。', g.physics.ceilingBounce !== false, (value) => { g.physics = Object.assign({}, g.physics, { ceilingBounce: value }); }),
    toggleRow('g-collide', '宠物互相碰撞', '飞行中的宠物撞到其它宠物时按动量弹开。', g.physics.petCollision !== false, (value) => { g.physics = Object.assign({}, g.physics, { petCollision: value }); }),
  ]);
}

function motionCard() {
  const g = state.globals;
  const weights = g.animationWeights;
  const actionId = 'g-motion-action';
  const actionValue = () => String(Math.max(0, 100 - weights.idle - weights.turn - weights.move));
  const syncAction = () => {
    const node = byId(actionId);
    if (node) node.value = actionValue();
  };
  const weightField = (key, label) =>
    numberField('g-motion-' + key, label, weights[key], (value) => {
      const others = weights.idle + weights.turn + weights.move - weights[key];
      const max = Math.max(0, 100 - others);
      weights[key] = Math.round(Math.min(Math.max(value, 0), max));
      syncAction();
    }, { min: 0, max: 100, step: 1 });
  return card('动作频率', '四个框：待机 / 转向 / 移动可改，随机动作自动算（= 100 − 其余三项）。所有宠物共用；pet pack 可在自己种类文件里覆盖。', [
    make('div', { class: 'grid2' }, [
      weightField('idle', '待机（%）'),
      weightField('turn', '转向（%）'),
      weightField('move', '移动（%）'),
      numberField(actionId, '随机动作（%，自动）', actionValue(), () => {}, { min: 0, max: 100, step: 1, readOnly: true }),
    ]),
  ]);
}

function modelCard() {
  const g = state.globals;
  return card('对话上下文', '模型与接入方式在「AI 服务商」页配置；这里只管对话保留多少上下文。', [
    make('div', { class: 'grid2' }, [
      numberField('g-memory', '对话记忆轮数', g.chatMemoryRounds, (value) => setGlobal('chatMemoryRounds', Math.round(clampNumber(value, 0, 100, 0))), { min: 0, max: 100, step: 1, hint: '0 表示不带历史。' }),
      numberField('g-image-limit', '配图张数上限', g.chatImageLimit, (value) => setGlobal('chatImageLimit', Math.round(clampNumber(value, 0, 50, 0))), { min: 0, max: 50, step: 1, hint: '0 表示不限制。' }),
    ]),
  ]);
}

function pathRows() {
  const meta = state.meta || {};
  const rows = [];
  const pairs = [['用户配置', meta.user], ['内置默认', meta.default], ['动画配置', meta.animations], ['表情包', meta.memes], ['待办数据', meta.todos], ['日志', meta.logs]];
  for (const pair of pairs) {
    if (!pair[1]) continue;
    rows.push(make('div', { class: 'pathRow' }, [
      make('span', { class: 'pathKey', text: pair[0] }),
      make('span', { class: 'pathValue', text: String(pair[1]), title: String(pair[1]) }),
    ]));
  }
  if (Array.isArray(meta.storage)) {
    for (const item of meta.storage) {
      if (!item || !item.path) continue;
      rows.push(make('div', { class: 'pathRow' }, [
        make('span', { class: 'pathKey', text: item.exists === false ? '未生成' : '已存在' }),
        make('span', { class: 'pathValue', text: String(item.path), title: String(item.path) }),
      ]));
    }
  }
  return rows.length ? rows : [make('p', { class: 'empty', text: '读不到落盘位置信息。' })];
}

function advancedCard() {
  return card('高级', '手改配置文件时可以从这里找到位置；「同步」会用内置默认覆盖用户配置。', [
    make('div', {}, pathRows()),
    make('div', { class: 'testRow' }, [button('用内置默认覆盖用户配置', syncFromDefault)]),
  ]);
}

async function syncFromDefault() {
  const confirmed = await confirmDialog({
    title: '用内置默认覆盖用户配置',
    text: '现有的用户配置会被整份替换，这个操作不能撤销。',
    confirmLabel: '覆盖',
    danger: true,
  });
  if (!confirmed) return;
  const status = byId('pet-status');
  setStatus(status, '正在同步…');
  try {
    const merged = await callApi('POST', '/config');
    initDrafts(merged);
    markDirty(false);
    renderPetsPanel();
    setStatus(status, '已用内置默认覆盖用户配置。', 'ok');
  } catch (error) {
    setStatus(status, error && error.message ? error.message : String(error), 'error');
  }
}
`;
}
