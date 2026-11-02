/**
 * 设置页启动：分区切换、初次加载与保存按钮接线。
 *
 * 两个面板各自加载各自的接口；桌宠配置读 /config，AI 面板读 /standalone-ai/settings。
 * 缺令牌时只提示、不发任何请求——本页所有写操作都依赖那次运行有效的凭证。
 * @module dsh-pet/src/standalone/settings-page/script/boot
 */

/** 生成启动片段。 */
export function bootScript(): string {
  return `
let protocolSelect = null;

function mountProtocolSelect() {
  const host = byId('protocol-host');
  if (!host) return;
  protocolSelect = createSelect(
    [
      { value: 'openai-compatible', label: 'OpenAI 兼容' },
      { value: 'anthropic', label: 'Anthropic' },
    ],
    'openai-compatible',
    () => forgetModelOptions(),
  );
  protocolSelect.root.firstElementChild.setAttribute('aria-labelledby', 'protocol-label');
  host.append(protocolSelect.root);
}

function selectTab(name) {
  for (const cell of document.querySelectorAll('[data-tab]')) {
    cell.setAttribute('aria-selected', cell.dataset.tab === name ? 'true' : 'false');
  }
  const pets = byId('panel-pets');
  const ai = byId('panel-ai');
  if (pets) pets.hidden = name !== 'pets';
  if (ai) ai.hidden = name !== 'ai';
}

function wireTabs() {
  const cells = Array.prototype.slice.call(document.querySelectorAll('.navCell'));
  cells.forEach((cell, index) => {
    cell.addEventListener('click', () => selectTab(cell.dataset.tab));
    cell.addEventListener('keydown', (event) => {
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
      if (!forward && !backward) return;
      event.preventDefault();
      const step = forward ? 1 : -1;
      const next = cells[(index + step + cells.length) % cells.length];
      next.focus();
      selectTab(next.dataset.tab);
    });
  });
}

async function loadPets() {
  const status = byId('pet-status');
  setStatus(status, '正在读取本机配置…');
  try {
    const config = await callApi('GET', '/config');
    const meta = await callApi('GET', '/config/meta').catch(() => null);
    if (!config || config.ok === false || !config.main) throw new Error('读取配置失败：宿主没有返回可用的配置。');
    state.meta = meta;
    initDrafts(config);
    renderPetsPanel();
    byId('pet-save').disabled = false;
    setStatus(status, '');
  } catch (error) {
    setStatus(status, (error && error.message) || String(error), 'error');
  }
}

async function loadAi() {
  const status = byId('status');
  try {
    populateAi(await aiRequest('GET'));
    byId('save').disabled = false;
    setStatus(status, '设置只在本机保存。');
  } catch (error) {
    setStatus(status, (error && error.message) || String(error), 'error');
  }
}

function boot() {
  wireTabs();
  selectTab('pets');
  if (!TOKEN) {
    const hint = '请从桌宠菜单或本机启动器打开设置，以获得本次运行的访问凭据。';
    setStatus(byId('pet-status'), hint, 'error');
    setStatus(byId('status'), hint, 'error');
    return;
  }
  mountProtocolSelect();
  wireAiPanel();
  byId('pet-save').addEventListener('click', savePets);
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  loadPets();
  loadAi();
}
`;
}
