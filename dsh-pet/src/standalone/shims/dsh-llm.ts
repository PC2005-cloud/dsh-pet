/**
 * `@deepseek-ai/dsh-llm` 的独立模式替身（消息工厂 / 文本块拼装 / reasoning 标识）。
 *
 * 独立模式没有模型后端。`ctx.llm` 的替身（见 ../context.ts）让**没有显式配置模型**的调用在
 * 候选链阶段就失败：`agentDefaultModel.currentSelection()` 返回的 model 为空 →
 * `model-selection.ts` 的 `currentModel()` 判定为「未配置」→ `generateWhisper` / `generateChat`
 * 直接回 `{ ok: false, reason: 'provider-missing' }`。
 *
 * **但这不是结构性保证。** 用户在配置里显式写了 `whisperModel` / `chatModel`（设置页选过模型
 * 就会写进配置）时，候选链非空，生成侧会真的走到本文件的消息构造与 `ctx.llm.stream`。
 * 所以本文件与 ctx.llm 替身的每一处形状都必须与 DSH 的真实契约一致 —— 0.3.4 的崩溃正是因为
 * `stream` 被当成"永远不走的那条路"，实现成返回 Promise 而契约要求 AsyncIterable
 * （细节见 ../context.ts 里 stream / resolveModelInfo 的注释）。
 *
 * 那为什么还要实现它们：`whisper.ts` / `chat.ts` 是**静态 import** 这四个名字的，
 * 模块图能加载是独立模式起得来的前提；同时保持它们是纯本地、零网络的实现，
 * 将来若有人给独立模式接上模型通道（例如自带 API key），这条路径可以照常工作。
 *
 * 只在独立模式构建里生效：`tsdown.config.mjs` 用 alias 把该包名指向本文件。
 */

/** 消息的最小形状（只有角色、内容与来源标记；适配器回放不在独立模式范围内） */
export interface StandaloneLlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
  source: unknown;
}

/** 用户消息（`whisper.ts` / `chat.ts` 的入参形状） */
export function createUserMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'user', content: input.content, source: input.source };
}

/** 助手消息（`chat.ts` 回放历史用） */
export function createAssistantMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'assistant', content: input.content, source: input.source };
}

/** 文本块（`BlockAssembler.blocks()` 的元素形状） */
export interface StandaloneTextBlock {
  type: 'text';
  text: string;
}

/**
 * 流式文本拼装：只收集文本块（与调用方 `blocks().filter(b => b.type === 'text')` 的用法一致）。
 * 独立模式只会拿到空流（没有模型后端），这里保持最小可用实现。
 */
export class BlockAssembler {
  private readonly chunks: string[] = [];

  /** 收集一个块；非文本块（工具调用等）在独立模式下被忽略 */
  push(chunk: unknown): void {
    if (chunk !== null && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'text') {
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === 'string') this.chunks.push(text);
    }
  }

  /** 当前已拼装的块列表 */
  blocks(): StandaloneTextBlock[] {
    const text = this.chunks.join('');
    return text === '' ? [] : [{ type: 'text', text }];
  }
}

/** reasoning effort 标识工厂（DSH 侧是枚举工厂，这里保持"传什么就是什么"） */
export function ReasoningEffortId(id: string): string {
  return id;
}
