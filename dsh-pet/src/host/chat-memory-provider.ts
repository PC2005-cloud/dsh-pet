/**
 * 对话记忆的第三方实现注册表：单槽，后注册覆盖先注册。
 *
 * 一个槽而不是 Map：记忆后端是二选一（原生 / 第三方），两个 recall 同时改内容会互相冲突，
 * 两个 capture 同时上传会重复写。模块单例：注册返回 disposer，测试用 resetChatMemoryProviders 复位。
 * 只登记与查找，不调用、不校验补丁、不落盘。
 * @module dsh-pet/src/host/chat-memory-provider
 */

/** 原生实现的标识；第三方不能占用它（槽为空即原生路径）。 */
export const NATIVE_MEMORY_ID = 'native';

/** 传给召回钩子的历史消息：只给对话所需的三个字段，不带图片引用与动作名。 */
export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly ts: number;
}

/** 本轮将要发给模型的内容；召回钩子拿它做修改。 */
export interface ChatContent {
  readonly system: string;
  readonly history: readonly ChatTurn[];
  readonly userText: string;
}

/** 召回钩子的返回：只覆盖返回了的字段，没返回的保持原值。 */
export interface ChatContentPatch {
  readonly system?: string;
  readonly history?: readonly ChatTurn[];
  readonly userText?: string;
}

/**
 * 第三方记忆实现：对话前修改内容、落盘后接收，两者都是可选的。
 *
 * 只实现 recall = 只读记忆；只实现 capture = 只记不查；两者都实现 = 完整后端。
 */
export interface ChatMemoryProvider {
  /** 唯一标识；参与日志，换实现不会命中旧状态。 */
  readonly id: string;
  /**
   * 对话前修改内容：返回要覆盖的字段，核心合并后再交给模型。
   *
   * 抛错或超时由核心降级为“不修改”，不影响回复；返回 undefined 等同不修改。
   * @param input - 本轮问题、人设与截好的近期历史。
   * @returns 要覆盖的字段；不改任何字段时返回 undefined。
   */
  recall?(
    input: ChatContent & { readonly petId: string },
  ): Promise<ChatContentPatch | undefined> | ChatContentPatch | undefined;
  /**
   * 落盘后接收这一轮问答。
   *
   * 核心不等待：返回值被忽略，抛错只记日志，不影响回复。
   * @param input - 本轮问答与元信息；action/image 只是名字，不含素材本体。
   */
  capture?(input: {
    readonly petId: string;
    readonly userText: string;
    readonly replyText: string;
    readonly action?: string;
    readonly image?: string;
    readonly ts: number;
  }): void | Promise<void>;
}

/** 当前生效的第三方实现；null = 没注册，走原生路径。 */
let current: ChatMemoryProvider | null = null;

/**
 * 注册一个第三方记忆实现，覆盖当前生效的那个。
 *
 * @param def - 实现定义；`recall` 与 `capture` 至少要有一个是函数。
 * @returns 注销函数；只在「当前仍是这一份」时才清空，迟到的注销不会顶掉后来者。
 * @throws {TypeError} 定义非法、id 为空、id 占用原生标识或两个方法都缺失时。
 */
export function registerChatMemoryProvider(def: ChatMemoryProvider): () => void {
  if (!def || typeof def !== 'object') throw new TypeError('memory provider 定义必须是对象');
  if (typeof def.id !== 'string' || def.id.length === 0) throw new TypeError('id 必须是非空字符串');
  if (def.id === NATIVE_MEMORY_ID) throw new TypeError('不能占用原生实现标识: ' + NATIVE_MEMORY_ID);
  if (typeof def.recall !== 'function' && typeof def.capture !== 'function') {
    throw new TypeError('recall 与 capture 至少要有一个是函数');
  }
  current = def;
  return () => {
    if (current === def) current = null;
  };
}

/** 当前该用哪个第三方实现；没注册时返回 null，调用方据此走原生路径。 */
export function activeChatMemoryProvider(): ChatMemoryProvider | null {
  return current;
}

/**
 * 列出可用实现，用于排障「为什么没走我注册的那个」。
 *
 * @returns `builtin` 恒为原生标识；`external` 是当前生效的第三方 id（没有则为空数组）。
 */
export function listChatMemoryProviders(): { builtin: string[]; external: string[] } {
  return { builtin: [NATIVE_MEMORY_ID], external: current ? [current.id] : [] };
}

/**
 * 清空注册，供测试隔离用例。
 * @internal
 */
export function resetChatMemoryProviders(): void {
  current = null;
}
