/**
 * 碎碎念生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）按条目配置的 whisperModel
 * （留空 = 当前对话用的 provider/model）生成一句话。与余额不同：不自己拼各服务商端点、不碰凭证——
 * ctx.llm 已接管适配器路由/模型解析/凭据，天然与对话页完全一致。
 *
 * 设计：
 * - provider/model：条目配置的 whisperModel 优先（留空 = 不指定），失败回落到
 *   agentDefaultModel.currentSelection()（当前对话的模型，与余额同源）重试一次——
 *   候选链见 model-selection.ts；
 * - system = 用户配置的 whisperPrompt（人设），user = 一个极简的"说句话"请求；
 * - 配图（可选）：开启 whisperImageEnabled 时，由调用方从表情包池随机抽一张传入，
 *   把该图描述注入 user 指令，让这句话配合画面说——随机而非让模型选：
 *   碎碎念本身没有上下文可选（人设固定、无用户输入），交模型"选"只能盲选且多了幻觉风险；
 * - reasoningEffort: 'off' —— 仅当模型声明支持 reasoning effort（含 "off"）时传，
 *   关闭深度思考：碎碎念只求随口一句，不开推理（省时省 token）。无 reasoning 元数据的
 *   模型（如 reasoningEfforts: false）显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT
 *   并折叠成空流（表现为"模型未返回文本"），因此这类模型省略该字段（语义等价于不传）；
 * - 流式收集 + BlockAssembler 拼装文本；生成失败显式返回结构化原因，不伪造文案；
 * - 短超时（LLM 冷启动/慢响应时快速放弃，不留挂起请求）。
 */

import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { supportsReasoningOff } from './llm-reasoning';
import { modelCandidates, modelLabel, type ModelRef } from './model-selection';

/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构） */
export type WhisperGenerateResult =
  | { ok: true; text: string; image?: string }
  | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 单次生成超时（ms）：骈骈念不需要长输出，30s 足够 */
const TIMEOUT_MS = 30_000;

/** 碎碎念指令：纯文本（原行为） */
const USER_TEXT = '随便说一句日常碎碎念，一句就好，20 字以内。';

/**
 * 碎碎念指令：带表情包（用户开启 whisperImageEnabled 时）——要求模型配合作画说一句。
 * 明确「正文仍是一句话」：图是配图，不是让模型描述画面本身。
 */
function userTextWithMeme(meme: { name: string; desc: string }): string {
  return (
    '随便说一句日常碎碎念，一句就好，20 字以内。\n' +
    '这次会配一张表情包一起显示，图的内容是：' +
    meme.name +
    '（' +
    meme.desc +
    '）。\n' +
    '请让这句话和这张图的情绪/场景自然契合，像是配合画面说出来的；不要描述画面本身。'
  );
}

/**
 * 用指定（或当前对话的）provider/model 生成一句碎碎念。
 * @param ctx 宿主上下文（注入 agentDefaultModel / llm）
 * @param system 人设提示词（whisperPrompt）
 * @param meme 配图（开启配图时传入；缺省 = 纯文本碎碎念）。生成成功时原样带回，
 *             客户端据此展示图片（host 不判断模型是否真的贴合）
 * @param preferred 条目配置单独指定的模型（whisperModel）；缺省 / 留空 = 只用当前对话的模型
 * @returns 生成的文本（+ 配图），或结构化失败（provider 缺失 / 生成错误）
 */
export async function generateWhisper(
  ctx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm?: unknown },
  system: string,
  meme?: { name: string; desc: string },
  preferred?: ModelRef,
): Promise<WhisperGenerateResult> {
  // 候选链：配置的模型优先 → 当前对话的模型兜底（whisperModel 留空时链上只有后者，与旧版逐字一致）
  const candidates = modelCandidates(ctx, preferred);
  if (candidates.length === 0) {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  // ctx.llm 是核心服务但保持防御：缺失时显式失败（静默跳过由上层决定）
  const llm = (ctx as { llm?: { stream(o: unknown): AsyncIterable<unknown> } }).llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' };
  }
  // 依次尝试：配置的模型失败（凭据被删 / 模型下架 / 该服务商没配 key）时**回落到当前对话的模型
  // 重试一次**，仍失败才抛出失败原因——最后一次是用户当前真正在用的模型，报错更有意义。
  let last: WhisperGenerateResult = { ok: false, reason: 'generate-error', message: '模型未返回文本' };
  for (const [i, sel] of candidates.entries()) {
    const result = await generateWith(ctx, llm, sel, system, meme);
    if (result.ok) return result;
    last = result;
    // 回落要留痕：配的模型没生效时能在日志里看到原因（否则"我明明配了 A，怎么还是用 B"没法查）
    if (i + 1 < candidates.length) {
      console.warn(
        `dsh-pet: 碎碎念用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`,
      );
    }
  }
  return last;
}

/** 用**一个**确定的 provider/model 跑一次生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith(
  ctx: { llm?: unknown },
  llm: { stream(o: unknown): AsyncIterable<unknown> },
  sel: ModelRef,
  system: string,
  meme?: { name: string; desc: string },
): Promise<WhisperGenerateResult> {
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
        content: [{ type: 'text', text: meme ? userTextWithMeme(meme) : USER_TEXT }],
        source: { kind: 'user' },
      }),
    ],
    system,
    // 不显式限 maxTokens：推理模型会把思考计入预算，显式小上限只会截断正文报"模型未返回文本"；
    // 不传由 dsh-llm 按适配器 defaultMaxTokens（默认 32768）兜底，碎碎念短指令输出仍短。
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
  return meme ? { ok: true, text, image: meme.name } : { ok: true, text };
}
