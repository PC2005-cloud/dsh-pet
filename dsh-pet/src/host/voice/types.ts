/**
 * 语音合成的公共契约：实现形状、音色标识与注册校验。
 * 音色对外只有 `providerId/voiceId` 一种形态，前缀由注册表统一拼——两处各拼一次就会出现「配置里能选、请求里找不到」。
 * @module dsh-pet/src/host/voice/types
 */

/** 一个可选音色；`id` 只在所属 provider 内唯一。 */
export interface VoiceInfo {
  /** provider 内的音色 id；不含 `/`。 */
  readonly id: string;
  readonly name: string;
  /** 展示用副标题，如「女 · 活泼」；缺省时前端只显示 name。 */
  readonly tag?: string;
}

/** 合成输出的音频格式；宿主据此决定缓存扩展名与应答 MIME。 */
export type VoiceFormat = 'mp3' | 'wav';

/** 一次合成请求；字段在入口已校验，provider 不再重复校验。 */
export interface SynthInput {
  /** 已 trim 的正文；非空，长度 ≤ 500（UTF-16 字符）。 */
  readonly text: string;
  /** 选中的音色，已去掉 provider 前缀，必在本实现的 `voices` 内。 */
  readonly voice: string;
  /** 语速偏移百分比：0 = 原速，-10 = 慢 10%；范围 -50..100。 */
  readonly rate: number;
  /** 宿主在 `timeoutMs` 到点后 abort；可以忽略，忽略只会白占上游。 */
  readonly signal?: AbortSignal;
}

/** 语音实现；注册后由注册表按 provider id 收录。 */
export interface VoiceProvider {
  /** 全局唯一，kebab-case；重复注册会被拒绝。 */
  readonly id: string;
  /** 展示名，设置页用作分组标题。 */
  readonly name: string;
  /** 本实现支持的音色；至少一个，组内 id 唯一。 */
  readonly voices: readonly VoiceInfo[];
  /** 输出格式；缺省 `mp3`。 */
  readonly format?: VoiceFormat;
  /** 单次合成超时（ms）；缺省 15000。 */
  readonly timeoutMs?: number;
  /**
   * 把一段文本合成为音频字节。
   *
   * 失败必须抛错——宿主会归一成 `generate-error` 并记日志；自己吞掉会让上层以为成功。
   * 空字节同样按失败处理，否则 0 字节文件会被缓存命中逻辑反复重合成。
   *
   * @param input - 文本、音色、语速与中止信号。
   * @returns 音频字节；格式由 {@link VoiceProvider.format} 声明。
   */
  synthesize(input: SynthInput): Promise<Uint8Array>;
}

/** 限定 id 命中注册表后的结果；`limitedId` 原样带回，供缓存键与日志使用。 */
export interface ResolvedVoice {
  readonly provider: VoiceProvider;
  readonly voice: VoiceInfo;
  readonly limitedId: string;
}

/** 音色目录；Cordis `list()` 与 `GET /voice/voices` 返回同一份。 */
export interface VoiceCatalog {
  readonly providers: readonly CatalogProvider[];
}

/** 目录里的一个 provider 分组；顺序即注册顺序。 */
export interface CatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly voices: readonly CatalogVoice[];
}

/** 目录里的一个音色；`id` 是限定 id。 */
export interface CatalogVoice {
  readonly id: string;
  readonly name: string;
  readonly tag?: string;
}

/** 限定 id 的分隔符；provider id 与 voice id 自身都不允许出现它。 */
export const VOICE_ID_SEPARATOR = '/';

/** provider id 的形状：kebab-case，避免配置里出现空白、斜杠这类需要转义的形态。 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 限定 id 的形状：kebab-case 的 provider 前缀 + 非空且不含斜杠、不含空白的音色名。 */
export const VOICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[^\s/]+$/;

/** 实现的缺省超时（ms）；调用方不声明时用它兜住不会自己断的上游。 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

/**
 * 拼限定 id。
 * @param providerId - 已通过注册校验的 provider id。
 * @param voiceId - provider 内的音色 id。
 * @returns `providerId/voiceId`。
 */
export function limitedVoiceId(providerId: string, voiceId: string): string {
  return providerId + VOICE_ID_SEPARATOR + voiceId;
}

/**
 * 切分限定 id。
 *
 * 只按第一个分隔符切：音色名允许出现除 `/` 外的任何字符，provider id 不允许，所以首段即 provider。
 *
 * @param limitedId - 待解析的限定 id。
 * @returns 两侧都非空时的分段；缺分隔符或任一侧为空时返回 `undefined`。
 */
export function splitVoiceId(limitedId: string): { providerId: string; voiceId: string } | undefined {
  const separatorAt = limitedId.indexOf(VOICE_ID_SEPARATOR);
  if (separatorAt <= 0) return undefined;
  const providerId = limitedId.slice(0, separatorAt);
  const voiceId = limitedId.slice(separatorAt + 1);
  if (voiceId.length === 0 || voiceId.includes(VOICE_ID_SEPARATOR)) return undefined;
  return { providerId, voiceId };
}

/** 非空字符串：`trim` 之后仍有内容。 */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验一个注册定义；不合法即抛出，调用方在写入注册表之前调用。
 *
 * @param def - 注册方传入的原始值。
 * @throws {TypeError} 任一字段缺失、类型不符或音色 id 重复时。
 */
export function validateVoiceProvider(def: unknown): asserts def is VoiceProvider {
  if (!def || typeof def !== 'object') throw new TypeError('语音 provider 定义必须是对象');
  const provider = def as Record<string, unknown>;

  if (typeof provider.id !== 'string' || !PROVIDER_ID_PATTERN.test(provider.id)) {
    throw new TypeError(`provider id 必须是小写 kebab-case，收到 ${JSON.stringify(provider.id)}`);
  }
  if (!isFilledString(provider.name)) {
    throw new TypeError(`provider ${provider.id} 的 name 必须是非空字符串`);
  }
  if (typeof provider.synthesize !== 'function') {
    throw new TypeError(`provider ${provider.id} 的 synthesize 必须是函数`);
  }

  const format = provider.format;
  if (format !== undefined && format !== 'mp3' && format !== 'wav') {
    throw new TypeError(`provider ${provider.id} 的 format 必须是 mp3 或 wav，收到 ${JSON.stringify(format)}`);
  }

  const timeoutMs = provider.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`provider ${provider.id} 的 timeoutMs 必须是正有限数，收到 ${JSON.stringify(timeoutMs)}`);
  }

  const voices = provider.voices;
  if (!Array.isArray(voices) || voices.length === 0) {
    throw new TypeError(`provider ${provider.id} 的 voices 必须是非空数组`);
  }

  const seen = new Set<string>();
  for (const rawVoice of voices) {
    if (!rawVoice || typeof rawVoice !== 'object') {
      throw new TypeError(`provider ${provider.id} 的 voices 项必须是对象`);
    }
    const voice = rawVoice as Record<string, unknown>;
    if (!isFilledString(voice.id) || voice.id.includes(VOICE_ID_SEPARATOR)) {
      throw new TypeError(
        `provider ${provider.id} 的音色 id 必须是非空且不含 '/' 的字符串，收到 ${JSON.stringify(voice.id)}`,
      );
    }
    if (!isFilledString(voice.name)) {
      throw new TypeError(`provider ${provider.id} 的音色 ${voice.id} 缺少 name`);
    }
    if (seen.has(voice.id)) throw new TypeError(`provider ${provider.id} 的音色 id 重复: ${voice.id}`);
    seen.add(voice.id);
  }
}
