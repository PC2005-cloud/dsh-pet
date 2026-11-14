/**
 * DeepSeek 官方 ASR：把 `/v1/tools/asr` 接到注册表的 `SpeechProvider` 契约上。
 * 音频以 multipart 上传（官方只收文件、不收 base64），鉴权同样复用 DSH 凭据。
 * 官方的 8 MiB / 120 秒限制不预判：正常一句话远低于此，超了由官方拒绝。
 * @module dsh-pet/src/host/voice/builtin-deepseek-asr
 */
import { registerSpeechProvider, resolveSpeechProvider } from './speech-registry.ts';
import { SpeechUnavailableError, type SpeechProvider } from './speech-types.ts';

/** 内置实现的 id；配置里的 `speechProvider` 写的就是它。 */
export const DEEPSEEK_ASR_PROVIDER_ID = 'deepseek';

/** 官方接口地址；整段上传、整段返回，不支持流式。 */
const ASR_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr';

/** 取 DEEPSEEK_API_KEY 的回调；没配置时返回 undefined。 */
type ResolveKey = () => Promise<string | undefined>;

/**
 * 造 DeepSeek ASR 实现。
 *
 * @param deps.resolveKey - 惰性取 API key；每次识别现取，改配置不必重建实现。
 * @returns 注册表认得的内置实现。
 */
export function createDeepseekAsrProvider(deps: { resolveKey: ResolveKey }): SpeechProvider {
  return {
    id: DEEPSEEK_ASR_PROVIDER_ID,
    name: 'DeepSeek',
    timeoutMs: 60_000,
    async transcribe({ audio, signal }) {
      const key = await deps.resolveKey();
      // 没配 key 是能力缺失，不是识别失败：让调用方看到「不可用」而不是「识别出错」
      if (!key) throw new SpeechUnavailableError('DEEPSEEK_API_KEY is not configured');
      const form = new FormData();
      // 官方按文件内容检测格式，这里的 MIME 只影响服务端选路；端侧产出的就是 WAV
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
      const res = await fetch(ASR_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal,
      });
      if (!res.ok) throw new Error(`deepseek asr HTTP ${res.status}`);
      const body = (await res.json()) as { text?: unknown };
      // 宿主返回值不可信：不是字符串就当失败，不把对象塞进文字里
      if (typeof body?.text !== 'string') throw new Error('deepseek asr returned invalid body');
      return body.text;
    },
  };
}

/**
 * 确保 DeepSeek ASR 实现在注册表里；重复调用无副作用（多次装配、热重载都会经过这里）。
 *
 * @param deps.resolveKey - 惰性取 API key。
 */
export function ensureDeepseekAsrProvider(deps: { resolveKey: ResolveKey }): void {
  if (resolveSpeechProvider(DEEPSEEK_ASR_PROVIDER_ID)) return;
  registerSpeechProvider(createDeepseekAsrProvider(deps));
}
