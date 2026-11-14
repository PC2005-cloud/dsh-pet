/**
 * DeepSeek 官方 TTS：把 `/v1/tools/tts` 接到注册表的 `VoiceProvider` 契约上。
 * 鉴权复用 DSH 凭据（`DEEPSEEK_API_KEY`），拿不到就这次失败，不冒充成功。
 * @module dsh-pet/src/host/voice/builtin-deepseek-tts
 */
import { registerVoiceProvider, resolveVoice } from './registry.ts';
import { limitedVoiceId, type SynthInput, type VoiceProvider } from './types.ts';

/** 内置实现的 id；配置里的音色写作 `deepseek/<音色>`。 */
export const DEEPSEEK_TTS_PROVIDER_ID = 'deepseek';

/** 官方接口地址；音频随着合成流式返回，这里整段收下再交给缓存层。 */
const TTS_ENDPOINT = 'https://api.deepseek.com/v1/tools/tts';

/** 官方声明的音色：`id` 就是请求里的 `voice_id`，其余字段只用于展示。 */
const VOICES = [
  { id: 'stella', name: '海星', tag: '女声' },
  { id: 'tide', name: '暗潮', tag: '男声' },
] as const;

/** 取 DEEPSEEK_API_KEY 的回调；没配置时返回 undefined。 */
type ResolveKey = () => Promise<string | undefined>;

/**
 * 造 DeepSeek TTS 实现。
 *
 * @param deps.resolveKey - 惰性取 API key；每次合成现取，改配置不必重建实现。
 * @returns 注册表认得的内置实现。
 */
export function createDeepseekTtsProvider(deps: { resolveKey: ResolveKey }): VoiceProvider {
  return {
    id: DEEPSEEK_TTS_PROVIDER_ID,
    name: 'DeepSeek',
    voices: VOICES,
    format: 'wav',
    timeoutMs: 60_000,
    async synthesize({ text, voice, signal }: SynthInput): Promise<Uint8Array> {
      const key = await deps.resolveKey();
      if (!key) throw new Error('DEEPSEEK_API_KEY is not configured');
      const res = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        // 不带 rate：官方接口没有语速参数，契约里的 rate 在这里没有对应物
        body: JSON.stringify({ text, voice_id: voice, format: 'wav' }),
        signal,
      });
      if (!res.ok) throw new Error(`deepseek tts HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/**
 * 确保 DeepSeek TTS 实现在注册表里；重复调用无副作用（多次装配、热重载都会经过这里）。
 *
 * @param deps.resolveKey - 惰性取 API key。
 */
export function ensureDeepseekTtsProvider(deps: { resolveKey: ResolveKey }): void {
  if (resolveVoice(limitedVoiceId(DEEPSEEK_TTS_PROVIDER_ID, VOICES[0].id))) return;
  registerVoiceProvider(createDeepseekTtsProvider(deps));
}
