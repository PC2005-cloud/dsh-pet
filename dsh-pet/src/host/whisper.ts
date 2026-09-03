/**
 * 碎碎念生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）按当前对话用的
 * provider/model 生成一句话。与余额不同：不自己拼各服务商端点、不碰凭证——
 * ctx.llm 已接管适配器路由/模型解析/凭据，天然与对话页完全一致。
 *
 * 设计：
 * - provider/model 直接取 agentDefaultModel.currentSelection()（与余额同源）；
 * - system = 用户配置的 whisperPrompt（人设），user = 一个极简的"说句话"请求；
 * - reasoningEffort: 'off' —— 仅当模型声明支持 reasoning effort（含 "off"）时传，
 *   关闭深度思考：碎碎念只求随口一句，不开推理（省时省 token）。无 reasoning 元数据的
 *   模型（如 reasoningEfforts: false）显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT
 *   并折叠成空流（表现为"模型未返回文本"），因此这类模型省略该字段（语义等价于不传）；
 * - 流式收集 + BlockAssembler 拼装文本；生成失败显式返回结构化原因，不伪造文案；
 * - 短超时（LLM 冷启动/慢响应时快速放弃，不留挂起请求）。
 */

import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { supportsReasoningOff } from './llm-reasoning';

/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构） */
export type WhisperGenerateResult =
  { ok: true; text: string } | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 单次生成超时（ms）：骈骈念不需要长输出，30s 足够 */
const TIMEOUT_MS = 30_000;

/**
 * 用当前对话的 provider/model 生成一句碎碎念。
 * @param ctx 宿主上下文（注入 agentDefaultModel / llm）
 * @param system 人设提示词（whisperPrompt）
 * @returns 生成的文本，或结构化失败（provider 缺失 / 生成错误）
 */
export async function generateWhisper(
  ctx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm?: unknown },
  system: string,
): Promise<WhisperGenerateResult> {
  let sel: { provider: string; model: string };
  try {
    sel = ctx.agentDefaultModel.currentSelection();
  } catch {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  if (!sel?.provider || !sel?.model) {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  // ctx.llm 是核心服务但保持防御：缺失时显式失败（静默跳过由上层决定）
  const llm = (ctx as { llm?: { stream(o: unknown): AsyncIterable<unknown> } }).llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' };
  }

  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  // 仅当模型声明支持 reasoning effort（含 "off"）时才传，否则省略：
  // 无 reasoning 元数据的模型（如 reasoningEfforts: false）显式传 off 会被
  // dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT 并折叠成空流（表现为"模型未返回文本"）。
  const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
  const options = {
    provider: sel.provider,
    model: sel.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: '随便说一句日常碎碎念，一句就好，20 字以内。' }],
        source: { kind: 'plugin', plugin: 'dsh-pet' },
      }),
    ],
    system,
    maxTokens: 60,
    temperature: 1,
    // 统一关闭深度思考：碎碎念不需要推理，只求随口一句（仅模型声明支持时传）
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
