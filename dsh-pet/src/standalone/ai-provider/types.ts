/**
 * 独立 AI 服务的对外形状：服务能力与创建时的依赖。
 *
 * 纯类型，不含实现。
 * 必须始终成立：字段全部 readonly，调用方不得改写服务内部状态。
 * @module dsh-pet/src/standalone/ai-provider/types
 */
import { type createAiConfig, type StandaloneAiPublicSettings } from '../ai-config.ts';
import { type AiFetch } from '../ai-transport.ts';
import { type StandaloneLogger } from '../context.ts';
import { type BalanceResult } from '../../host/balance/index.ts';

/** 设置存储：`createAiConfig` 的返回形状。 */
export type AiStore = ReturnType<typeof createAiConfig>;

/** 「测试连接」的输入：任一项缺省则沿用当前设置。 */
export interface TestConnectionInput {
  protocol?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** 「测试连接」的结果：失败时 message 是给人看的原因。 */
export interface TestConnectionResult {
  ok: boolean;
  message: string;
  reply?: string;
}

/** 「拉取模型」的输入：任一项缺省则沿用当前设置；空字符串视为未填。 */
export interface ModelDiscoveryInput {
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** 端点声明的一个可选模型。 */
export interface DiscoveredModel {
  id: string;
  name: string;
}

/** 「拉取模型」的结果：失败时 code 稳定，message 可直接展示。 */
export type ModelDiscoveryResult =
  { ok: true; models: DiscoveredModel[] } | { ok: false; code: string; message: string };

/**
 * 生成通道与连接测试共享的运行态：可变字段集中在装配根，子模块只读写自己那份。
 *
 * `ready()` 是全服务唯一的可用判定（未释放、未暂停、未在保存、设置完整），两个子模块每次请求都要重新问。
 */
export interface AiRuntime {
  readonly store: AiStore;
  readonly logger: StandaloneLogger;
  readonly fetcher: AiFetch;
  ready(): boolean;
  /** 已释放：此后一切请求与保存都拒绝。 */
  disposed: boolean;
  /** 鉴权失败或保存失败后置位，保存成功才解除。 */
  paused: boolean;
  /** 保存进行中：期间不得发起请求。 */
  saving: boolean;
  /** 在途请求的控制器；非空即表示忙碌。 */
  active: AbortController | undefined;
}

/** 独立模式 AI 服务的对外形状。 */
export interface StandaloneAiService {
  /** 当前选中的服务商与模型；未就绪时模型为空。 */
  currentSelection(): { provider: string; model: string };
  /** 就绪时返回唯一的 standalone 服务商。 */
  listProviders(): Array<{ id: string; name: string }>;
  /** 就绪时返回当前模型，否则为空。 */
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  /** 校验请求的模型是否就是当前配置的那个。 */
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<undefined | { id: string; name: string }>;
  /** 以异步序列返回文本增量。 */
  stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  /** 取脱敏后的当前设置。 */
  getSettings(): StandaloneAiPublicSettings;
  /** 校验并保存设置，成功后解除认证失败造成的暂停。 */
  saveSettings(input: unknown): Promise<StandaloneAiPublicSettings>;
  /** 用一次最小请求验证地址、模型与密钥。 */
  testConnection(input: TestConnectionInput): Promise<TestConnectionResult>;
  /** 按协议拉取端点声明可用的模型；失败时 code 稳定、message 可直接展示。 */
  discoverModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult>;
  /** 按设置里选中的服务商查询余额；未选择或缺少密钥时返回显式失败，绝不伪造数字。 */
  queryBalance(): Promise<BalanceResult>;
  /** 余额查询要用的服务商与密钥；供宿主半侧的余额轮询取用，不进对外设置视图。 */
  balanceAuth(): { provider: string; apiKey: string };
  /** 是否满足发起请求的全部条件。 */
  isReady(): boolean;
  /** 终止在途请求并释放服务。 */
  dispose(): void;
}

/** 可注入的传输，仅供测试替换；生产使用官方 SDK。 */
export interface StandaloneAiDependencies {
  /** 替换 fetch 以隔离网络。 */
  fetch?: AiFetch;
}
