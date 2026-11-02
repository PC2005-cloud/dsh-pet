/**
 * 「桌宠配置」面板的宠物部分：条目切换、实例增删与每只宠物的字段编辑。
 *
 * 编辑的是一份草稿（state.pets），只有点保存才写盘：main 条目连同全局字段走 PUT /config，
 * 其余条目走 POST /pet-config。条目级全局字段不在这里，见 ./globals。
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

function petBar() {
  const list = currentPets();
  const options = list.map((pet, index) => ({ value: String(index), label: (pet.name || pet.id) + '（' + pet.id + '）' }));
  const picker = createSelect(options, String(state.petIndex), (value) => {
    state.petIndex = Number(value);
    renderPetsPanel();
  });
  picker.root.id = 'pet-picker';
  picker.root.firstElementChild.setAttribute('aria-label', '选择宠物');
  return make('div', { class: 'petBar' }, [
    picker.root,
    button('新增', addPet),
    button('删除', removePet, { danger: true }),
  ]);
}

function addPet() {
  const list = currentPets();
  let index = list.length + 1;
  let id = (state.entry === 'main' ? 'pet-' : '') + index;
  while (list.some((pet) => pet.id === id)) {
    index += 1;
    id = (state.entry === 'main' ? 'pet-' : '') + index;
  }
  list.push({
    id: id,
    name: '新宠物',
    size: 462,
    display: 'none',
    balanceEnabled: true,
    whisperEnabled: true,
    workStatusEnabled: true,
    fixedEnabled: false,
    position: { corner: 'bottom-right', marginX: 40, marginY: 40 },
  });
  state.petIndex = list.length - 1;
  markDirty(true);
  renderPetsPanel();
}

async function removePet() {
  const list = currentPets();
  const pet = list[state.petIndex];
  if (!pet) return;
  if (list.length <= 1) {
    await confirmDialog({
      title: '不能删除最后一只',
      text:
        state.entry === 'main'
          ? '默认条目至少要留一只宠物：删到 0 会被宿主按非法拒绝，重开时还会退回内置的默认列表。'
          : '每个条目至少要留一只宠物：删到 0 会被宿主按非法拒绝。',
      confirmLabel: '知道了',
      cancelLabel: null,
    });
    return;
  }
  const confirmed = await confirmDialog({
    title: '删除宠物',
    text: '删除「' + (pet.name || pet.id) + '」？点保存后才会写盘。',
    confirmLabel: '删除',
    danger: true,
  });
  if (!confirmed) return;
  list.splice(state.petIndex, 1);
  state.petIndex = Math.max(0, Math.min(state.petIndex, list.length - 1));
  markDirty(true);
  renderPetsPanel();
}

function petCard() {
  const list = currentPets();
  const pet = list[state.petIndex];
  if (!pet) {
    return card('宠物', null, [
      make('p', { class: 'empty', text: '这个条目下还没有实例，点「新增」加一只。' }),
      make('div', { class: 'testRow' }, [button('新增', addPet)]),
    ]);
  }
  if (!pet.position) pet.position = { corner: 'bottom-right', marginX: 40, marginY: 40 };
  const sizePercent = typeof pet.sizePercent === 'number' ? String(pet.sizePercent) : '';
  const children = [
    petBar(),
    textField('pet-name', '显示名', pet.name || '', (value) => { pet.name = value; }),
    textField('pet-id', '标识（id）', pet.id, (value) => { pet.id = value.trim(); }, { disabled: true, hint: '标识决定素材目录与记忆文件，建好之后不能在这里改。' }),
    make('div', { class: 'grid2' }, [
      numberField('pet-size', '画框大小（px）', pet.size, (value) => { pet.size = value; }, { min: 1, step: 1 }),
      textField('pet-size-percent', '占屏宽度（%）', sizePercent, (value) => {
        if (value.trim() === '') delete pet.sizePercent;
        else pet.sizePercent = Number(value);
      }, { hint: '留空表示按 px 显示。' }),
    ]),
    selectField('pet-display', '显示位置', pet.display, DISPLAYS.map((value) => ({ value: value, label: displayLabel(value) })), (value) => { pet.display = value; }, 'web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示'),
    make('div', { class: 'grid2' }, [
      selectField('pet-corner', '停靠角落', pet.position.corner, CORNERS.map((value) => ({ value: value, label: cornerLabel(value) })), (value) => { pet.position.corner = value; }),
      numberField('pet-margin-x', '水平边距（px）', pet.position.marginX, (value) => { pet.position.marginX = value; }, { step: 1 }),
    ]),
    numberField('pet-margin-y', '垂直边距（px）', pet.position.marginY, (value) => { pet.position.marginY = value; }, { step: 1 }),
    toggleRow('pet-balance', '余额功能', '开启后这只宠物会在余额变化时播动画并显示气泡。', pet.balanceEnabled !== false, (value) => { pet.balanceEnabled = value; }),
    toggleRow('pet-whisper', '碎碎念', '按周期让模型生成一句话并播放；不需要就关掉，省调用额度。', pet.whisperEnabled !== false, (value) => { pet.whisperEnabled = value; }),
    toggleRow('pet-work', '工作状态联动', '跟随会话状态切换动画与气泡，不调用模型。', pet.workStatusEnabled !== false, (value) => { pet.workStatusEnabled = value; }),
    toggleRow('pet-fixed', '固定不动', '开启后随机链不再抽转向与移动；手动点播与拖拽照常。', pet.fixedEnabled === true, (value) => { pet.fixedEnabled = value; }),
    make('div', { class: 'field' }, [
      make('label', { for: 'pet-persona', text: '这只的人设（可选）' }),
      personaWrap(pet),
      make('p', { class: 'fieldHint', text: personaHint() }),
      make('p', { class: 'fieldHint', text: '发给模型的 system = 这段 + 自动追加的名字与时间背景，别在这里重复写。' }),
    ]),
  ];
  return card('宠物', '这里编辑的是 ' + (state.entry === 'main' ? '默认条目' : state.entry) + ' 的实例；改动在点保存后写盘。', children);
}

/** 条目人设提示：占位符里放的就是条目人设正文，这里只说规则。 */
function personaHint() {
  if (state.prompts[state.entry]) return '留空 = 跟随所属条目的人设，输入框里的灰色文字就是那份内容。';
  return '这个条目还没写人设；留空表示这只宠物没有系统提示词。';
}

/** 人设输入框连同右下角的字数统计；占位符用条目人设全文。 */
function personaWrap(pet) {
  const wrap = make('div', { class: 'personaWrap' });
  const area = make('textarea', { id: 'pet-persona' });
  area.value = typeof pet.whisperPrompt === 'string' ? pet.whisperPrompt : '';
  area.maxLength = 4000;
  area.rows = 4;
  const entryPrompt = state.prompts[state.entry] || '';
  area.placeholder = entryPrompt || '留空则没有系统提示词';
  const count = make('span', { class: 'personaCount', text: area.value.length + ' 字' });
  area.addEventListener('input', () => {
    const text = area.value.trim();
    if (text) pet.whisperPrompt = area.value;
    else delete pet.whisperPrompt;
    count.textContent = area.value.length + ' 字';
    markDirty(true);
  });
  wrap.append(area, count);
  return wrap;
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
