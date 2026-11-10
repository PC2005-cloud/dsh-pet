/**
 * 语音合成来源：内置 edge 在线语音，或 BreezeBlue 正式音色。
 *
 * 只放 enumerations 与默认值：宿主合成、设置页下拉、独立模式脚本都读这一份，
 * 不各写一套字符串。音色白名单各自归自己的模块（edge 见 host/voice/voices）。
 * @module dsh-pet/src/shared/voice-provider
 */

/** 可选的语音合成来源。 */
export const TTS_PROVIDERS = ['edge', 'breeze'] as const;

/** 语音合成来源 id。 */
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

/** 默认来源：内置 edge，与加这个字段之前的行为一致（不需要任何密钥）。 */
export const DEFAULT_TTS_PROVIDER: TtsProvider = 'edge';

/**
 * BreezeBlue 的默认音色：用户在本工作站选定的正式 Voice ID。
 *
 * 放在 shared 而不是 host：设置页的初值也要用它，而 host/voice/breeze 依赖 node:fs，
 * 浏览器半侧不能引用。音色由用户在 Breeze 控制台自建，插件无法枚举，配置里留空就用它。
 */
export const BREEZE_DEFAULT_VOICE_ID = 'voc_8yud7hz7c9q2';

/**
 * 校验来源取值。
 * @param value - 配置里的原始值。
 * @returns 合法时返回 id；其余返回 `undefined`。
 */
export function normalizeTtsProvider(value: unknown): TtsProvider | undefined {
  return typeof value === 'string' && (TTS_PROVIDERS as readonly string[]).includes(value)
    ? (value as TtsProvider)
    : undefined;
}
