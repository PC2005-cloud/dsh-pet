/**
 * 独立模式的模型传输层：封装 OpenAI 兼容与 Anthropic 两种协议的流式调用。
 *
 * 不负责设置校验与限流（见 ai-provider），也不负责选择模型。
 * 必须始终成立：请求只能发往配置推导出的那个端点；鉴权头由本层重建，
 * 绝不沿用 SDK 从环境或配置目录推断出的凭据。
 * @module dsh-pet/src/standalone/ai-transport
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { StandaloneAiSettings } from './ai-config.ts';
import { BUILTIN_SERVICES, sameEndpoint } from './services.ts';

/** fetch 的形状，便于测试替换。 */
export type AiFetch = typeof globalThis.fetch;
/** 一条纯文本消息。 */
export interface AiTextMessage {
  role: 'user' | 'assistant';
  content: string;
}
/** 一次请求的系统提示与消息序列。 */
export interface AiRequest {
  system: string;
  messages: AiTextMessage[];
}
/** 传输事件：只有文本增量与拒绝标记。 */
export type AiTransportEvent = { text?: string; refusal?: boolean };
/** SDK 的静默 logger，避免把请求细节写进日志。 */
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** 会话 ID：进程内只生成一次，保证同一家服务商的每个请求都带同一个值。 */
let sessionId: string | undefined;

/**
 * 目标地址要求的额外请求头。
 *
 * 只有名录里声明了 `sessionHeader` 的服务商才会带；opencode Go 缺这个头会 400（无法路由）。
 * @param baseUrl - 本次请求的地址。
 * @returns 需要附加的头；不需要时为空对象。
 */
export function serviceHeaders(baseUrl: string): Record<string, string> {
  // 先按整条地址匹配；用户手改过路径（比如换成 zen 地址）时，同源也算命中——
  // 这个头是 opencode 侧的入口要求，跟具体路径无关。
  const def = BUILTIN_SERVICES.find((entry) => {
    if (!entry.sessionHeader) return false;
    if (sameEndpoint(baseUrl, entry.baseUrl)) return true;
    try {
      return new URL(baseUrl).origin === new URL(entry.baseUrl).origin;
    } catch {
      return false;
    }
  });
  if (!def?.sessionHeader) return {};
  sessionId ??= randomUUID();
  return { [def.sessionHeader]: sessionId };
}

/**
 * 重建请求目标与鉴权头的 fetch 包装。
 * @param settings - 成品配置。
 * @param fetcher - 底层 fetch。
 * @returns 只允许配置端点通过的 fetch。
 */
export function isolatedFetch(settings: Readonly<StandaloneAiSettings>, fetcher: AiFetch): AiFetch {
  // 端点由配置推导，SDK 拼出的地址必须逐一命中，否则拒绝发出。
  const base = settings.baseUrl.replace(/\/+$/, '');
  const expected = base + (settings.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions');
  return async (url, init) => {
    const beta =
      settings.protocol === 'anthropic' &&
      new URL(base).origin === 'https://api.anthropic.com' &&
      settings.model === 'claude-opus-5-5';
    const urlStr = String(url);
    const validOpenAi =
      settings.protocol === 'openai-compatible' &&
      (urlStr === expected || urlStr === base + '/chat/completions' || urlStr === base + '/v1/chat/completions');
    const validAnthropic =
      settings.protocol === 'anthropic' &&
      (urlStr === expected + (beta ? '?beta=true' : '') ||
        urlStr === base + '/messages' ||
        urlStr === base + '/v1/messages' + (beta ? '?beta=true' : ''));
    if (!validOpenAi && !validAnthropic) throw new Error('Unexpected standalone AI endpoint.');
    // 所有头都由本层重建：SDK 可能从环境继承自定义鉴权头，即使已经给出显式密钥。
    // 服务商要求的会话头也在这里补上，缺它会被直接判 400。
    const headers = new Headers({
      'content-type': 'application/json',
      accept: 'application/json',
      ...serviceHeaders(base),
    });
    if (settings.protocol === 'anthropic') {
      headers.set('x-api-key', settings.apiKey);
      headers.set('anthropic-version', '2023-06-01');
      if (new URL(base).origin === 'https://api.anthropic.com' && settings.model === 'claude-opus-5-5') {
        // 只有第一方 Opus 才启用服务端回退 beta，第三方端点不应收到这个头。
        headers.set('anthropic-beta', 'server-side-fallback-2026-07-01');
      }
    } else headers.set('authorization', `Bearer ${settings.apiKey}`);
    return fetcher(url, { method: 'POST', body: init?.body, headers, signal: init?.signal, redirect: 'error' });
  };
}

/**
 * 按协议调用官方 SDK，产出文本增量与拒绝事件。
 * @param settings - 成品配置。
 * @param request - 规范化后的请求。
 * @param signal - 取消信号。
 * @param fetcher - 底层 fetch。
 * @returns 文本增量的异步序列。
 * @throws 端点不符或 SDK 调用失败时抛出。
 */
export async function* sdkTextStream(
  settings: Readonly<StandaloneAiSettings>,
  request: AiRequest,
  signal: AbortSignal,
  fetcher: AiFetch,
): AsyncIterable<AiTransportEvent> {
  // SDK 自带的重试与日志会绕过本层的边界控制，全部关掉。
  const shared = {
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl.replace(/\/+$/, ''),
    maxRetries: 0,
    timeout: settings.timeoutMs,
    fetch: isolatedFetch(settings, fetcher),
    logger: quiet,
    logLevel: 'off' as const,
  };
  if (settings.protocol === 'openai-compatible') {
    const client = new OpenAI({ ...shared, organization: null, project: null, webhookSecret: null });
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages,
    ];
    const stream = await client.chat.completions.create(
      { model: settings.model, messages, stream: true, max_tokens: settings.maxTokens, n: 1 },
      { signal },
    );
    for await (const event of stream) {
      const delta = event.choices.find((choice) => choice.index === 0)?.delta;
      if (delta?.refusal) yield { refusal: true };
      if (delta?.content) yield { text: delta.content };
    }
    return;
  }
  // 显式置空 authToken，阻断 SDK 从环境、OAuth 或配置目录解析凭据。
  const client = new Anthropic({ ...shared, authToken: null, webhookKey: null });
  const opus = settings.model === 'claude-opus-5-5';
  const firstParty = new URL(settings.baseUrl).origin === 'https://api.anthropic.com';
  const parameters = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: request.system,
    messages: request.messages,
    stream: true as const,
    ...(opus ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
  };
  const stream =
    opus && firstParty
      ? await client.beta.messages.create(
          { ...parameters, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal },
        )
      : await client.messages.create(parameters, { signal });
  for await (const event of stream) {
    if (event.type === 'message_delta' && event.delta.stop_reason === 'refusal') yield { refusal: true };
    // 只转发增量文本：累计内容与思考块重复转发会让调用方拿到重复文本。
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { text: event.delta.text };
  }
}

/** 判断是否为鉴权失败。 */
export function isAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  );
}
/** 判断是否为限流失败。 */
export function isRateLimitFailure(error: unknown): boolean {
  return error instanceof OpenAI.RateLimitError || error instanceof Anthropic.RateLimitError;
}
