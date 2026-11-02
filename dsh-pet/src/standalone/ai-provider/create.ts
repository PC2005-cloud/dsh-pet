/**
 * 独立 AI 服务的装配根：初始化设置存储、维护就绪与暂停状态，把生成通道与连接测试接到门面上。
 *
 * 不解析请求（归 ./request）、不定义限额（归 ./limits）、不写通道细节（归 ./stream 与 ./test-connection）。
 * 必须始终成立：设置读不安全时整体失败，不顺势启用环境里的旧凭据。
 * @module dsh-pet/src/standalone/ai-provider/create
 */
import { type StandaloneLogger } from '../context.ts';
import { createAiConfig, type StandaloneAiPublicSettings } from '../ai-config.ts';
import type { AiRuntime, AiStore, StandaloneAiDependencies, StandaloneAiService } from './types.ts';
import { PROVIDER } from './limits.ts';
import { discoverModels } from './list-models.ts';
import { createTextStream } from './stream.ts';
import { testAiConnection } from './test-connection.ts';

/**
 * 保存设置：单飞、先中止在途请求，失败即暂停，等下一次保存成功才恢复。
 * @throws 服务已释放、另一次保存正在进行，或存储层校验/落盘失败时。
 */
async function saveSettings(runtime: AiRuntime, store: AiStore, input: unknown): Promise<StandaloneAiPublicSettings> {
  if (runtime.disposed) throw new Error('Standalone AI is disposed.');
  if (runtime.saving) throw new Error('Standalone AI settings are being saved.');
  runtime.saving = true;
  // 保存期间先中止在途请求，避免旧设置继续产生输出。
  runtime.active?.abort();
  try {
    const result = await store.save(input);
    if (!runtime.disposed) runtime.paused = false;
    return result;
  } catch (error) {
    runtime.paused = true;
    throw error;
  } finally {
    runtime.saving = false;
  }
}

/**
 * 创建独立模式 AI 服务。
 * @param home - DSH_HOME。
 * @param logger - 日志出口。
 * @param dependencies - 测试注入的传输与时钟。
 * @returns AI 服务。
 * @throws 设置无法安全读取时抛出。
 */
export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: AiStore;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // 持久化损坏或权限不安全时不能顺势启用环境里的旧凭据，宁可整体失败。
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const runtime: AiRuntime = {
    store,
    logger,
    fetcher: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    now: dependencies.now ?? Date.now,
    disposed: false,
    paused: false,
    saving: false,
    requests: [],
    active: undefined,
    ready(): boolean {
      return (
        !runtime.disposed &&
        !runtime.paused &&
        !runtime.saving &&
        !!store.current().model &&
        !!store.current().baseUrl &&
        !!store.current().apiKey
      );
    },
  };
  const modelOf = (): string => store.current().model;

  return {
    currentSelection: () => ({ provider: PROVIDER, model: runtime.ready() ? modelOf() : '' }),
    listProviders: () => (runtime.ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      runtime.ready() && provider === PROVIDER ? [{ id: modelOf(), name: modelOf() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = modelOf(), signal) =>
      runtime.ready() && !signal?.aborted && provider === PROVIDER && model === modelOf()
        ? { id: model, name: model }
        : undefined,
    stream: createTextStream(runtime),
    getSettings: () => store.publicSettings(),
    saveSettings: (input) => saveSettings(runtime, store, input),
    isReady: () => runtime.ready(),
    testConnection: (input) =>
      runtime.disposed
        ? Promise.resolve({ ok: false, message: '服务已关闭' })
        : testAiConnection(runtime.fetcher, store.current(), input),
    discoverModels: (input) =>
      runtime.disposed
        ? Promise.resolve({ ok: false, code: 'input', message: '服务已关闭' })
        : discoverModels(runtime.fetcher, store.current(), input),
    dispose() {
      runtime.disposed = true;
      runtime.active?.abort();
    },
  };
}
