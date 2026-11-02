/**
 * 「AI 服务商」面板：独立模式自己的模型接入配置（协议、地址、模型、密钥、测试连接与删除密钥）。
 *
 * 读写独立模式专属的 /standalone-ai/settings，与插件配置那份文件互不相干；
 * 密钥只写不回显，请求一律带本次运行的访问令牌。AI 是否可用只看地址、模型与密钥是否齐全。
 * @module dsh-pet/src/standalone/settings-page/script/ai
 */

/** 生成 AI 面板片段。 */
export function aiScript(): string {
  return `
const AI_SETTINGS_URL = '/standalone-ai/settings';
const AI_TEST_URL = '/standalone-ai/test';

async function aiRequest(method, body) {
  const response = await fetch(AI_SETTINGS_URL, {
    method: method,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: body
      ? { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' }
      : { 'X-DSH-Pet-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
    if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
    throw new Error('设置未保存。请检查接口地址、模型名称与密钥，再重试。');
  }
  return response.json();
}

function populateAi(data) {
  if (data.protocol !== undefined && protocolSelect) protocolSelect.setValue(String(data.protocol));
  for (const id of ['baseUrl', 'model']) {
    if (data[id] !== undefined && byId(id)) byId(id).value = String(data[id]);
  }
  byId('key-state').textContent = data.hasKey ? '已保存 · 不回显' : '尚未设置';
  byId('key-actions').hidden = data.hasKey !== true;
  byId('apiKey').value = '';
  byId('apiKey').disabled = false;
}

function wireKeyDelete(status) {
  byId('key-delete').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '删除已保存的密钥',
      text: '删除后桌宠将无法再调用模型，需要重新填写密钥才能恢复。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    setStatus(status, '正在删除密钥…');
    try {
      populateAi(await aiRequest('POST', { clearApiKey: true }));
      setStatus(status, '已删除保存的密钥。', 'ok');
    } catch (error) {
      setStatus(status, error && error.message ? error.message : String(error), 'error');
    }
  });
}

function wireTest(testBtn, testResult) {
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.className = 'status';
    testResult.textContent = '正在测试连接，请稍候…';
    const input = {
      protocol: protocolSelect ? protocolSelect.getValue() : 'openai-compatible',
      baseUrl: byId('baseUrl').value.trim(),
      model: byId('model').value.trim(),
      apiKey: byId('apiKey').value.trim(),
    };
    try {
      const response = await fetch(AI_TEST_URL, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await response.json();
      if (data.ok) {
        testResult.className = 'status';
        testResult.dataset.ok = 'true';
        testResult.textContent = '✓ ' + data.message;
        if (data.reply) testResult.textContent += '；回复：' + data.reply;
      } else {
        testResult.className = 'status';
        testResult.dataset.error = 'true';
        testResult.textContent = '✗ ' + (data.message || data.error || '测试失败');
      }
    } catch (error) {
      testResult.className = 'status';
      testResult.dataset.error = 'true';
      testResult.textContent = '✗ 请求异常：' + (error && error.message ? error.message : String(error));
    } finally {
      testBtn.disabled = false;
    }
  });
}

function wireSave(form, save, status) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    setStatus(status, '正在保存到本机…');
    const input = {
      protocol: protocolSelect ? protocolSelect.getValue() : 'openai-compatible',
      baseUrl: byId('baseUrl').value.trim(),
      model: byId('model').value.trim(),
      apiKey: byId('apiKey').value,
    };
    byId('apiKey').value = '';
    try {
      populateAi(await aiRequest('POST', input));
      setStatus(status, '已保存到本机。', 'ok');
    } catch (error) {
      setStatus(status, error && error.message ? error.message : String(error), 'error');
    } finally {
      save.disabled = false;
    }
  });
}

function wireAiPanel() {
  wireModelPicker();
  const status = byId('status');
  wireKeyDelete(status);
  wireTest(byId('test-btn'), byId('test-result'));
  wireSave(byId('settings'), byId('save'), status);
}
`;
}
