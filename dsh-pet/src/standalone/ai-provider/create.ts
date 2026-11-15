/**
 * 独立 AI 服务的装配根：初始化设置存储、维护就绪与暂停状态，把生成通道与连接测试接到门面上。
 *
 * 不解析请求（归 ./request）、不定义限额（归 ./limits）、不写通道细节（归 ./stream 与 ./test-connection）。
 * 必须始终成立：设置读不安全时整体失败，不顺势启用环境里的旧凭据。
 * @module dsh-pet/src/standalone/ai-provider/create
 */
import { type StandaloneLogger } from '../context.ts';
import { createAiConfig, type StandaloneAiSettings, type StandaloneAiPublicSettings } from '../ai-config.ts';
import { BUILTIN_SERVICES, CUSTOM_SERVICE, builtinService, sameEndpoint } from '../services.ts';
import type {
  AiRuntime,
  AiStore,
  ModelDiscoveryInput,
  StandaloneAiDependencies,
  StandaloneAiService,
} from './types.ts';
import { PROVIDER } from './limits.ts';
import { discoverModels } from './list-models.ts';
import { queryStandaloneBalance } from './balance.ts';
import { createTextStream } from './stream.ts';
import { testAiConnection } from './test-connection.ts';

/**
 * 设置页需要的服务商目录：与后端名录同源，前端不再抄一份地址。
 * 自定义排第一且没有地址——它的 profile 永远是用户自己填的那份。
 */
const SERVICE_CATALOG = [
  { id: CUSTOM_SERVICE, label: '自定义', keyName: 'CUSTOM_API_KEY' as const, protocol: 'openai-compatible' as const },
  ...BUILTIN_SERVICES,
];

/**
 * 把服务商目录附在设置视图上。
 * @param settings - 脱敏设置。
 * @returns 设置 + 目录；目录是静态数据，不含任何密钥。
 */
function withCatalog<T extends StandaloneAiPublicSettings>(settings: T): T & { services: typeof SERVICE_CATALOG } {
  return { ...settings, services: SERVICE_CATALOG };
}

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
 * 内置服务的模型清单地址与对话地址不同级（opencode 就是），只有草稿地址命中该家时才用它。
 * @param settings - 当前成品配置。
 * @param input - 本次请求里用户填的地址。
 * @returns 显式清单地址；自定义或地址不符时返回 undefined，交回按 baseUrl 推导。
 */
function discoveryUrl(settings: Readonly<StandaloneAiSettings>, input: ModelDiscoveryInput): string | undefined {
  const def = builtinService(settings.service);
  if (!def?.modelsUrl) return undefined;
  const base = (input.baseUrl !== undefined ? input.baseUrl : settings.baseUrl).trim();
  return sameEndpoint(base, def.baseUrl) ? def.modelsUrl : undefined;
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
    disposed: false,
    paused: false,
    saving: false,
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
    getSettings: () => withCatalog(store.publicSettings()),
    saveSettings: async (input) => withCatalog(await saveSettings(runtime, store, input)),
    isReady: () => runtime.ready(),
    balanceAuth: () => ({ provider: store.current().service, apiKey: store.current().apiKey }),
    deepseekKey: () => store.current().deepseekApiKey,
    testConnection: (input) =>
      runtime.disposed
        ? Promise.resolve({ ok: false, message: '服务已关闭' })
        : testAiConnection(runtime.fetcher, store.current(), input),
    discoverModels: (input) =>
      runtime.disposed
        ? Promise.resolve({ ok: false, code: 'input', message: '服务已关闭' })
        : discoverModels(runtime.fetcher, store.current(), {
            ...input,
            modelsUrl: discoveryUrl(store.current(), input),
          }),
    queryBalance: async () =>
      runtime.disposed
        ? { ok: false, provider: '', reason: 'unsupported' }
        : queryStandaloneBalance(store.current().service, store.current().apiKey),
    dispose() {
      runtime.disposed = true;
      runtime.active?.abort();
    },
  };
}
