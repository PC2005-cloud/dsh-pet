import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { StandaloneAiSettings } from './ai-config';

export type AiFetch = typeof globalThis.fetch;
export interface AiTextMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface AiRequest {
  system: string;
  messages: AiTextMessage[];
}
export type AiTransportEvent = { text?: string; refusal?: boolean };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** SDKs can inherit custom auth headers from env even with explicit keys; rebuild headers. */
export function isolatedFetch(settings: Readonly<StandaloneAiSettings>, fetcher: AiFetch): AiFetch {
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
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
    if (settings.protocol === 'anthropic') {
      headers.set('x-api-key', settings.apiKey);
      headers.set('anthropic-version', '2023-06-01');
      if (new URL(base).origin === 'https://api.anthropic.com' && settings.model === 'claude-opus-5-5') {
        headers.set('anthropic-beta', 'server-side-fallback-2026-07-01');
      }
    } else headers.set('authorization', `Bearer ${settings.apiKey}`);
    return fetcher(url, { method: 'POST', body: init?.body, headers, signal: init?.signal, redirect: 'error' });
  };
}

export async function* sdkTextStream(
  settings: Readonly<StandaloneAiSettings>,
  request: AiRequest,
  signal: AbortSignal,
  fetcher: AiFetch,
): AsyncIterable<AiTransportEvent> {
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
  // Explicit authToken:null prevents SDK environment/OAuth/profile credential resolution.
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
    // Only delta text: never re-emit accumulated content or thinking/progress blocks.
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { text: event.delta.text };
  }
}

export function isAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  );
}
export function isRateLimitFailure(error: unknown): boolean {
  return error instanceof OpenAI.RateLimitError || error instanceof Anthropic.RateLimitError;
}
