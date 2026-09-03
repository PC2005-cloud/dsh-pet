/**
 * 对话生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）按当前对话用的
 * provider/model 生成一句回复。与碎碎念（generateWhisper）同构，区别是：
 *  - 输入带历史对话（memory.json 截取的最近 N 轮），历史以 user/assistant 消息进入请求；
 *  - user 消息 = 用户刚输入的话（不是"随便叨叨"指令）；
 *  - 回复放宽到 256 token（对话比碎碎念可说得稍多），超时放宽到 60s。
 *
 * 设计：
 *  - provider/model 直接取 agentDefaultModel.currentSelection()（与余额/碎碎念同源）；
 *  - system = 用户配置的 whisperPrompt（人设：碎碎念与对话共用同一人设）；
 *  - reasoningEffort: 'off' —— 仅当模型声明支持 reasoning effort（含 "off"）时传，
 *    关闭深度思考：闲聊对话不需要推理。无 reasoning 元数据的模型（如
 *    reasoningEfforts: false）显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT
 *    并折叠成空流（表现为"模型未返回文本"），因此这类模型省略该字段（语义等价于不传）；
 *  - 历史 assistant 消息用 createAssistantMessage 构造（provider/model 记当前选择，
 *    仅作消息角色载体，不涉及适配器回放）；
 *  - 流式收集 + BlockAssembler 拼装文本；生成失败显式返回结构化原因，不伪造文案。
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { supportsReasoningOff } from './llm-reasoning';

/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构） */
export type ChatGenerateResult =
  { ok: true; text: string } | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 记忆中的一条消息（与 shared/chat.ts 的 ChatMessage 同构） */
export interface ChatMemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够 */
const TIMEOUT_MS = 60_000;

/**
 * 生成一句对话回复。
 * @param ctx 宿主上下文（注入 agentDefaultModel / llm）
 * @param system 人设提示词（whisperPrompt）
 * @param history 最近记忆（按时间正序；user/assistant 交替）
 * @param userText 用户刚输入的话
 * @returns 回复文本，或结构化失败（provider 缺失 / 生成错误）
 */
export async function generateChat(
  ctx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm?: unknown },
  system: string,
  history: ChatMemoryMessage[],
  userText: string,
): Promise<ChatGenerateResult> {
  let sel: { provider: string; model: string };
  try {
    sel = ctx.agentDefaultModel.currentSelection();
  } catch {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  if (!sel?.provider || !sel?.model) {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  const llm = (ctx as { llm?: { stream(o: unknown): AsyncIterable<unknown> } }).llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' };
  }

  // 历史 → dsh-llm 消息：user 经 createUserMessage（plugin 来源），assistant 经 createAssistantMessage
  const historyMessages = history.map((m) =>
    m.role === 'user'
      ? createUserMessage({
          content: [{ type: 'text', text: m.content }],
          source: { kind: 'plugin', plugin: 'dsh-pet' },
        })
      : createAssistantMessage({
          content: [{ type: 'text', text: m.content }],
          source: { provider: sel.provider, model: sel.model },
        }),
  );

  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  // 仅当模型声明支持 reasoning effort（含 "off"）时才传，否则省略：
  // 无 reasoning 元数据的模型（如 reasoningEfforts: false）显式传 off 会被
  // dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT 并折叠成空流（表现为"模型未返回文本"）。
  const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
  const options = {
    provider: sel.provider,
    model: sel.model,
    messages: [
      ...historyMessages,
      createUserMessage({
        content: [{ type: 'text', text: userText }],
        source: { kind: 'plugin', plugin: 'dsh-pet' },
      }),
    ],
    system,
    maxTokens: 256,
    temperature: 1,
    // 统一关闭深度思考：闲聊对话不需要推理（与碎碎念同一约束；仅模型声明支持时传）
    ...(supportsOff ? { reasoningEffort: ReasoningEffortId('off') } : {}),
    signal: deadline,
  };

  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk as Parameters<BlockAssembler['push']>[0]);
    }
  } catch (e) {
    return {
      ok: false,
      reason: 'generate-error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? (b as { text: string }).text : ''))
    .join('')
    .trim();
  if (!text) return { ok: false, reason: 'generate-error', message: '模型未返回文本' };
  return { ok: true, text };
}
