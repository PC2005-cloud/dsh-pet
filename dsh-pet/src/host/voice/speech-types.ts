/**
 * 语音识别的公共契约：实现形状与注册校验。
 * 只有一层——provider 就是一套识别能力；语言由实现自己检测，不作为参数。
 * @module dsh-pet/src/host/voice/speech-types
 */

/** 一次识别请求；字段在入口已校验。 */
export interface SpeechInput {
  /** 完整 WAV：16kHz / 单声道 / PCM16。 */
  readonly audio: Uint8Array;
  /** 宿主在 `timeoutMs` 到点后 abort；可忽略，忽略只会白占上游连接。 */
  readonly signal?: AbortSignal;
}

/** 语音识别实现；注册后由注册表按 provider id 收录。 */
export interface SpeechProvider {
  /** 全局唯一，kebab-case；重复注册会被拒绝。 */
  readonly id: string;
  /** 展示名，设置页下拉里的文字。 */
  readonly name: string;
  /** 单次识别超时（ms）；缺省 {@link DEFAULT_SPEECH_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  /**
   * 把一段 WAV 识别成文字。
   *
   * 失败必须抛错；返回空串表示这段没人说话，是合法结果。
   *
   * @param input - 音频字节与中止信号。
   * @returns 识别出的文字，可以为空串。
   */
  transcribe(input: SpeechInput): Promise<string>;
}

/** 能力不可用（宿主没装插件、没配 key）；与「识别失败」区分，映射成 `unsupported`。 */
export class SpeechUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechUnavailableError';
  }
}

/** 可选实现目录；Cordis `list()` 与 `GET /voice/hear-providers` 返回同一份。 */
export interface SpeechCatalog {
  readonly providers: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** 实现的缺省超时（ms）；本地 CPU 推理一句话远低于此。 */
export const DEFAULT_SPEECH_TIMEOUT_MS = 30_000;

/** provider id 的形状：kebab-case，避免配置里出现空白、斜杠这类需要转义的形态。 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 非空字符串：`trim` 之后仍有内容。 */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验一个注册定义；不合法即抛出，调用方在写入注册表之前调用。
 *
 * @param def - 注册方传入的原始值。
 * @throws {TypeError} 任一字段缺失、类型不符或 id 形态非法时。
 */
export function validateSpeechProvider(def: unknown): asserts def is SpeechProvider {
  if (!def || typeof def !== 'object') throw new TypeError('语音识别 provider 定义必须是对象');
  const provider = def as Record<string, unknown>;

  if (typeof provider.id !== 'string' || !PROVIDER_ID_PATTERN.test(provider.id)) {
    throw new TypeError(`provider id 必须是小写 kebab-case，收到 ${JSON.stringify(provider.id)}`);
  }
  if (!isFilledString(provider.name)) {
    throw new TypeError(`provider ${provider.id} 的 name 必须是非空字符串`);
  }
  if (typeof provider.transcribe !== 'function') {
    throw new TypeError(`provider ${provider.id} 的 transcribe 必须是函数`);
  }

  const timeoutMs = provider.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`provider ${provider.id} 的 timeoutMs 必须是正有限数，收到 ${JSON.stringify(timeoutMs)}`);
  }
}
