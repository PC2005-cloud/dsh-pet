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
const AI_BALANCE_URL = '/standalone-ai/balance';

async function aiRequest(method, body) {
  const response = await fetch(AI_SETTINGS_URL, {
    method: method,
    credentials: 'same-origin',
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
  if (data.balanceProvider !== undefined && balanceSelect) balanceSelect.setValue(String(data.balanceProvider));
  byId('balance-btn').disabled = !balanceSelect || balanceSelect.getValue() === '';
  byId('key-state').textContent = data.hasKey ? '已保存 · 不回显' : '尚未设置';
  byId('key-actions').hidden = data.hasKey !== true;
  byId('apiKey').value = '';
  byId('apiKey').disabled = false;
}

/** 把余额结果翻成一行可读文案；失败一律说明原因，不显示伪造数字。 */
function describeBalance(data) {
  if (!data || data.ok !== true) {
    if (data && data.reason === 'credential-missing') return '缺少密钥：请先保存所选服务商的 API 密钥。';
    if (data && data.reason === 'unsupported') return '该服务商不提供余额查询。';
    return data && data.message ? '查询失败：' + data.message : '查询失败，请稍后重试。';
  }
  const payload = data.data || {};
  if (data.shape === 'money' && payload.wallets) {
    return payload.wallets
      .map(function (wallet) {
        return wallet.currency + ' ' + wallet.total;
      })
      .join(' / ');
  }
  if (data.shape === 'points') return payload.total + ' ' + payload.unit;
  if (data.shape === 'windows') return '月度已用 ' + payload.monthly + '%';
  return '已取到余额数据。';
}

function wireBalanceQuery() {
  const button = byId('balance-btn');
  const result = byId('balance-result');
  button.addEventListener('click', async () => {
    button.disabled = true;
    result.className = 'status';
    result.dataset.ok = '';
    result.dataset.error = '';
    result.textContent = '正在查询余额…';
    try {
      const response = await fetch(AI_BALANCE_URL, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-DSH-Pet-Token': TOKEN },
      });
      if (!response.ok) throw new Error('查询被拒绝（HTTP ' + response.status + '）');
      const data = await response.json();
      const ok = data && data.ok === true;
      if (ok) result.dataset.ok = 'true';
      else result.dataset.error = 'true';
      result.textContent = (ok ? '✓ ' : '✗ ') + describeBalance(data);
    } catch (error) {
      result.dataset.error = 'true';
      result.textContent = '✗ ' + (error && error.message ? error.message : String(error));
    } finally {
      button.disabled = !balanceSelect || balanceSelect.getValue() === '';
    }
  });
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
        credentials: 'same-origin',
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
      balanceProvider: balanceSelect ? balanceSelect.getValue() : '',
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
  wireBalanceQuery();
  wireSave(byId('settings'), byId('save'), status);
}
`;
}
