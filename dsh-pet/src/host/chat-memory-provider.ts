/**
 * 第三方长期记忆实现的注册表：多槽，每个 provider id 一份，互不覆盖。
 *
 * 插入顺序即注册顺序，目录按它输出；注销只删自己那条，迟到的注销不影响后来者。
 * 只登记与查找：不召回、不算超时、不落盘（那些归 ./plugin/chat-memory）。
 * 内置实现 `native` 常驻注册表，任何时刻都解析得到。
 * @module dsh-pet/src/host/chat-memory-provider
 */
import type { MemeEntry } from './memes.ts';
import type { WeatherFacts } from './time-context.ts';

/** 内置实现的 id；第三方不能占用它。 */
export const NATIVE_MEMORY_ID = 'native';

/** provider 没声明 `timeoutMs` 时，单次召回的缺省超时（ms）。 */
export const DEFAULT_MEMORY_TIMEOUT_MS = 15_000;

/** 传给召回钩子的历史消息：只给对话所需的三个字段，不带图片引用与动作名。 */
export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly ts: number;
}

/** 一次模型调用的完整输入；召回钩子的返回值也是这个形状。 */
export interface ChatRequest {
  readonly system: string;
  readonly history: readonly ChatTurn[];
  readonly userText: string;
}

/** 原始事实：provider 想自己拼上下文时用它，不必解析成品提示词。 */
export interface RawFacts {
  /** 人设正文（实例级优先，回落所属条目）。 */
  readonly persona: string;
  /** 当前时刻（毫秒）。 */
  readonly now: number;
  /** 城市与天气；两条取数链路都失败时缺省。 */
  readonly env?: {
    readonly region?: string;
    readonly city?: string;
    readonly weather?: WeatherFacts;
  };
  /** 节日从句，如「快要过冬至了」；无节日时缺省。 */
  readonly festival?: string;
  /** 配图候选池，已按配置的 `chatImageLimit` 截断。 */
  readonly memes: readonly MemeEntry[];
  /** 可表演的动作名。 */
  readonly actions: readonly string[];
  /** 宠物身份。 */
  readonly pet: {
    readonly id: string;
    readonly name: string;
    /** 所属种类（配置条目），如 `main`。 */
    readonly entry: string;
    /** 显示位置档，如 `both`。 */
    readonly display: string;
  };
}

/** 一次召回请求。 */
export interface RecallRequest {
  readonly petId: string;
  readonly userText: string;
  /** 核心已经拼好的一份，provider 可直接用或整份替换。 */
  readonly prepared: ChatRequest;
  readonly raw: RawFacts;
}

/** 落盘后交给 provider 的这一轮问答。 */
export interface CaptureTurn {
  readonly petId: string;
  readonly userText: string;
  readonly replyText: string;
  /** 动作名，不含素材。 */
  readonly action?: string;
  /** 配图名，不含素材。 */
  readonly image?: string;
  readonly ts: number;
}

/** 第三方长期记忆实现；注册后由注册表按 id 收录。 */
export interface ChatMemoryProvider {
  /** 小写 kebab-case，全局唯一；`native` 保留给内置实现。 */
  readonly id: string;
  /** 展示名，设置页下拉里的文字。 */
  readonly name: string;
  /** 单次召回超时（ms）；缺省 {@link DEFAULT_MEMORY_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  /**
   * 生成前召回：返回整个请求体，`undefined` 表示本轮不介入。
   *
   * 返回值不可信，核心会校验形状；形状不对按失败处理。
   *
   * @param req - 本轮输入与原始事实。
   * @param signal - 核心在超时到点后 abort；可忽略，忽略只会白占上游连接。
   */
  recall?(req: RecallRequest, signal: AbortSignal): Promise<ChatRequest | undefined> | ChatRequest | undefined;
  /** 落盘后接收这一轮；核心不等待，抛错只记日志。 */
  capture?(turn: CaptureTurn): void | Promise<void>;
}

/** 可选实现目录；Cordis `list()` 与 `GET /memory/providers` 返回同一份。 */
export interface MemoryCatalog {
  readonly providers: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** provider id 的形状：小写 kebab-case，避免配置里出现空白、斜杠这类需要转义的形态。 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 内置实现：不读文件、不写文件；召回直接把核心拼好的那份交回去。 */
const nativeProvider: ChatMemoryProvider = {
  id: NATIVE_MEMORY_ID,
  name: '内置记忆',
  recall: (req) => req.prepared,
};

/** 已注册的实现：provider id → 定义；Map 的插入顺序就是对外顺序。 */
const providers = new Map<string, ChatMemoryProvider>([[NATIVE_MEMORY_ID, nativeProvider]]);

/**
 * 校验一个注册定义；不合法即抛出，调用方在写入注册表之前调用。
 *
 * @param def - 注册方传入的原始值。
 * @throws {TypeError} 任一字段缺失、类型不符、id 形态非法或占用内置标识时。
 */
function validateMemoryProvider(def: unknown): asserts def is ChatMemoryProvider {
  if (!def || typeof def !== 'object') throw new TypeError('记忆 provider 定义必须是对象');
  const provider = def as Record<string, unknown>;
  if (typeof provider.id !== 'string' || !PROVIDER_ID_PATTERN.test(provider.id)) {
    throw new TypeError(`provider id 必须是小写 kebab-case，收到 ${JSON.stringify(provider.id)}`);
  }
  if (provider.id === NATIVE_MEMORY_ID) throw new TypeError(`不能占用内置实现标识: ${NATIVE_MEMORY_ID}`);
  if (typeof provider.name !== 'string' || provider.name.trim() === '') {
    throw new TypeError(`provider ${provider.id} 的 name 必须是非空字符串`);
  }
  if (typeof provider.recall !== 'function' && typeof provider.capture !== 'function') {
    throw new TypeError(`provider ${provider.id} 的 recall 与 capture 至少要有一个是函数`);
  }
  const timeoutMs = provider.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`provider ${provider.id} 的 timeoutMs 必须是正有限数，收到 ${JSON.stringify(timeoutMs)}`);
  }
}

/**
 * 注册一个长期记忆实现。
 *
 * @param def - 实现定义；`id` 已被占用时拒绝，不做覆盖。
 * @returns 注销函数；只在「当前仍是这一份」时才清空自己那条。
 * @throws {TypeError} 定义不合法或 `id` 已被注册时。
 */
export function registerChatMemoryProvider(def: ChatMemoryProvider): () => void {
  validateMemoryProvider(def);
  if (providers.has(def.id)) throw new TypeError(`记忆 provider id 已被注册: ${def.id}`);
  providers.set(def.id, def);
  return () => {
    if (providers.get(def.id) === def) providers.delete(def.id);
  };
}

/**
 * 按 id 查找实现。
 * @param id - 配置里写的 provider id；空串等价于内置实现。
 * @returns 命中时给出定义；未注册时回落内置实现（调用方据此比对 `id` 判断是否回落）。
 */
export function resolveChatMemoryProvider(id: string): ChatMemoryProvider {
  return providers.get(id) ?? providers.get(NATIVE_MEMORY_ID) ?? nativeProvider;
}

/**
 * 当前可用的实现目录；Cordis `list()` 与 `GET /memory/providers` 共用这一份。
 * @returns 按注册顺序排列；`native` 恒在首位。
 */
export function listChatMemoryProviders(): MemoryCatalog {
  return {
    providers: [...providers.values()].map((provider) => ({ id: provider.id, name: provider.name })),
  };
}

/**
 * 清空注册并复位到只剩内置实现，供测试隔离用例。
 * @internal
 */
export function resetChatMemoryProviders(): void {
  providers.clear();
  providers.set(NATIVE_MEMORY_ID, nativeProvider);
}
