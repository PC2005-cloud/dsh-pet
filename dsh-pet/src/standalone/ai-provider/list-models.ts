/** 独立模式「拉取模型」：按协议向配置的端点要一份模型清单，只读一次响应，不缓存也不落盘。 */
import type { StandaloneAiSettings } from '../ai-config.ts';
import type { AiFetch } from '../ai-transport.ts';
import type { DiscoveredModel, ModelDiscoveryInput, ModelDiscoveryResult } from './types.ts';

/** 发现请求的封顶时长：比正式通道短，用户在设置页等着看结果。 */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** 响应体上限：OpenRouter 的全量清单约 300KB，留出余量又不至于被超大响应拖住。 */
const MAX_DISCOVERY_BYTES = 1_000_000;
/** 单页条数上限；Anthropic 的 limit 参数上限就是 1000。 */
const PAGE_LIMIT = 1000;

/** 失败分类对应的可操作说明；响应正文与密钥一律不进文案。 */
const FAILURE_TEXT: Record<string, string | undefined> = {
  input: '请先填写接口地址与 API 密钥',
  auth: '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确',
  'rate-limit': '请求受限或配额超限 (HTTP 429)：请检查账户余额或调用频率',
  'not-found': '该地址下没有模型列表 (HTTP 404)：请检查地址是否以 /v1 结尾',
  contract: '端点返回的不是模型列表：请确认协议选择与服务商一致',
  timeout: '连接超时（10 秒未响应）：请检查网络连通性或服务器状态',
  network: '无法连接到目标服务器：请检查地址与端口是否正确',
  http: '接口返回了错误状态：请检查地址与凭据',
};

/** 判定一个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 组一份失败结果；文案只来自分类表或调用方给出的固定说明。 */
function failure(code: string, message?: string): ModelDiscoveryResult {
  return { ok: false, code, message: message ?? FAILURE_TEXT[code] ?? FAILURE_TEXT.http ?? '' };
}

/** 解析并校验端点：只接受不带账号、查询与片段的 HTTP(S) 地址，返回去掉结尾斜杠的前缀。 */
function parseEndpoint(value: string): string | undefined {
  if (/[\s\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * 候选清单地址：先按协议惯例，再按「地址里有没有带版本号」容错一次。
 * @param protocol - 已归一的协议。
 * @param base - 已校验的端点前缀，不含结尾斜杠。
 * @returns 按尝试顺序排列的地址。
 */
function candidateUrls(protocol: string, base: string): string[] {
  const versioned = /\/v\d+$/.test(base);
  if (protocol === 'anthropic') return [`${versioned ? base : `${base}/v1`}/models?limit=${PAGE_LIMIT}`];
  return versioned ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
}

/** 两个协议各自的鉴权头；明文密钥只在这一层出现，错误文案不会带它。 */
function authHeaders(protocol: string, apiKey: string): Record<string, string> {
  if (protocol === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' };
  }
  return { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
}

/** 把数组或「键 → 条目」映射统一成数组，两者都是兼容网关的常见写法。 */
function asList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const values = Object.values(value);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

/** 从一页响应里找出条目数组，认 `data`、`data.models` 与 `models` 三种位置。 */
function findListing(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = asList(payload.data);
  if (direct) return direct;
  if (isRecord(payload.data)) {
    const nested = asList(payload.data.models);
    if (nested) return nested;
  }
  return asList(payload.models);
}

/** 归一成「id + 展示名」，丢掉没有 id 的条目并按 id 去重，保持端点给出的顺序。 */
function normalize(entries: readonly unknown[]): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    const id = entry.id.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const label = [entry.name, entry.display_name].find((value) => typeof value === 'string' && value.trim() !== '');
    models.push({ id, name: typeof label === 'string' ? label.trim() : id });
  }
  return models;
}

/** 问一个地址要清单；非 404 的失败直接定型，404 交给调用方换下一个候选。 */
async function requestList(
  fetcher: AiFetch,
  url: string,
  headers: Record<string, string>,
  controller: AbortController,
): Promise<ModelDiscoveryResult> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
  } catch {
    return failure(controller.signal.aborted ? 'timeout' : 'network');
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'auth' : 'http';
    return failure(response.status === 404 ? 'not-found' : code);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return failure('contract');
  }
  if (text.length > MAX_DISCOVERY_BYTES) return failure('contract', '端点返回的模型列表过大，请改用支持分页的地址');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return failure('contract');
  }
  const entries = findListing(payload);
  return entries ? { ok: true, models: normalize(entries) } : failure('contract');
}

/**
 * 用表单里的草稿（或已保存值）拉取端点声明可用的模型。
 * @param fetcher - 传输实现，测试可替换以隔离网络。
 * @param current - 已保存的设置：输入里缺省的字段从这里取。
 * @param input - 用户在表单里填的值；空字符串视为未填。
 * @returns 成功时按端点顺序给出模型；失败时 code 稳定、message 可直接展示。
 */
export async function discoverModels(
  fetcher: AiFetch,
  current: StandaloneAiSettings,
  input: ModelDiscoveryInput,
): Promise<ModelDiscoveryResult> {
  const protocol =
    input.protocol === 'anthropic' || input.protocol === 'openai-compatible' ? input.protocol : current.protocol;
  const rawBase = (input.baseUrl !== undefined ? input.baseUrl : current.baseUrl).trim();
  const apiKey = (input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : current.apiKey).trim();
  if (rawBase === '') return failure('input', '请先填写接口地址（Base URL）');
  if (apiKey === '') return failure('input', '请先填写 API 密钥');
  const base = parseEndpoint(rawBase);
  if (base === undefined) return failure('input', '接口地址必须是 HTTP(S) 地址，且不能含账号、查询参数或片段');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    let last = failure('http');
    // 只在 404 时换下一个候选：其余失败说明地址对、但凭据或服务有问题，重试别的拼法没有意义。
    for (const url of candidateUrls(protocol, base)) {
      const attempt = await requestList(fetcher, url, authHeaders(protocol, apiKey), controller);
      if (attempt.ok || attempt.code !== 'not-found') return attempt;
      last = attempt;
    }
    return last;
  } finally {
    clearTimeout(timer);
  }
}
