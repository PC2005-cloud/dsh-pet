/**
 * 回复语言白名单：桌宠说话（碎碎念、梦话、对话）用哪种语言。
 *
 * 空串 = 跟随用户（默认，行为与加这个字段之前完全一致）；其余取值是 ISO 639-1 代码，
 * 同时也是 BreezeBlue TTS 的 `language_code`，两处共用同一份清单，不各写一套。
 * @module dsh-pet/src/shared/reply-language
 */

/** 可选回复语言（不含「跟随用户」）；顺序即设置页下拉的展示顺序。 */
export const REPLY_LANGUAGES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const;

/** 一种可选回复语言。 */
export type ReplyLanguageId = (typeof REPLY_LANGUAGES)[number];

/** 设置里的取值：空串代表跟随用户。 */
export type ReplyLanguage = '' | ReplyLanguageId;

/**
 * 校验并归一化设置值。
 *
 * @param value - 配置或请求里的原始值。
 * @returns 合法时返回归一化后的值（trim 后小写）；非法返回 `undefined`。
 */
export function normalizeReplyLanguage(value: unknown): ReplyLanguage | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().toLowerCase();
  if (id === '') return '';
  return (REPLY_LANGUAGES as readonly string[]).includes(id) ? (id as ReplyLanguageId) : undefined;
}

/**
 * 语言在提示词里的称呼：中文名 + 目标语言自称，模型两种写法都认。
 *
 * 导出是为了让独立模式设置页的下拉复用同一份称呼——两处各写一套必然漂移。
 */
export const REPLY_LANGUAGE_LABELS: Record<ReplyLanguageId, string> = {
  zh: '简体中文',
  en: '英语（English）',
  ja: '日语（日本語）',
  es: '西班牙语（Español）',
  fr: '法语（Français）',
  de: '德语（Deutsch）',
  ru: '俄语（Русский）',
  pt: '葡萄牙语（Português）',
};

/**
 * 拼出 system 提示词里的【语言】段。
 *
 * 写中文而不是目标语言：人设与其余指令都是中文，混语言会让模型在「用哪种语言思考」上摇摆。
 * 明确「主人换语言也不跟随」，否则用户偶尔说一句英文就会把整段对话带偏。
 *
 * @param id - 已校验的回复语言；空串或非法返回空串（不加这一段）。
 * @returns 一行提示词；不需要约束时为空串。
 */
export function replyLanguageLine(id: unknown): string {
  const language = normalizeReplyLanguage(id);
  if (!language) return '';
  return `【语言】始终用${REPLY_LANGUAGE_LABELS[language]}回复主人，主人换用别的语言说话也继续用${REPLY_LANGUAGE_LABELS[language]}。不要解释这条语言要求。`;
}
