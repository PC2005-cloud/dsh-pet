/** First-run workflow shared by the CLI and packaged desktop app. */
import { z } from 'zod';
import { DEFAULT_CHAT_MEMORY } from '../shared/chat-memory-config.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';
import type { StandaloneAiService } from './ai-provider.ts';
import { ManagedMemory, memoryModelsSchema } from './managed-memory.ts';

const inputSchema = z.discriminatedUnion('memory', [
  memoryModelsSchema.extend({ action: z.literal('start'), memory: z.literal(true) }).strict(),
  memoryModelsSchema
    .pick({ baseUrl: true, model: true, apiKey: true })
    .extend({ action: z.literal('start'), memory: z.literal(false) })
    .strict(),
]);
const actionSchema = z.object({ action: z.enum(['retry', 'stop']) }).strict();
type Stage = 'idle' | 'checking' | 'installing' | 'starting' | 'ready' | 'error' | 'stopped';
const messages: Record<string, string> = {
  idle: '填写模型信息，开始养鱼。',
  checking: '正在检查聊天模型…',
  installing: '正在安装本机记忆服务，首次下载可能需要几分钟…',
  starting: '正在启动记忆服务并检查模型连接…',
  ready: '可以开始聊天了。',
  stopped: '本机记忆服务已停止，已保存的记忆保留。',
  chat_unavailable: '聊天连接未通过，请检查接口地址、模型名称和密钥。',
  embedding_change_requires_new_store:
    '已有记忆使用另一套 embedding 配置。请保留原模型、地址和维度；不要覆盖已有记忆库。',
  memory_already_owned: '另一个桌宠进程正在管理此记忆库，请从原来的桌宠窗口继续使用。',
  unsupported_platform: '此系统或处理器暂不支持自动安装，请在高级配置中连接已有 PowerContext 服务。',
  memory_not_ready: '记忆服务尚未就绪。请检查生成与 embedding 模型信息、网络和端口占用，再重试。',
  memory_start_failed: '记忆服务启动失败，请检查运行环境或本机端口占用后重试。',
  memory_port_in_use: '记忆服务的端口已被占用。请先退出占用它的程序，再重试；原记忆库和连接地址会保留。',
  runtime_command_failed: '自动安装失败。请检查网络、磁盘空间，以及系统是否提供 curl 和 tar，然后重试。',
  download_checksum_failed: '下载文件校验未通过，未执行安装。请检查下载网络后重试。',
};

export interface SetupService {
  status(): unknown;
  submit(input: unknown): void;
  resume(): void;
  dispose(): Promise<void>;
}

/** Use the host's existing configuration route so validation, persistence and desktop refresh remain consistent. */
export function setupMemoryBinding(
  origin: () => string,
  token: string,
): {
  matches(url: string): Promise<boolean>;
  save(url: string, enabled: boolean): Promise<void>;
} {
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
    async matches(url) {
      const memory = (await request('GET')).chatMemory as { backend?: string; serverUrl?: string };
      return memory?.backend === 'powercontext' && memory.serverUrl === url;
    },
    async save(url, enabled) {
      const main = await request('GET');
      const memory = main.chatMemory as { backend?: string; serverUrl?: string };
      if (!enabled && (memory?.backend !== 'powercontext' || memory.serverUrl !== url)) return;
      await request('PUT', {
        pets: main.pets,
        chatMemoryRounds: enabled ? 4 : main.chatMemoryRounds,
        chatMemory: enabled
          ? { ...DEFAULT_CHAT_MEMORY, backend: 'powercontext', serverUrl: url, maxHistoryBytes: 6000 }
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
  let stage: Stage = 'idle';
  let message = messages.idle;
  let memory: ManagedMemory | undefined;
  try {
    memory = new ManagedMemory(home);
  } catch {
    stage = 'error';
    message = '本机记忆配置无法安全读取。请检查文件，已有配置不会被覆盖。';
  }
  let disposed = false;
  let job: Promise<void> | undefined;
  let controller = new AbortController();
  const progress = (next: Stage): void => {
    stage = next;
    message = messages[next] ?? messages.memory_not_ready;
  };
  const launch = (work: () => Promise<void>): void => {
    if (disposed || job) throw new Error('setup_busy');
    controller = new AbortController();
    progress('checking');
    job = work()
      .catch(async (error: unknown) => {
        await memory?.stopProcess();
        stage = 'error';
        message =
          messages[error instanceof Error ? error.message : ''] ??
          '准备失败，请检查网络、模型配置和磁盘空间后重试。已有记忆保留。';
      })
      .finally(() => {
        job = undefined;
      });
  };
  const startMemory = async (): Promise<void> => {
    if (!memory) throw new Error('invalid_memory_settings');
    const url = await memory.start(controller.signal, progress);
    controller.signal.throwIfAborted();
    memory.setEnabled(true);
    await binding.save(url, true);
  };
  return {
    status() {
      if (stage === 'ready' && memory?.enabled && !memory.running) {
        stage = 'error';
        message = messages.memory_start_failed;
      }
      return {
        stage,
        message,
        busy: !!job,
        chatReady: ai.isReady(),
        memoryReady: stage === 'ready' && memory?.enabled === true && memory.running,
        configured: !!memory?.settings(),
        models: memory?.settings(),
        serverUrl: memory?.url,
      };
    },
    submit(input) {
      if (disposed || job) throw new Error('setup_busy');
      const action = actionSchema.safeParse(input);
      if (action.success) {
        if (!memory?.settings()) throw new Error('setup_not_configured');
        if (action.data.action === 'stop')
          launch(async () => {
            await binding.save(memory!.url!, false);
            memory!.setEnabled(false);
            await memory!.stopProcess();
            progress('stopped');
          });
        else
          launch(async () => {
            if (!ai.isReady()) throw new Error('chat_unavailable');
            await startMemory();
            progress('ready');
          });
        return;
      }
      const draft = inputSchema.safeParse(input);
      if (!draft.success) throw new Error('invalid_setup');
      if (draft.data.memory && !memory) throw new Error('invalid_memory_settings');
      const models = draft.data;
      const memoryModels = models.memory
        ? memory!.validateModels({
            baseUrl: models.baseUrl,
            model: models.model,
            apiKey: models.apiKey,
            embeddingBaseUrl: models.embeddingBaseUrl,
            embeddingModel: models.embeddingModel,
            embeddingApiKey: models.embeddingApiKey,
            embeddingDimension: models.embeddingDimension,
          })
        : undefined;
      launch(async () => {
        const chat = {
          protocol: 'openai-compatible',
          baseUrl: models.baseUrl,
          model: models.model,
          apiKey: models.apiKey,
        };
        if (!(await ai.testConnection(chat)).ok) throw new Error('chat_unavailable');
        controller.signal.throwIfAborted();
        await ai.saveSettings(chat);
        if (memoryModels) {
          await memory!.configure(memoryModels);
          await startMemory();
        } else if (memory?.enabled) {
          await binding.save(memory.url!, false);
          memory.setEnabled(false);
          await memory.stopProcess();
        }
        progress('ready');
      });
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
      controller.abort();
      await job;
      await memory?.dispose();
    },
  };
}
