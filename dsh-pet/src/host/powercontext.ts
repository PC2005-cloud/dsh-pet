/** PowerContext v1.5 HTTP boundary and durable, per-pet delivery state. */
import { createHash, randomUUID } from 'node:crypto';
import type { ChatMemoryConfig } from '../shared/chat-memory-config.ts';

export interface MemoryTurn {
  id: string;
  at: number;
  content: string;
}

export interface MemorySyncState {
  version: 1;
  scopeKey: string;
  scopeId?: string;
  pending: MemoryTurn[];
  captured: number;
  skipped: number;
  lastError?: string;
  lastRecall?: 'ready' | 'empty' | 'unavailable';
  deliveryBlocked?: boolean;
}

export interface MemoryEntryState {
  powercontext?: Record<string, MemorySyncState>;
}

/** A different configured endpoint gets its own scope and queue; old pending writes stay with their target. */
export function memoryTarget(config: ChatMemoryConfig): string {
  return createHash('sha256').update(config.serverUrl.replace(/\/+$/, '')).digest('hex');
}

export function memoryState(entry: MemoryEntryState, config: ChatMemoryConfig): MemorySyncState {
  const states = (entry.powercontext ??= {});
  if (!states || typeof states !== 'object' || Array.isArray(states)) throw new MemoryServiceError('invalid_state');
  const state = (states[memoryTarget(config)] ??= {
    version: 1,
    scopeKey: 'dsh-pet:' + randomUUID(),
    pending: [],
    captured: 0,
    skipped: 0,
  });
  if (
    state.version !== 1 ||
    typeof state.scopeKey !== 'string' ||
    !state.scopeKey ||
    !Array.isArray(state.pending) ||
    !Number.isInteger(state.captured) ||
    !Number.isInteger(state.skipped)
  )
    throw new MemoryServiceError('invalid_state');
  return state;
}

/** Store the exact payload before attempting any network write, so retries cannot change its identity. */
export function queueMemoryTurn(state: MemorySyncState, user: string, assistant: string, at: number): void {
  const content = JSON.stringify({
    kind: 'dsh-pet-dialogue',
    occurred_at: new Date(at).toISOString(),
    messages: [
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ],
    interpretation: 'Assistant messages describe what the companion said, not proof of completed actions.',
  });
  if (Buffer.byteLength(content, 'utf8') > 65536) {
    state.skipped += 1;
    state.lastError = 'source_too_large';
    return;
  }
  state.pending.push({ id: 'dsh-pet-turn:' + randomUUID(), at, content });
}

export class MemoryServiceError extends Error {
  declare readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Error diagnostics never contain provider response bodies, prompts, URLs, or credentials. */
export function memoryErrorCode(error: unknown): string {
  return error instanceof MemoryServiceError ? error.code : 'unavailable';
}

export class PowerContextClient {
  declare private readonly config: ChatMemoryConfig;
  declare private readonly fetcher: typeof fetch;
  constructor(config: ChatMemoryConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  private async request(path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = process.env.DSH_PET_POWERCONTEXT_TOKEN;
    if (token) headers.authorization = 'Bearer ' + token;
    const response = await this.fetcher(this.config.serverUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MemoryServiceError('http_' + response.status);
    }
    if (!response.body) throw new MemoryServiceError('invalid_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 131072) throw new MemoryServiceError('response_too_large');
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new MemoryServiceError('invalid_response');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new MemoryServiceError('invalid_response');
    return parsed as Record<string, unknown>;
  }

  async ensureScope(state: MemorySyncState, signal: AbortSignal): Promise<string> {
    if (state.scopeId) return state.scopeId;
    const response = await this.request(
      '/v1/scopes',
      {
        title: 'DSH pet companion',
        summary: 'Private dialogue evidence for one companion instance.',
        idempotency_key: state.scopeKey,
      },
      signal,
    );
    if (typeof response.scope_id !== 'string' || !response.scope_id || response.scope_id.length > 256)
      throw new MemoryServiceError('invalid_response');
    return (state.scopeId = response.scope_id);
  }

  async prepare(state: MemorySyncState, query: string): Promise<string | undefined> {
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    const scope = await this.ensureScope(state, signal);
    const response = await this.request(
      '/v1/context/prepare',
      {
        scope_id: scope,
        query: [...query].slice(0, 8192).join(''),
        max_bytes: this.config.maxRecallBytes,
        assembly: { format: 'markdown', sections: [{ family: 'memory', limit: this.config.recallLimit }] },
      },
      signal,
    );
    if (response.schema !== 'powercontext.prepared-context.v1') throw new MemoryServiceError('invalid_response');
    if (response.status === 'empty' && response.content === null && response.content_bytes === 0) {
      state.lastRecall = 'empty';
      return undefined;
    }
    if (
      response.status !== 'ready' ||
      typeof response.content !== 'string' ||
      !response.content ||
      Buffer.byteLength(response.content, 'utf8') !== response.content_bytes ||
      response.content_bytes > this.config.maxRecallBytes
    )
      throw new MemoryServiceError('invalid_response');
    state.lastRecall = 'ready';
    return response.content;
  }

  async capture(state: MemorySyncState, turn: MemoryTurn): Promise<void> {
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    const scope = await this.ensureScope(state, signal);
    const response = await this.request(
      '/v1/sources/content',
      {
        scope_id: scope,
        source_id: turn.id,
        content: turn.content,
        metadata: { origin: 'dsh-pet', event: 'dialogue', occurred_at: new Date(turn.at).toISOString() },
      },
      signal,
    );
    const source = response.source as Record<string, unknown> | undefined;
    if (
      !source ||
      source.source_id !== turn.id ||
      !Number.isInteger(response.position) ||
      Number(response.position) < 1 ||
      response.status !== 'accepted' ||
      source.name !== 'content'
    )
      throw new MemoryServiceError('invalid_response');
  }
}
