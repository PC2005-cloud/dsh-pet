/**
 * 单只宠物的卡片：选择器、增删与这只宠物的字段编辑（含头像行与人设）。
 *
 * 只改 state.pets 里的草稿，不直接写盘——保存与草稿装配见 ./pets。
 * @module dsh-pet/src/standalone/settings-page/script/pet-card
 */

/** 生成宠物卡片片段。 */
export function petCardScript(): string {
  return `
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
    avatarRow(pet),
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
`;
}
