/**
 * 本插件所有 LLM 调用的调用身份，以及「没有正文」时的原因解析。
 *
 * 不负责发请求、选模型与拼消息——那是生成侧各模块自己的事；这里只给所有调用两样共享的东西：
 * 一个稳定的调用身份，和一句把流终止原因翻成人话的文案。
 * 必须始终成立：身份字符串不变，适配器靠它生成服务商载体，对端可能据此拒绝请求。
 * @module dsh-pet/src/host/llm-call
 */

/**
 * 调用身份：适配器据此生成服务商需要的载体（opencode-go 会翻成 `x-opencode-session`
 * 请求头，缺这个头该路由回 400）。值只需稳定，不要求是真实会话 id。
 */
export const PET_CALL_IDENTITY = 'dsh-pet';

/**
 * 碎碎念的调用性质（dsh-llm `GenerateOptions.purpose`）：辅助调用，不是对话。
 *
 * 不声明时下游只能按内容猜：billion-context 对 dsh 插件流量按 `system` 指纹分车道，
 * 而碎碎念的 system 带实时时间，于是每条都派生一条 `<身份>|sub:<fp>` 会话记录，
 * 几分钟一条，把正常会话挤出列表。声明后走 side 车道并归并到调用身份（#6880/#6883）。
 * 只为可打印 ASCII、长度 ≤64：该值会被代理原样放进请求头。
 */
export const PET_WHISPER_PURPOSE = 'pet-whisper';

/** 陪聊的调用性质：同样是辅助调用，不占会话车道（理由同 `PET_WHISPER_PURPOSE`）。 */
export const PET_CHAT_PURPOSE = 'pet-chat';

/**
 * 没有正文时，按流终止原因给出要展示的原因。
 * @param finish - 流终止块（`BlockAssembler.finish`；dsh-llm 把适配器抛错折进这里，不在流里抛出）。
 * @returns 上层拼在「对话失败：」之后的文案。
 */
export function noTextReason(finish: unknown): string {
  const { kind, failure } = (finish ?? {}) as { kind?: unknown; failure?: unknown };
  if (kind === 'aborted') return '生成已取消';
  if (kind === 'max-tokens') return '输出达到上限，未产出正文';
  if (kind !== 'error') return '模型未返回文本';
  const { message, code } = (failure ?? {}) as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && message.trim() !== '') return message;
  if (typeof code === 'string' && code.trim() !== '') return code;
  return '未提供失败原因';
}
