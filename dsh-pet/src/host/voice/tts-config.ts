/**
 * 语音合成来源的配置解析：把成品配置（main 条目）翻成本服务能直接用的形状。
 *
 * 只做「读字段 → 归一化」这一件事，不发请求、不缓存。密钥来源两处，环境变量优先：
 * 环境变量适合临时验证与 CI，配置文件适合设置页保存——后者落盘在用户目录，不进仓库。
 * 缺密钥不抛错：回落 edge 由调用方决定（见 ./speak 的 activeSource）。
 * @module dsh-pet/src/host/voice/tts-config
 */
import { DEFAULT_TTS_PROVIDER, normalizeTtsProvider, type TtsProvider } from '../../shared/voice-provider.ts';
import { normalizeReplyLanguage } from '../../shared/reply-language.ts';
import { BREEZE_DEFAULT_VOICE_ID, isBreezeVoiceId } from './breeze.ts';
import type { BreezeSettings } from './speak.ts';

/** 环境变量名：只在没有配置值时作为回落来源。 */
export const BREEZE_API_KEY_ENV = 'BREEZE_API_KEY';

/** 从成品配置里读出的语音参数。 */
export interface VoiceSettings {
  /** 合成来源。 */
  readonly provider: TtsProvider;
  /** BreezeBlue 参数；`provider` 不是 breeze 时为 undefined。 */
  readonly breeze?: BreezeSettings;
}

/**
 * 解析成品配置。
 *
 * @param main - `readAllConfig` 的 main 条目（合并器已填默认，这里仍按脏值兜底）。
 * @param env - 环境变量取用函数；测试注入，生产传 `process.env`。
 * @returns 归一化后的语音参数；来源非法时按内置默认（edge）。
 */
export function readVoiceSettings(
  main: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): VoiceSettings {
  const provider = normalizeTtsProvider(main?.ttsProvider) ?? DEFAULT_TTS_PROVIDER;
  if (provider !== 'breeze') return { provider };
  const configuredKey = typeof main?.breezeApiKey === 'string' ? main.breezeApiKey.trim() : '';
  const apiKey = (env[BREEZE_API_KEY_ENV] ?? '').trim() || configuredKey;
  const rawVoice = typeof main?.breezeVoiceId === 'string' ? main.breezeVoiceId.trim() : '';
  const voiceId = isBreezeVoiceId(rawVoice) ? rawVoice : BREEZE_DEFAULT_VOICE_ID;
  // 语音用哪种语言念：跟随回复语言；没设就让上游按文本判断（不猜、不硬塞 zh）
  const spoken = normalizeReplyLanguage(main?.replyLanguage) ?? '';
  return {
    provider,
    breeze: { apiKey, voiceId, ...(spoken ? { languageCode: spoken } : {}) },
  };
}
