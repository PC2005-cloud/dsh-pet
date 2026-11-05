/** First-run workflow shared by the CLI and packaged desktop app. */
import { z } from 'zod';
import { DEFAULT_CHAT_MEMORY } from '../shared/chat-memory-config.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';
import type { StandaloneAiService } from './ai-provider.ts';
import { ManagedMemory, memoryModelsSchema } from './managed-memory.ts';
import type { MemoryStage } from './memory-install.ts';
import { checkEmbedding, sameModelEndpoint, setupErrorMessage } from './setup-models.ts';

const optionalKey = memoryModelsSchema.shape.apiKey.or(z.literal('')).default('');
const inputSchema = z.discriminatedUnion('memory', [
  memoryModelsSchema
    .extend({ action: z.literal('start'), memory: z.literal(true), apiKey: optionalKey, embeddingApiKey: optionalKey })
    .strict(),
  memoryModelsSchema
    .pick({ baseUrl: true, model: true, apiKey: true })
    .extend({ action: z.literal('start'), memory: z.literal(false), apiKey: optionalKey })
    .strict(),
]);
const actionSchema = z.object({ action: z.enum(['retry', 'stop', 'cancel']) }).strict();
type Draft = z.infer<typeof inputSchema>;
type Stage =
  | MemoryStage
  | 'idle'
  | 'checking'
  | 'checking_embedding'
  | 'restoring'
  | 'saving'
  | 'ready'
  | 'error'
  | 'stopped'
  | 'cancelling'
  | 'cancelled';
const messages: Record<Stage, string> = {
  idle: '选择服务商，填写密钥，开始养鱼。',
  checking: '正在检查聊天模型…',
  checking_embedding: '正在检查 Embedding 模型与向量维度…',
  checking_runtime: '正在检查本机运行环境…',
  downloading: '正在下载并校验安装工具；首次下载可能需要几分钟…',
  installing_python: '正在准备本机 Python 环境…',
  installing_memory: '正在安装 PowerContext 1.5.0…',
  starting: '正在启动记忆服务并检查就绪状态…',
  restoring: '正在恢复原来的记忆服务，请稍候…',
  saving: '正在保存连接…',
  ready: '可以开始聊天了。',
  stopped: '记忆已暂停，数据保留。可以继续聊天，也可以随时恢复记忆。',
  error: '准备未完成，请检查设置后重试。',
  cancelling: '正在取消本次准备；已有记忆会保留…',
  cancelled: '已取消准备，已有记忆保留。可以重试，或先使用已配置的聊天。',
};

export interface SetupService {
  status(): unknown;
  submit(input: unknown): void;
  resume(): void;
  dispose(): Promise<void>;
}

/** Use the host configuration boundary for persistence, desktop refresh, and rollback. */
export function setupMemoryBinding(origin: () => string, token: string) {
  async function request(method: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(origin() + ROUTE_SEGMENT + '/config', {
      method,
      headers: { 'X-DSH-Pet-Token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok || data.ok === false || !data.main) throw new Error('pet_settings_failed');
    return data.main as Record<string, unknown>;
  }
  return {
    async matches(url: string) {
      const memory = (await request('GET')).chatMemory as { backend?: string; serverUrl?: string };
      return memory?.backend === 'powercontext' && memory.serverUrl === url;
    },
    async checkpoint() {
      const before = await request('GET');
      return async () => {
        const current = await request('GET');
        await request('PUT', {
          pets: current.pets,
          chatMemoryRounds: before.chatMemoryRounds,
          chatMemory: before.chatMemory,
        });
      };
    },
    async save(url: string, enabled: boolean) {
      const main = await request('GET');
      const memory = main.chatMemory as { backend?: string; serverUrl?: string };
      const matched = memory?.serverUrl === url;
      if (!enabled && (memory?.backend !== 'powercontext' || !matched)) return;
      await request('PUT', {
        pets: main.pets,
        chatMemoryRounds: enabled && !matched ? 4 : main.chatMemoryRounds,
        chatMemory: enabled
          ? matched
            ? { ...memory, backend: 'powercontext' }
            : { ...DEFAULT_CHAT_MEMORY, backend: 'powercontext', serverUrl: url, maxHistoryBytes: 6000 }
          : { ...memory, backend: 'native' },
      });
    },
  };
}

export function createSetup(
  home: string,
  ai: StandaloneAiService,
  binding: ReturnType<typeof setupMemoryBinding>,
): SetupService {
  let stage: Stage = ai.isReady() ? 'ready' : 'idle';
  let message = messages[stage];
  let memory: ManagedMemory | undefined;
  try {
    memory = new ManagedMemory(home);
    if (memory.settings() && !memory.enabled) {
      stage = 'stopped';
      message = messages.stopped;
    }
  } catch {
    stage = 'error';
    message = setupErrorMessage(new Error('invalid_memory_settings'));
  }
  let disposed = false;
  let job: Promise<void> | undefined;
  let controller = new AbortController();
  const lifetime = new AbortController();
  let canCancel = false;
  let lastDraft: Draft | undefined;
  let startedAt: number | undefined;
  const progress = (next: Stage): void => {
    stage = next;
    message = messages[next];
  };
  const launch = (work: () => Promise<void>, cancellable = true): void => {
    if (disposed || job) throw new Error('setup_busy');
    controller = new AbortController();
    startedAt = Date.now();
    canCancel = cancellable;
    progress('checking');
    job = work()
      .catch((error: unknown) => {
        // Model checks and runtime preparation must not stop an existing service.
        if (controller.signal.aborted && !(error instanceof Error && error.message === 'recovery_failed'))
          progress('cancelled');
        else {
          stage = 'error';
          message = setupErrorMessage(error);
        }
      })
      .finally(() => {
        job = undefined;
        canCancel = false;
      });
  };
  const resolveDraft = (input: Draft): Draft => {
    const saved = ai.connectionForSetup();
    const apiKey =
      input.apiKey ||
      (saved.protocol === 'openai-compatible' && sameModelEndpoint(saved.baseUrl, input.baseUrl) ? saved.apiKey : '');
    if (!apiKey) throw new Error('chat_key_required');
    if (!input.memory) return { ...input, apiKey };
    if (!memory) throw new Error('invalid_memory_settings');
    const embeddingApiKey =
      input.embeddingApiKey ||
      memory.embeddingKeyForEndpoint(input.embeddingBaseUrl) ||
      (sameModelEndpoint(input.embeddingBaseUrl, input.baseUrl) ? apiKey : '');
    if (!embeddingApiKey) throw new Error('embedding_key_required');
    const models = memory.validateModels({
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey,
      embeddingBaseUrl: input.embeddingBaseUrl,
      embeddingModel: input.embeddingModel,
      embeddingApiKey,
      embeddingDimension: input.embeddingDimension,
    });
    return { ...models, memory: true, action: 'start' };
  };
  const apply = async (draft: Draft): Promise<void> => {
    const models = draft.memory ? memoryModelsSchema.strip().parse(draft) : undefined;
    const chat = { protocol: 'openai-compatible', baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey };
    const checked = await ai.testConnection(chat, controller.signal);
    if (!checked.ok) throw new Error('chat_' + (checked.reason ?? 'unknown'));
    controller.signal.throwIfAborted();
    // A first-time user can chat while installing memory; existing working settings stay intact until commit.
    const previous = ai.connectionForSetup();
    if (!previous.baseUrl || !previous.model || !previous.apiKey) await ai.saveSettings(chat);
    if (draft.memory) {
      progress('checking_embedding');
      await checkEmbedding(models!, controller.signal);
    }
    controller.signal.throwIfAborted();
    const restoreBinding = await binding.checkpoint();
    const oldChat = ai.connectionForSetup();
    const commit = async (url?: string): Promise<void> => {
      controller.signal.throwIfAborted();
      canCancel = false;
      progress('saving');
      let chatAttempted = false;
      try {
        if (url) await binding.save(url, true);
        else if (memory?.enabled) await binding.save(memory.url!, false);
        chatAttempted = true;
        await ai.saveSettings(chat);
      } catch (error) {
        try {
          await restoreBinding();
          if (chatAttempted) await ai.saveSettings({ ...oldChat, ...(!oldChat.apiKey ? { clearApiKey: true } : {}) });
        } catch {
          throw new Error('recovery_failed');
        }
        throw error;
      }
    };
    if (models) await memory!.replace(models, controller.signal, progress, commit, lifetime.signal);
    else {
      await commit();
      if (memory?.enabled) {
        memory.setEnabled(false);
        await memory.stopProcess();
      }
    }
    lastDraft = undefined;
    progress('ready');
  };
  return {
    status() {
      if (stage === 'ready' && memory?.enabled && !memory.running && !job) {
        stage = 'error';
        message = setupErrorMessage(new Error('memory_start_failed'));
      }
      const chat = ai.getSettings();
      return {
        stage,
        message,
        busy: !!job,
        canCancel: !!job && canCancel,
        startedAt,
        chatReady: ai.isReady(),
        memoryReady: memory?.enabled === true && memory.running,
        memoryEnabled: memory?.enabled === true,
        memoryRunning: memory?.running === true,
        configured: !!memory?.settings(),
        canRetry: !!lastDraft || !!memory?.settings(),
        retryDraft: !!lastDraft,
        chat: { protocol: chat.protocol, baseUrl: chat.baseUrl, model: chat.model, hasKey: chat.hasKey },
        models: memory?.settings(),
        serverUrl: memory?.url,
      };
    },
    submit(input) {
      const action = actionSchema.safeParse(input);
      if (action.success && action.data.action === 'cancel') {
        if (!job || !canCancel) throw new Error('setup_busy');
        controller.abort();
        canCancel = false;
        progress('cancelling');
        return;
      }
      if (disposed || job) throw new Error('setup_busy');
      if (action.success) {
        if (action.data.action === 'retry' && lastDraft) {
          const draft = lastDraft;
          launch(() => apply(draft));
          return;
        }
        if (!memory?.settings()) throw new Error('setup_not_configured');
        if (action.data.action === 'stop')
          launch(async () => {
            await binding.save(memory!.url!, false);
            memory!.setEnabled(false);
            await memory!.stopProcess();
            lastDraft = undefined;
            progress('stopped');
          }, false);
        else
          launch(async () => {
            const wasRunning = memory!.running;
            const wasEnabled = memory!.enabled;
            const restoreBinding = await binding.checkpoint();
            let bindingAttempted = false;
            try {
              await memory!.start(controller.signal, progress);
              controller.signal.throwIfAborted();
              canCancel = false;
              bindingAttempted = true;
              await binding.save(memory!.url!, true);
              memory!.setEnabled(true);
              progress('ready');
            } catch (error) {
              if (!wasRunning) await memory!.stopProcess();
              if (bindingAttempted) {
                try {
                  await restoreBinding();
                  memory!.setEnabled(wasEnabled);
                } catch {
                  throw new Error('recovery_failed');
                }
              }
              throw error;
            }
          });
        return;
      }
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new Error('invalid_setup');
      const draft = resolveDraft(parsed.data);
      lastDraft = draft;
      launch(() => apply(draft));
    },
    resume() {
      if (!memory?.enabled || disposed || job) return;
      launch(async () => {
        if (await binding.matches(memory!.url!)) {
          await memory!.start(controller.signal, progress);
          progress('ready');
        } else progress('idle');
      });
    },
    async dispose() {
      disposed = true;
      lifetime.abort();
      controller.abort();
      await job;
      await memory?.dispose();
    },
  };
}
