/**
 * 限额与请求 schema：字符数、事件数、速率窗口与 zod 形状。
 *
 * 纯声明与常量，不含逻辑。
 * 必须始终成立：上限只能收紧不能放宽；改 schema 必须同步 README 的模型体验一节。
 * @module dsh-pet/src/standalone/ai-provider/limits
 */
import { z } from 'zod';

/** 伪 ctx 与模型选择器里的服务商标识。 */
export const PROVIDER = 'standalone';

/** 单次输入的总字符上限。 */
export const MAX_INPUT_CHARS = 32_768;

/** 单次输出的总字符上限。 */
export const MAX_OUTPUT_CHARS = 16_384;

/** 单次响应的流事件上限。 */
export const MAX_EVENTS = 4096;

/** 文本块契约。 */
export const textBlock = z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_CHARS) });

/** 消息契约：只保留角色与受限内容。 */
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(MAX_INPUT_CHARS), z.array(z.unknown()).max(128)]),
});

/** 请求契约：服务商固定，模型必须与当前选择一致。 */
export const inputSchema = z.object({
  provider: z.literal(PROVIDER),
  model: z.string().max(200),
  system: z.string().max(MAX_INPUT_CHARS).optional(),
  messages: z.array(messageSchema).min(1).max(64),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
});
