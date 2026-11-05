/** Browser-side setup: drafts are separate from persisted state; credentials never round-trip. */
export function setupScript(): string {
  return `
let setupTimer = null;
let setupWasBusy = false;
let setupData = null;
let setupDirty = false;
let setupInitialized = false;
const setupPresets = {
  qwen: { model: 'qwen3.7-plus', embedding: 'qwen3.7-text-embedding', dimension: 1024 },
  openai: { model: 'gpt-4.1-mini', embedding: 'text-embedding-3-small', dimension: 1536 },
};
function sameSetupEndpoint(a, b) { return !!a && a.replace(/\\/+$/, '') === b.replace(/\\/+$/, ''); }
async function setupRequest(body) {
  const response = await fetch('/standalone-ai/setup', {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取准备状态，请从桌宠菜单重新打开设置。');
  return data;
}
function setupKeyState() {
  const chat = setupData && setupData.chat;
  const saved = chat && chat.protocol === 'openai-compatible' && chat.hasKey && sameSetupEndpoint(chat.baseUrl, byId('setup-url').value.trim());
  byId('setup-key').required = !saved;
  byId('setup-key').placeholder = saved ? '已保存；留空继续使用，更换密钥时填写' : '填写此服务商的密钥';
  byId('setup-key-hint').textContent = saved ? '当前地址已保存密钥，不回显，无需再次填写。' : '更换服务地址后需要填写对应的密钥。';
}
function setupControls() {
  const reuse = byId('setup-reuse').checked;
  for (const id of ['setup-provider', 'setup-region', 'setup-url', 'setup-model', 'setup-key']) byId(id).disabled = reuse;
  byId('setup-region-row').hidden = byId('setup-provider').value !== 'qwen' || reuse;
  byId('setup-embedding-fields').hidden = !byId('setup-memory').checked;
  for (const id of ['setup-embedding-model', 'setup-dimension']) byId(id).required = byId('setup-memory').checked;
  setupKeyState();
}
function chooseSetupPreset() {
  const name = byId('setup-provider').value;
  const preset = setupPresets[name];
  byId('setup-url').value = name === 'openai' ? 'https://api.openai.com/v1' : name === 'qwen'
    ? (byId('setup-region').value === 'singapore' ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' : 'https://dashscope.aliyuncs.com/compatible-mode/v1') : '';
  byId('setup-model').value = preset ? preset.model : '';
  byId('setup-key').value = '';
  if (!(setupData && setupData.models)) {
    byId('setup-embedding-model').value = preset ? preset.embedding : '';
    byId('setup-dimension').value = preset ? preset.dimension : '';
    byId('setup-embedding-url').value = '';
    byId('setup-embedding-key').value = '';
  }
  byId('setup-model-details').open = name === 'custom';
  setupControls();
}
function fillSetup(data) {
  const chat = data.chat;
  const reuse = !!(chat && chat.hasKey && chat.baseUrl && chat.model && chat.protocol === 'openai-compatible');
  byId('setup-reuse-row').hidden = !reuse;
  byId('setup-reuse').checked = reuse;
  byId('setup-saved-chat').textContent = reuse ? '已保存：' + chat.model + ' · ' + chat.baseUrl + '。无需重新填写 Key。' : '';
  if (reuse) {
    byId('setup-url').value = chat.baseUrl;
    byId('setup-model').value = chat.model;
    byId('setup-provider').value = 'custom';
    if (!data.models) {
      const endpoint = new URL(chat.baseUrl);
      const preset = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(endpoint.hostname) || endpoint.hostname.endsWith('.maas.aliyuncs.com') ? setupPresets.qwen
        : sameSetupEndpoint(chat.baseUrl, 'https://api.openai.com/v1') ? setupPresets.openai : null;
      byId('setup-embedding-model').value = preset ? preset.embedding : '';
      byId('setup-dimension').value = preset ? preset.dimension : '';
    }
  }
  if (data.models) {
    for (const pair of [['setup-embedding-url','embeddingBaseUrl'], ['setup-embedding-model','embeddingModel'], ['setup-dimension','embeddingDimension']]) byId(pair[0]).value = data.models[pair[1]];
  }
  for (const id of ['setup-embedding-url', 'setup-embedding-model', 'setup-dimension']) byId(id).readOnly = !!data.models;
  byId('setup-embedding-hint').textContent = data.models ? '已有记忆库的模型、地址和维度保持不变；可以更新密钥。' : '模型须在账户和地域中可用；自定义聊天服务还需配置 Embedding，也可填写另一家服务。';
  byId('setup-memory').checked = !!data.memoryEnabled;
  byId('setup-key').value = ''; byId('setup-embedding-key').value = '';
  setupControls();
}
function showSetup(data) {
  setupData = data;
  if (!setupInitialized) {
    setupInitialized = true;
    if (!data.chatReady) selectTab('setup');
    if (!setupDirty) fillSetup(data);
  }
  const completed = setupWasBusy && !data.busy;
  setStatus(byId('setup-status'), data.message, data.stage === 'error' ? 'error' : data.stage === 'ready' ? 'ok' : '');
  byId('setup-start').disabled = data.busy;
  byId('setup-fields').disabled = data.busy;
  byId('setup-retry').hidden = data.busy || !data.canRetry || (data.memoryReady && data.stage !== 'error');
  byId('setup-retry').disabled = data.busy;
  byId('setup-retry').textContent = data.retryDraft ? '重试本次设置' : data.memoryEnabled ? '重试启动记忆' : '恢复记忆';
  byId('setup-stop').hidden = !(data.memoryEnabled || data.memoryRunning);
  byId('setup-stop').disabled = data.busy;
  byId('setup-cancel').hidden = !data.busy;
  byId('setup-cancel').disabled = !data.canCancel;
  byId('setup-chat').hidden = !data.chatReady;
  byId('setup-chat').textContent = data.busy ? '先去聊天（记忆准备中）' : '去聊天';
  const memory = data.memoryReady ? '服务已就绪' : data.busy ? '准备中' : data.configured && !data.memoryEnabled ? '已暂停，数据保留' : data.memoryEnabled ? '暂不可用，可重试' : '未开启';
  byId('setup-checks').textContent = '聊天：' + (data.chatReady ? '已配置' : '待配置') + ' · 长期记忆：' + memory;
  byId('setup-steps').hidden = !data.busy;
  const step = ['checking', 'checking_embedding'].includes(data.stage) ? 0
    : ['checking_runtime', 'downloading', 'installing_python', 'installing_memory'].includes(data.stage) ? 1 : 2;
  Array.from(byId('setup-steps').children).forEach((li, i) => { if (i === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
  byId('setup-elapsed').hidden = !data.busy;
  byId('setup-elapsed').textContent = data.startedAt ? '已等待 ' + Math.max(0, Math.floor((Date.now() - data.startedAt) / 1000)) + ' 秒；可取消，不会删除记忆。' : '';
  if (completed) {
    loadAi(); loadPets();
    if (data.stage === 'ready' || data.stage === 'stopped') { setupDirty = false; fillSetup(data); }
  } else if (!data.busy && !setupDirty) { byId('setup-memory').checked = !!data.memoryEnabled; setupControls(); }
  setupWasBusy = data.busy;
  clearTimeout(setupTimer);
  setupTimer = setTimeout(refreshSetup, data.busy ? 1000 : 5000);
}
async function refreshSetup() {
  try { showSetup(await setupRequest()); }
  catch (error) {
    setStatus(byId('setup-status'), error.message + '；正在重新连接…', 'error');
    byId('setup-checks').textContent = '连接中断，当前状态未知。';
    for (const id of ['setup-start', 'setup-retry', 'setup-stop', 'setup-cancel']) byId(id).disabled = true;
    setupTimer = setTimeout(refreshSetup, 5000);
  }
}
function wireSetup() {
  byId('quick-setup').addEventListener('invalid', (event) => {
    if (byId('setup-model-details').contains(event.target)) byId('setup-model-details').open = true;
  }, true);
  byId('quick-setup').addEventListener('input', () => { setupDirty = true; });
  byId('quick-setup').addEventListener('change', () => { setupDirty = true; });
  byId('setup-provider').addEventListener('change', chooseSetupPreset);
  byId('setup-region').addEventListener('change', chooseSetupPreset);
  byId('setup-url').addEventListener('input', setupKeyState);
  byId('setup-reuse').addEventListener('change', () => {
    if (byId('setup-reuse').checked && setupData && setupData.chat) {
      byId('setup-url').value = setupData.chat.baseUrl; byId('setup-model').value = setupData.chat.model;
      byId('setup-key').value = '';
    }
    setupControls();
  });
  byId('setup-memory').addEventListener('change', () => {
    setupControls();
    if (byId('setup-memory').checked && (!byId('setup-embedding-model').value || !byId('setup-dimension').value)) byId('setup-model-details').open = true;
  });
  byId('setup-chat').addEventListener('click', () => selectTab('chat'));
  for (const action of ['retry', 'stop', 'cancel']) byId('setup-' + action).addEventListener('click', async () => {
    try { setupWasBusy = true; showSetup(await setupRequest({ action: action })); }
    catch (error) { setStatus(byId('setup-status'), error.message, 'error'); }
  });
  byId('quick-setup').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = (id) => byId(id).value.trim();
    const body = { action: 'start', memory: byId('setup-memory').checked, baseUrl: value('setup-url'), model: value('setup-model'), apiKey: value('setup-key') };
    if (body.memory) Object.assign(body, { embeddingBaseUrl: value('setup-embedding-url') || value('setup-url'), embeddingModel: value('setup-embedding-model'), embeddingApiKey: value('setup-embedding-key'), embeddingDimension: Number(value('setup-dimension')) });
    byId('setup-start').disabled = true;
    try {
      setupWasBusy = true;
      showSetup(await setupRequest(body));
      byId('setup-key').value = ''; byId('setup-embedding-key').value = '';
    } catch (error) { byId('setup-start').disabled = false; setStatus(byId('setup-status'), error.message, 'error'); }
  });
  refreshSetup();
}
`;
}
