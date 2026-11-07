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
import type { StandaloneAiSettings } from './ai-config.ts';
import type { TransientChatImage } from '../host/transient-image.ts';

/** fetch 的形状，便于测试替换。 */
export type AiFetch = typeof globalThis.fetch;
/** 一条纯文本消息。 */
export interface AiTextMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Only the current user message may carry one bounded memory-only image. */
  images?: readonly TransientChatImage[];
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
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
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
      ...request.messages.map((message): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
        if (!message.images?.length) return { role: message.role, content: message.content };
        return {
          role: 'user',
          content: [
            { type: 'text', text: message.content },
            ...message.images.map((image) => ({ type: 'image_url' as const, image_url: { url: image.dataUrl } })),
          ],
        };
      }),
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
    messages: request.messages.map((message): Anthropic.MessageParam => ({
      role: message.role,
      content: !message.images?.length
        ? message.content
        : [
            { type: 'text', text: message.content },
            ...message.images.map((image): Anthropic.ImageBlockParam => {
              const separator = image.dataUrl.indexOf(',');
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.dataUrl.startsWith('data:image/png;') ? 'image/png' : 'image/jpeg',
                  data: image.dataUrl.slice(separator + 1),
                },
              };
            }),
          ],
    })),
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
