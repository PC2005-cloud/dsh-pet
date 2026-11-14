/**
 * 语音识别服务：校验输入、按 provider id 选实现、跑转写，把结论收敛成「文字或失败原因」。
 *
 * 音频格式（16kHz/单声道/PCM16 WAV）由实现自己校验：同一规则不在两处各写一份，
 * 否则改一边就会和另一边对不上。这里只挡明显不合法的输入，避免白跑一次推理。
 * 不负责录音与传输——进来的是已经解码的整段音频字节。
 * @module dsh-pet/src/host/voice/hear
 */
import { listSpeechCatalog, resolveSpeechProvider } from './speech-registry.ts';
import { DEFAULT_SPEECH_TIMEOUT_MS, SpeechUnavailableError, type SpeechCatalog } from './speech-types.ts';

/** 单次识别的音频上限（字节）：base64 后仍落在 10 MiB 请求体内，约合 200 秒 16kHz 单声道。 */
export const MAX_AUDIO_BYTES = 7 * 1024 * 1024;

/** 失败原因；路由层原样映射成 result.ts 的 reason。 */
export type HearFailure = 'bad-request' | 'unsupported' | 'generate-error';

/** 识别结果：成功给文字，失败给分类与可直接回给调用方的说明。 */
export type HearResult = { ok: true; text: string } | { ok: false; reason: HearFailure; message: string };

/** 语音识别服务：路由层只依赖这两个方法。 */
export interface HearService {
  /** 识别一段音频；`signal` 中止时停止等待（调用方已断开）。 */
  hear(raw: unknown, signal?: AbortSignal): Promise<HearResult>;
  /** 当前可用的实现目录（由注册表提供）。 */
  list(): SpeechCatalog;
}

/** 已校验的识别输入。 */
interface HearInput {
  readonly audio: Uint8Array;
  readonly provider?: string;
}

/** base64 字面量：`Buffer.from` 解码很宽松，先按字母表与补齐规则挡掉脏数据。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** 解析结论：成功给已校验输入，失败给一句说明。 */
type ParseResult = { ok: true; value: HearInput } | { ok: false; message: string };

/**
 * 校验请求体；只认 `audio` 与 `provider` 两个字段，其余忽略。
 *
 * @param raw - 已解析的请求体。
 * @returns 已解码的音频字节；任何字段不合法时给出可直接回给调用方的说明。
 */
function parseHearInput(raw: unknown): ParseResult {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const encoded = typeof body.audio === 'string' ? body.audio.trim() : '';
  if (encoded === '') return { ok: false, message: 'audio is required' };
  if (!BASE64_PATTERN.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1) {
    return { ok: false, message: 'audio must be base64' };
  }
  const audio = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (audio.byteLength === 0) return { ok: false, message: 'audio is empty' };
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return { ok: false, message: `audio too large (max ${MAX_AUDIO_BYTES} bytes)` };
  }
  const provider = body.provider;
  if (provider !== undefined && (typeof provider !== 'string' || provider.trim() === '')) {
    return { ok: false, message: 'provider must be a non-empty string' };
  }
  return {
    ok: true,
    value: { audio, ...(provider === undefined ? {} : { provider: (provider as string).trim() }) },
  };
}

/** 一次识别的结论；`unavailable` 用来区分「能力缺失」与「识别失败」。 */
type DeadlineResult<T> = { ok: true; value: T } | { ok: false; unavailable: boolean; message: string };

/**
 * 给一次识别套上超时与调用方中止，把结论收敛成「值或一句说明」。
 *
 * @param signal - 调用方中止信号（连接断开）。
 * @param timeoutMs - 超时上限。
 * @param task - 真正执行识别的函数。
 * @returns 成功给任务的值；超时、抛错或能力缺失给分类后的说明。
 */
async function withDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<DeadlineResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let onDeadline: (() => void) | undefined;
  // 与实现赛跑：它不理 signal 时超时也必须生效，否则这里会一直等下去
  const deadline = new Promise<never>((_, reject) => {
    onDeadline = () => reject(new Error('speech transcription aborted'));
    controller.signal.addEventListener('abort', onDeadline, { once: true });
  });
  try {
    return { ok: true, value: await Promise.race([task(controller.signal), deadline]) };
  } catch (error) {
    // 能力缺失（插件没装、没配 key）要回 unsupported：让用户知道是环境问题，而不是录音有问题
    return {
      ok: false,
      unavailable: error instanceof SpeechUnavailableError,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    if (onDeadline !== undefined) controller.signal.removeEventListener('abort', onDeadline);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 造识别服务。
 *
 * @param options.configuredProvider - 请求没带 provider 时用的 id；缺省视为没有配置。
 * @param options.timeoutMs - 单次识别超时；缺省 {@link DEFAULT_SPEECH_TIMEOUT_MS}，测试用小值。
 * @returns 只暴露 `hear` 与 `list` 的服务。
 */
export function createHearService(options: {
  configuredProvider?: () => string | undefined;
  timeoutMs?: number;
}): HearService {
  return {
    list: listSpeechCatalog,
    async hear(raw, signal) {
      const parsed = parseHearInput(raw);
      if (!parsed.ok) return { ok: false, reason: 'bad-request', message: parsed.message };

      // 唯一的「默认」来源：请求显式给的，或者用户配置里那个值。查不到就是查不到，不替他挑。
      const providerId = parsed.value.provider ?? options.configuredProvider?.();
      if (!providerId) return { ok: false, reason: 'bad-request', message: 'provider is required' };
      const provider = resolveSpeechProvider(providerId);
      if (!provider) {
        return { ok: false, reason: 'bad-request', message: `provider not found: ${providerId}` };
      }

      // 实现最清楚自己需要多久：它声明了就用它的，服务级只是缺省与测试注入
      const timeoutMs = provider.timeoutMs ?? options.timeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS;
      const run = await withDeadline(signal, timeoutMs, (inner) =>
        provider.transcribe({ audio: parsed.value.audio, signal: inner }),
      );
      if (!run.ok) {
        return { ok: false, reason: run.unavailable ? 'unsupported' : 'generate-error', message: run.message };
      }
      // 实现返回值不可信：不是字符串就当失败，避免把对象塞进 text 字段发出去
      if (typeof run.value !== 'string') {
        return { ok: false, reason: 'generate-error', message: 'invalid transcript from provider' };
      }
      return { ok: true, text: run.value };
    },
  };
}
