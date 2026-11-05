/** Browser-side setup controller; secrets are sent once and cleared, never restored from status. */
export function setupScript(): string {
  return `
let setupTimer = null;
let setupWasBusy = false;
async function setupRequest(body) {
  const response = await fetch('/standalone-ai/setup', {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取准备状态，请从桌宠菜单重新打开设置。');
  return data;
}
function showSetup(data) {
  setStatus(byId('setup-status'), data.message, data.stage === 'error' ? 'error' : data.stage === 'ready' ? 'ok' : '');
  byId('setup-start').disabled = data.busy;
  byId('setup-retry').hidden = !data.configured;
  byId('setup-stop').hidden = !data.configured;
  byId('setup-retry').disabled = data.busy;
  byId('setup-stop').disabled = data.busy;
  byId('setup-chat').hidden = !data.chatReady;
  byId('setup-checks').textContent = '聊天：' + (data.chatReady ? '已配置' : '待配置') + ' · 长期记忆：' + (data.memoryReady ? '服务已就绪' : '未就绪或未开启');
  if (setupWasBusy && !data.busy) { loadAi(); loadPets(); }
  setupWasBusy = data.busy;
  clearTimeout(setupTimer);
  if (data.busy || data.memoryReady) setupTimer = setTimeout(refreshSetup, data.busy ? 1000 : 5000);
}
async function refreshSetup() {
  try { showSetup(await setupRequest()); }
  catch (error) { setStatus(byId('setup-status'), error.message, 'error'); }
}
function wireSetup() {
  byId('setup-provider').addEventListener('change', () => {
    const preset = byId('setup-provider').value;
    byId('setup-model-details').open = preset === 'custom';
    byId('setup-model').value = preset === 'openai' ? 'gpt-4.1-mini' : preset === 'qwen' ? 'qwen3.7-plus' : '';
    byId('setup-embedding-model').value = preset === 'openai' ? 'text-embedding-3-small' : preset === 'qwen' ? 'qwen3.7-text-embedding' : '';
    byId('setup-dimension').value = preset === 'openai' ? '1536' : '1024';
    byId('setup-url').value = preset === 'openai' ? 'https://api.openai.com/v1' : '';
    byId('setup-key').value = '';
  });
  byId('setup-memory').addEventListener('change', () => { byId('setup-embedding-fields').hidden = !byId('setup-memory').checked; });
  byId('setup-chat').addEventListener('click', () => selectTab('chat'));
  for (const action of ['retry', 'stop']) byId('setup-' + action).addEventListener('click', async () => {
    try { showSetup(await setupRequest({ action: action })); }
    catch (error) { setStatus(byId('setup-status'), error.message, 'error'); }
  });
  byId('quick-setup').addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('setup-start').disabled = true;
    const value = (id) => byId(id).value.trim();
    const body = { action: 'start', memory: byId('setup-memory').checked, baseUrl: value('setup-url'), model: value('setup-model'), apiKey: value('setup-key') };
    if (body.memory) Object.assign(body, { embeddingBaseUrl: value('setup-embedding-url') || value('setup-url'), embeddingModel: value('setup-embedding-model'), embeddingApiKey: value('setup-embedding-key') || value('setup-key'), embeddingDimension: Number(value('setup-dimension')) });
    try {
      showSetup(await setupRequest(body));
      byId('setup-key').value = ''; byId('setup-embedding-key').value = '';
    } catch (error) { byId('setup-start').disabled = false; setStatus(byId('setup-status'), error.message, 'error'); }
  });
  setupRequest().then((data) => {
    if (!data.chatReady) selectTab('setup');
    if (data.models) {
      for (const pair of [['setup-url','baseUrl'], ['setup-model','model'], ['setup-embedding-url','embeddingBaseUrl'], ['setup-embedding-model','embeddingModel'], ['setup-dimension','embeddingDimension']]) byId(pair[0]).value = data.models[pair[1]];
      byId('setup-provider').value = 'custom';
      byId('setup-memory').checked = true; byId('setup-embedding-fields').hidden = false;
    }
    showSetup(data);
  }).catch(() => { setStatus(byId('setup-status'), '此环境请使用「配置」中的模型连接与长期记忆设置。'); });
}
`;
}
