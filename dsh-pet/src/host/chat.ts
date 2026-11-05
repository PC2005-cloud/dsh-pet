/**
 * 对话生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）生成一句回复。
 *
 * 负责把历史记忆、用户输入与人设拼成一次生成请求，并解析可选的配图标记。
 * 不负责记忆读写与落盘，也不负责写气泡——那些在路由层与两端消费侧。
 * 依赖 ctx.llm、agentDefaultModel（与碎碎念同源）与调用方给的表情包池。
 * 始终成立：候选模型失败要显式回落并留痕；生成失败返回结构化原因，不伪造文案。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/chat
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { actionInstruction, extractChatAction } from './chat-action.ts';
import type { PetImageRef } from './image-attachment.ts';
import { PET_CALL_IDENTITY, noTextReason } from './llm-call.ts';
import { supportsReasoningOff } from './llm-reasoning.ts';
import { defaultLog } from './log-file.ts';
import { extractChatImage, memeCatalog, type MemeEntry } from './memes.ts';
import { modelCandidates, modelLabel, type ModelRef } from './model-selection.ts';
import { historyStampOf } from './time-context.ts';
import { recalledContextText } from './memory-context.ts';

/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构）。 */
export type ChatGenerateResult =
  | { ok: true; text: string; image?: string; action?: string }
  | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 记忆中的一条消息：GET /chat 返回的窗口条目就是它。 */
export interface ChatMemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  /** 该轮用户上传的图片（附件引用，不含图片本体）；只存不送——历史回放不带图。 */
  image?: PetImageRef;
  /** 该轮 AI 配的表情包名称（不是条目对象）；回放历史时以 `[图:名称]` 回填给模型（不带图本体）。 */
  meme?: string;
  /** 该轮 AI 表演的动作名（animations.categories 内的名字）；回放历史时以 `[动作:名称]` 回填。 */
  action?: string;
}

/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够。 */
const TIMEOUT_MS = 60_000;

/** 历史消息打时间前缀的阈值（ms）：30 分钟内的连续对话不加，避免每句都多几个 token。 */
const HISTORY_STAMP_GAP_MS = 30 * 60 * 1000;

/**
 * user 历史消息的正文：距现在超过阈值时，前面加 `[10月31日 22:53]`。
 *
 * 只给 user 打：同一轮 user / assistant 共享同一个 ts，标一条就够；标在 assistant 上时，
 * 模型会把这行当成自己的说话格式照抄（实际出现过回复以 `[11:54]` 开头）。
 * 阈值内的连续对话不加前缀——否则一段正常闲聊会变成每句一个时间戳。
 *
 * @param message - 历史消息（带 ts）。
 * @param nowMs - 本次生成时刻（毫秒），整批历史共用一个，避免逐条取时钟导致同批时间不一致。
 * @returns 需要前缀时返回 `[时:分] 原文`，否则原样返回 `content`。
 */
function userHistoryTextOf(message: ChatMemoryMessage, nowMs: number): string {
  if (!Number.isFinite(message.ts)) return message.content;
  // 用 > 而不是 >=：恰好 30 分钟仍算连续对话；ts 在未来（时钟回拨）时差为负，自然不加
  if (!(nowMs - message.ts > HISTORY_STAMP_GAP_MS)) return message.content;
  const stamp = historyStampOf(message.ts, new Date(nowMs));
  return stamp === '' ? message.content : '[' + stamp + '] ' + message.content;
}

/**
 * 历史里回填的配图 / 动作标记（`[动作:名称]` 与 `[图:名称]`，各占一行，顺序固定）。
 *
 * 记忆里只存名字、正文里的标记在落盘前已被剥掉；不回填的话模型看不到自己前几轮配过哪张图、
 * 演过什么动作，用户说“换一个”时它连换的是什么都不知道，只会重复挑同一张或答非所问。
 * 只回填 assistant：user 的附件引用依旧不带（旧图不重发给模型）。
 * 名称可能为空串（手改过记忆文件）——空值不回填，纯文本历史逐字不变。
 *
 * @param message - 历史消息。
 * @returns 需要回填时返回 `\n[动作:…]\n[图:…]`，否则空串。
 */
function historyMarkersOf(message: ChatMemoryMessage): string {
  if (message.role !== 'assistant') return '';
  const lines: string[] = [];
  if (typeof message.action === 'string' && message.action !== '') lines.push('[动作:' + message.action + ']');
  if (typeof message.meme === 'string' && message.meme !== '') lines.push('[图:' + message.meme + ']');
  return lines.length === 0 ? '' : '\n' + lines.join('\n');
}

/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守）。
 *  交给模型选而不是随机抽：对话有真实上下文（用户输入 + 历史），按语境挑才贴合。 */
function imageInstruction(pool: MemeEntry[]): string {
  return (
    '\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n' +
    memeCatalog(pool) +
    '\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。'
  );
}

/** 动作指令与动作标记的解析都在 ./chat-action：它们只服务对话这条路径，与 /anim 的决策层分开。 */

/** 一次对话生成的输入。 */
export interface ChatGenerateInput {
  /** Exact, bounded historical evidence for this request only. */
  readonly recalledContext?: string;
  /** 宿主上下文（注入 agentDefaultModel / llm）。 */
  readonly ctx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm?: unknown };
  /** 人设提示词（whisperPrompt，与碎碎念共用同一人设）。 */
  readonly system: string;
  /** 最近记忆（按时间正序，user / assistant 交替）。 */
  readonly history: readonly ChatMemoryMessage[];
  /** 用户刚输入的话；图片不带任何文字描述，语境全靠它。 */
  readonly userText: string;
  /** 表情包候选池；空 / 缺省 = 纯文本（指令与解析都不介入）。 */
  readonly pool?: readonly MemeEntry[];
  /** 可表演的动作名单（对话联动开关开启时传，来自 animations.categories）；空 / 缺省 = 不注入也不解析。 */
  readonly actions?: readonly string[];
  /** 条目单独指定的模型（chatModel）；缺省 / 留空 = 只用当前对话的模型。 */
  readonly preferred?: ModelRef;
  /** 本轮附带的图片；缺省 = 纯文本请求，数据路径与加入图片前一致。 */
  readonly image?: PetImageRef;
}

/**
 * 生成一句对话回复。
 *
 * @param input - 上下文、人设、历史、用户输入，以及可选的配图池 / 指定模型 / 图片。
 * @returns 回复文本（+ 命中池内的配图名），或结构化失败（provider 缺失 / 生成错误）。
 */
export async function generateChat(input: ChatGenerateInput): Promise<ChatGenerateResult> {
  const { ctx, system, history, userText, preferred, image } = input;
  // 表情包侧的读池 / 校验函数按可变数组签名；这里复制一份，避免把调用方数组的引用往下传
  const pool: MemeEntry[] = [...(input.pool ?? [])];
  // 动作名单同样是「空 = 关闭」：开关关掉或 categories 没配任何动作时，指令与解析都不介入。
  const actions: string[] = [...(input.actions ?? [])];
  // 候选链：配置的模型优先 → 当前对话的模型兜底（chatModel 留空时链上只有后者）
  const candidates = modelCandidates(ctx, preferred);
  if (candidates.length === 0) {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  const llm = (ctx as { llm?: { stream(o: unknown): AsyncIterable<unknown> } }).llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' };
  }
  // 依次尝试：配置的模型失败（凭据被删 / 模型下架 / 该服务商没配 key）时回落到当前对话的模型
  // 重试一次——那才是用户当前真正在用的模型，报错更有意义。
  // 兜底文案与失败分支同源，避免两处字面量漂移
  let last: ChatGenerateResult = { ok: false, reason: 'generate-error', message: noTextReason(undefined) };
  for (const [i, sel] of candidates.entries()) {
    const result = await generateWith(ctx, {
      llm,
      sel,
      system,
      history,
      userText,
      pool,
      actions,
      image,
      recalledContext: input.recalledContext,
    });
    if (result.ok) return result;
    last = result;
    // 回落要留痕：配的模型没生效时能在日志里看到原因（否则「我明明配了 A，怎么还是用 B」没法查）
    if (i + 1 < candidates.length) {
      defaultLog(
        'warn',
        `dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`,
      );
    }
  }
  return last;
}

/** 单个候选模型的一次生成请求（候选链的一环）。 */
interface GenerateOnce {
  readonly recalledContext?: string;
  readonly llm: { stream(o: unknown): AsyncIterable<unknown> };
  readonly sel: ModelRef;
  readonly system: string;
  readonly history: readonly ChatMemoryMessage[];
  readonly userText: string;
  readonly pool: MemeEntry[];
  readonly actions: string[];
  readonly image?: PetImageRef;
}

/** 用一个确定的 provider/model 跑一次对话生成（失败原样返回结构化原因，不吞）。 */
async function generateWith(ctx: { llm?: unknown }, once: GenerateOnce): Promise<ChatGenerateResult> {
  const { llm, sel, system, history, userText, pool, actions, image } = once;
  // 历史 → dsh-llm 消息：user 经 createUserMessage（plugin 来源），assistant 经 createAssistantMessage
  // （provider/model 只是消息的角色载体，不涉及适配器回放）。
  // 时间前缀只加在 user 上（模型会照抄 assistant 自己那侧的格式）；配图/动作标记只加在 assistant 上。
  const nowMs = Date.now();
  const historyMessages = history.map((m) =>
    m.role === 'user'
      ? createUserMessage({
          content: [{ type: 'text', text: userHistoryTextOf(m, nowMs) }],
          source: { kind: 'user' },
        })
      : createAssistantMessage({
          content: [{ type: 'text', text: m.content + historyMarkersOf(m) }],
          source: { provider: sel.provider, model: sel.model },
        }),
  );

  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  // 仅当模型声明支持 reasoning effort（含 "off"）时才传，否则省略：
  // 无 reasoning 元数据的模型显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT，
  // 折叠成空流（表现为「模型未返回文本」）。
  const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
  // 配图 / 动作：各自的清单非空才把指令附进 user 正文（空 = 该功能关闭）。
  // 顺序固定「配图在前、动作在后」：配图是既有行为，新增的动作排在它后面，不改既有提示词的位置。
  const wantImage = pool.length > 0;
  const wantAction = actions.length > 0;
  const instruction = (wantImage ? imageInstruction(pool) : '') + (wantAction ? actionInstruction(actions) : '');
  const content: Record<string, unknown>[] = [
    ...(once.recalledContext ? [{ type: 'text', text: recalledContextText(once.recalledContext) }] : []),
    { type: 'text', text: instruction === '' ? userText : userText + instruction },
  ];
  // 图片块排在文本块之后：提示词先到、像素后到，模型更容易按提示去看图。
  if (image !== undefined) content.push({ type: 'image', attachment: image });
  const options = {
    provider: sel.provider,
    model: sel.model,
    // 调用身份（见 llm-call.ts）：缺它时 opencode-go 回 400
    sessionId: PET_CALL_IDENTITY,
    messages: [
      ...historyMessages,
      createUserMessage({
        // PetImageRef 与 dsh-llm 的 ImageAttachmentRef 字段一致，差异只有品牌化类型（attachmentId 是 branded string）；
        // 插件侧不引 @deepseek-ai/dsh-attachment 的类型包，这里显式断言一次。
        content: content as unknown as Parameters<typeof createUserMessage>[0]['content'],
        source: { kind: 'user' },
      }),
    ],
    system,
    // 不显式限 maxTokens：与碎碎念同因——推理模型把思考计入预算，显式小上限会截断正文；
    // 不传由 dsh-llm 按适配器 defaultMaxTokens 兜底，对话短回复输出仍短。
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
  if (!text) return { ok: false, reason: 'generate-error', message: noTextReason(assembler.finish) };
  if (!wantImage && !wantAction) return { ok: true, text };
  // 先剥动作再剥配图：两种标记互不依赖，顺序不影响结果；动作的无效名称也会被剥（见 extractChatAction）。
  const acted: { text: string; action?: string } = wantAction ? extractChatAction(text, actions) : { text };
  const picked: { text: string; image?: string } = wantImage
    ? extractChatImage(acted.text, pool)
    : { text: acted.text };
  return {
    ok: true,
    text: picked.text,
    ...(picked.image ? { image: picked.image } : {}),
    ...(acted.action ? { action: acted.action } : {}),
  };
}
