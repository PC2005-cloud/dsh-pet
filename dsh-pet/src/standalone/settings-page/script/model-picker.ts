/**
 * 模型字段的可手填下拉：输入框持有值，右侧箭头拉取候选并弹出菜单。
 *
 * 拉到的列表只留在内存，地址或协议一改就作废，避免拿 A 家的模型去配 B 家。
 * @module dsh-pet/src/standalone/settings-page/script/model-picker
 */

/** 生成模型选择片段。 */
export function modelPickerScript(): string {
  return `
const AI_MODELS_URL = '/standalone-ai/models';

/** 上一次拉到的候选；null 表示还没拉过，需要先请求。 */
let modelOptions = null;

function modelLabel(model) {
  return model.name && model.name !== model.id ? model.name + '（' + model.id + '）' : model.id;
}

function openModelMenu(trigger) {
  if (!modelOptions) return;
  openSelectMenu(
    trigger,
    modelOptions,
    byId('model').value.trim(),
    (picked) => {
      byId('model').value = picked;
      markDirty(true);
      setStatus(byId('model-result'), '已填入模型名称，记得保存。', 'ok');
    },
    byId('model-combo'),
  );
}

function forgetModelOptions() {
  modelOptions = null;
  setStatus(byId('model-result'), '');
}

async function fetchModelOptions(trigger) {
  const result = byId('model-result');
  trigger.disabled = true;
  setStatus(result, '正在向端点请求模型列表…');
  try {
    const response = await fetch(AI_MODELS_URL, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: protocolSelect ? protocolSelect.getValue() : 'openai-compatible',
        baseUrl: byId('baseUrl').value.trim(),
        apiKey: byId('apiKey').value,
      }),
    });
    if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
    const data = await response.json().catch(() => null);
    if (!data) throw new Error('本机接口没有返回结果，请重试。');
    if (!data.ok) throw new Error(data.message || '拉取失败');
    const models = data.models || [];
    if (!models.length) {
      setStatus(result, '端点没有返回任何模型，请手动填写。', 'error');
      return;
    }
    modelOptions = models.map((model) => ({ value: model.id, label: modelLabel(model) }));
    setStatus(result, '已拉取 ' + models.length + ' 个模型，选中即可填入。', 'ok');
    openModelMenu(trigger);
  } catch (error) {
    setStatus(result, error && error.message ? error.message : String(error), 'error');
  } finally {
    trigger.disabled = false;
  }
}

function wireModelPicker() {
  const toggle = byId('model-toggle');
  if (!toggle) return;
  toggle.append(chevron());
  toggle.addEventListener('click', () => {
    if (modelOptions) openModelMenu(toggle);
    else void fetchModelOptions(toggle);
  });
  byId('baseUrl').addEventListener('input', forgetModelOptions);
}
`;
}
