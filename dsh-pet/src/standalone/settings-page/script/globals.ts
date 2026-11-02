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
  return [globalFlagsCard, voiceCard, fontCard, physicsCard, modelCard, advancedCard];
}

function setGlobal(key, value) {
  state.globals[key] = value;
}

function globalFlagsCard() {
  const g = state.globals;
  return card('全局开关', '对所有宠物生效；保存后立即写盘。', [
    toggleRow('g-notify', '系统通知', '对话完成、生成失败、权限申请等事件弹出系统通知。', g.notificationsEnabled, (value) => setGlobal('notificationsEnabled', value)),
    toggleRow('g-click', '点击音效', '点击宠物时播放内置音效。', g.clickSoundEnabled, (value) => setGlobal('clickSoundEnabled', value)),
    toggleRow('g-whisper-image', '碎碎念配图', '碎碎念时允许模型挑一张表情包。', g.whisperImageEnabled, (value) => setGlobal('whisperImageEnabled', value)),
    toggleRow('g-chat-image', '对话配图', '对话时把表情包清单交给模型按语境选图。', g.chatImageEnabled, (value) => setGlobal('chatImageEnabled', value)),
    toggleRow('g-chat-anim', '对话动作联动', '对话时让模型挑一个动作当场表演。', g.chatAnimationEnabled, (value) => setGlobal('chatAnimationEnabled', value)),
    toggleRow('g-confine', '锁定在当前屏幕', '抛掷与自主漫游只在当前所在的这块屏幕里活动。', g.confineToScreen, (value) => setGlobal('confineToScreen', value)),
    toggleRow('g-tray', '系统托盘图标', '桌面模式常驻托盘；关掉后只能从任务栏找回。', g.trayEnabled, (value) => setGlobal('trayEnabled', value)),
  ]);
}

function voiceCard() {
  const g = state.globals;
  return card('语音', '桌宠开口说话用的音色与音量。', [
    toggleRow('g-voice', '语音播报', '关闭后所有语音都静音，文字气泡不受影响。', g.voiceEnabled, (value) => setGlobal('voiceEnabled', value)),
    selectField('g-voice-name', '音色', g.voiceName, VOICES.map((voice) => ({ value: voice.id, label: voice.name + ' · ' + voice.tag })), (value) => setGlobal('voiceName', value)),
    numberField('g-voice-volume', '音量（0–1）', g.voiceVolume, (value) => setGlobal('voiceVolume', clampNumber(value, 0, 1, 1)), { min: 0, max: 1, step: 0.05 }),
    toggleRow('g-voice-whisper', '周期碎碎念也念出来', '关掉只影响周期碎碎念，手动对话照常发声。', g.voiceWhisperEnabled, (value) => setGlobal('voiceWhisperEnabled', value)),
    toggleRow('g-voice-todo', '待办提醒也念出来', '关掉只影响待办提醒的朗读。', g.voiceTodoEnabled, (value) => setGlobal('voiceTodoEnabled', value)),
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
