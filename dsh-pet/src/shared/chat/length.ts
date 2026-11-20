/** 对话的发送上限，不是草稿的编辑上限。与宿主一致，按去首尾空白后的 UTF-16 长度计。 */
export const CHAT_MESSAGE_LIMIT = 2000;

/** 文本可以保留在草稿里，但超长时不应发给宿主。 */
export function isChatMessageTooLong(text: string): boolean {
  return text.trim().length > CHAT_MESSAGE_LIMIT;
}
