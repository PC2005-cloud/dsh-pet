/**
 * 「桌宠配置」面板的草稿与保存：条目切换、实例列表的读入、面板装配与两个写接口。
 *
 * 编辑的是一份草稿（state.pets），只有点保存才写盘：main 条目连同全局字段走 PUT /config，
 * 其余条目走 POST /pet-config。单只宠物的字段与增删见 ./pet-card，条目级全局字段见 ./globals。
 * @module dsh-pet/src/standalone/settings-page/script/pets
 */

/** 生成宠物面板片段。 */
export function petsScript(): string {
  return `
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 原配置里的 physics 段，用来判断哪些可选键「本来就有」。 */
let physicsSource = null;

/** 动作频率权重：缺字段或非法项回落到内置默认，三项各自独立判定。 */
function pickWeights(raw) {
  const base = Object.assign({}, FALLBACK_WEIGHTS);
  if (!raw || typeof raw !== 'object') return base;
  for (const key of ['idle', 'turn', 'move']) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value >= 0) base[key] = value;
  }
  return base;
}

function pickGlobals(main) {
  const source = main || {};
  const physics = source.physics && typeof source.physics === 'object' ? source.physics : null;
  physicsSource = physics;
  return {
    notificationsEnabled: source.notificationsEnabled !== false,
    clickSoundEnabled: source.clickSoundEnabled !== false,
    whisperImageEnabled: source.whisperImageEnabled === true,
    chatImageEnabled: source.chatImageEnabled === true,
    chatAnimationEnabled: source.chatAnimationEnabled === true,
    confineToScreen: source.confineToScreen === true,
    trayEnabled: source.trayEnabled !== false,
    voiceEnabled: source.voiceEnabled === true,
    voiceName: typeof source.voiceName === 'string' && source.voiceName ? source.voiceName : (VOICES[1] ? VOICES[1].id : ''),
    voiceVolume: typeof source.voiceVolume === 'number' ? source.voiceVolume : 1,
    voiceWhisperEnabled: source.voiceWhisperEnabled !== false,
    voiceTodoEnabled: source.voiceTodoEnabled !== false,
    physics: Object.assign({}, FALLBACK_PHYSICS, source.physics || {}),
    font: Object.assign({}, FALLBACK_FONT, source.font || {}),
    chatMemoryRounds: Number.isFinite(Number(source.chatMemoryRounds)) ? Number(source.chatMemoryRounds) : 0,
    chatImageLimit: Number.isFinite(Number(source.chatImageLimit)) ? Number(source.chatImageLimit) : 0,
    animationWeights: pickWeights(source.animationWeights),
  };
}

function initDrafts(config) {
  state.config = config;
  state.globals = pickGlobals(config.main);
  state.pets = {};
  state.prompts = {};
  for (const key of Object.keys(config)) {
    const conf = config[key];
    if (!conf || !Array.isArray(conf.pets)) continue;
    state.pets[key] = cloneJson(conf.pets);
    if (typeof conf.whisperPrompt === 'string') state.prompts[key] = conf.whisperPrompt;
  }
  if (!state.pets.main) state.pets.main = [];
  if (!state.pets[state.entry]) state.entry = 'main';
}

function currentPets() {
  return state.pets[state.entry] || [];
}

function currentPet() {
  return currentPets()[state.petIndex];
}

function entryTabs(keys) {
  const tabs = keys.map((key) => tabButton(key === 'main' ? '默认条目' : key, key === state.entry, () => {
    state.entry = key;
    state.petIndex = 0;
    renderPetsPanel();
  }));
  return make('div', { class: 'tabs' }, tabs);
}

function packNote() {
  return card('条目说明', null, [
    make('p', { class: 'cardHint', text: '这个条目来自文件宠物，只保存它自己的实例；全局开关与语音外观在「默认条目」里改。' }),
  ]);
}

function renderPetsPanel() {
  const host = byId('pet-cards');
  if (!host) return;
  host.textContent = '';
  const keys = Object.keys(state.pets);
  if (keys.length > 1) host.append(entryTabs(keys));
  host.append(petCard());
  if (state.entry === 'main') {
    for (const builder of globalCards()) host.append(builder());
  } else {
    host.append(packNote());
  }
}

/** 提交用的 physics 段：原配置没写过的可选键不带出去，避免保存时凭空补键。 */
function physicsBody() {
  const out = Object.assign({}, state.globals.physics);
  for (const key of ['tiltGravity', 'shakeThrow', 'hapticEnabled']) {
    if (!physicsSource || !(key in physicsSource)) delete out[key];
  }
  return out;
}

function petsBody() {
  return Object.assign({ pets: state.pets.main }, {
    notificationsEnabled: state.globals.notificationsEnabled,
    clickSoundEnabled: state.globals.clickSoundEnabled,
    whisperImageEnabled: state.globals.whisperImageEnabled,
    chatImageEnabled: state.globals.chatImageEnabled,
    chatAnimationEnabled: state.globals.chatAnimationEnabled,
    confineToScreen: state.globals.confineToScreen,
    trayEnabled: state.globals.trayEnabled,
    voiceEnabled: state.globals.voiceEnabled,
    voiceName: state.globals.voiceName,
    voiceVolume: state.globals.voiceVolume,
    voiceWhisperEnabled: state.globals.voiceWhisperEnabled,
    voiceTodoEnabled: state.globals.voiceTodoEnabled,
    physics: physicsBody(),
    font: state.globals.font,
    chatMemoryRounds: state.globals.chatMemoryRounds,
    chatImageLimit: state.globals.chatImageLimit,
    animationWeights: state.globals.animationWeights,
  });
}

async function savePets() {
  const status = byId('pet-status');
  const saveBtn = byId('pet-save');
  if (state.entry === 'main' && currentPets().length === 0) {
    setStatus(status, '默认条目至少要保留一只宠物，否则宿主会拒绝保存。', 'error');
    return;
  }
  saveBtn.disabled = true;
  setStatus(status, '正在保存…');
  try {
    let merged;
    if (state.entry === 'main') {
      merged = await callApi('PUT', '/config', petsBody());
      if (merged && merged.ok === false && merged.reason === 'user-config-unparsable') {
        const file = merged.userFile ? String(merged.userFile) : '用户配置';
        const confirmed = await confirmDialog({
          title: '配置文件无法解析',
          text: file + '\\n继续保存会按白名单重建这个文件，里面其它内容会丢失。',
          confirmLabel: '覆盖保存',
          danger: true,
        });
        if (!confirmed) {
          setStatus(status, '已取消保存。', 'error');
          return;
        }
        merged = await callApi('PUT', '/config?force=1', petsBody());
      }
    } else {
      merged = await callApi('POST', '/pet-config', { entry: state.entry, pets: currentPets() });
    }
    if (!merged || merged.ok === false) {
      setStatus(status, (merged && (merged.message || merged.reason)) || '宿主拒绝了这次保存。', 'error');
      return;
    }
    initDrafts(merged);
    markDirty(false);
    renderPetsPanel();
    setStatus(status, '已保存到本机。', 'ok');
  } catch (error) {
    setStatus(status, error && error.message ? error.message : String(error), 'error');
  } finally {
    saveBtn.disabled = false;
  }
}
`;
}
