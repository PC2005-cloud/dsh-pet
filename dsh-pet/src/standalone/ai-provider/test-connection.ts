/**
 * 设置页「测试连接」：用一次最小请求验证地址、模型与密钥，把常见失败翻成可操作的说明。
 *
 * 不复用正式通道：不污染限流窗口、忙状态与暂停标记，超时也是独立的 15 秒。
 * 不判断服务是否已释放（归 ./create），也不校验设置是否已保存（用户可能正在填表单）。
 * @module dsh-pet/src/standalone/ai-provider/test-connection
 */
import { DEFAULT_AI_SETTINGS, type StandaloneAiSettings } from '../ai-config.ts';
import { isAuthenticationFailure, isRateLimitFailure, sdkTextStream, type AiFetch } from '../ai-transport.ts';
import type { TestConnectionInput, TestConnectionResult } from './types.ts';

/** 探测请求的封顶时长：与正式通道的设置超时无关，固定 15 秒。 */
const PROBE_TIMEOUT_MS = 15_000;
/** 收到这么多字符就认为连通，不再等模型把话说完。 */
const PROBE_MAX_CHARS = 40;

/** 三项必填的提示文案；都填了返回 null。 */
function missingField(baseUrl: string, model: string, apiKey: string): string | null {
  if (!baseUrl) return '请先填写接口地址（Base URL）';
  if (!model) return '请先填写模型名称';
  if (!apiKey) return '请先填写 API 密钥';
  return null;
}

/** 把探测失败翻成可操作的一句话；原始 message 只在兜底分支透出。 */
function describeFailure(error: unknown, controller: AbortController): string {
  if (controller.signal.aborted) return '连接超时（15 秒未响应）：请检查网络连通性或服务器状态';
  if (isAuthenticationFailure(error)) return '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确';
  if (isRateLimitFailure(error)) return '请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率';
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('404')) return '接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称';
  if (raw.includes('ECONNREFUSED') || raw.includes('fetch failed')) {
    return '无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行';
  }
  return `连接失败：${raw}`;
}

/**
 * 跑一次探测请求。
 * @param fetcher - 传输实现（生产是官方 SDK 的 fetch）。
 * @param current - 当前已保存的设置：输入里缺省的字段从这里取。
 * @param input - 用户在表单里填的值。
 * @returns 成功时带一句模型回复；失败时 message 说明该改哪里。
 */
export async function testAiConnection(
  fetcher: AiFetch,
  current: StandaloneAiSettings,
  input: TestConnectionInput,
  signal?: AbortSignal,
): Promise<TestConnectionResult> {
  const protocol = input.protocol === 'anthropic' ? 'anthropic' : (input.protocol ?? current.protocol);
  const baseUrl = (input.baseUrl !== undefined ? input.baseUrl : current.baseUrl).trim();
  const model = (input.model !== undefined ? input.model : current.model).trim();
  const apiKey = (input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : current.apiKey).trim();
  const missing = missingField(baseUrl, model, apiKey);
  if (missing !== null) return { ok: false, message: missing };

  const settings: StandaloneAiSettings = {
    ...DEFAULT_AI_SETTINGS,
    protocol: protocol as 'openai-compatible' | 'anthropic',
    baseUrl,
    model,
    apiKey,
    maxTokens: 32,
    timeoutMs: PROBE_TIMEOUT_MS,
  };
  const controller = new AbortController();
  signal?.throwIfAborted();
  const cancel = (): void => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const probe = sdkTextStream(
      settings,
      { system: '', messages: [{ role: 'user', content: 'hi' }] },
      controller.signal,
      fetcher,
    );
    let reply = '';
    for await (const chunk of probe) {
      if (chunk.refusal) return { ok: false, message: '模型拒绝回答该测试请求' };
      if (!chunk.text) continue;
      reply += chunk.text;
      if (reply.length >= PROBE_MAX_CHARS) break;
    }
    return reply.trim()
      ? { ok: true, message: '连接成功！模型响应正常。', reply: reply.trim() }
      : { ok: true, message: '连接成功！接口已成功响应。', reply: '(模型返回了空白内容)' };
  } catch (error) {
    signal?.throwIfAborted();
    const raw = error instanceof Error ? error.message : '';
    const reason = controller.signal.aborted
      ? 'timeout'
      : isAuthenticationFailure(error)
        ? 'authentication'
        : isRateLimitFailure(error)
          ? 'quota'
          : raw.includes('404')
            ? 'not_found'
            : raw.includes('ECONNREFUSED') || raw.includes('fetch failed')
              ? 'connection'
              : 'unknown';
    return { ok: false, reason, message: describeFailure(error, controller) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
