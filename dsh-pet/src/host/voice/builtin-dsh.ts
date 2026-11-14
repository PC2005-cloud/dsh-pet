/**
 * 内置识别实现：把 DSH 的 `speechToText` 服务接到注册表的 `SpeechProvider` 契约上。
 *
 * 与第三方走同一条注册路径，注册表里没有它的分支；装配层调一次 {@link ensureDshSpeechProvider}。
 * 必须包成工厂：宿主服务要惰性取，没装语音输入插件时取不到。
 * @module dsh-pet/src/host/voice/builtin-dsh
 */
import { registerSpeechProvider, resolveSpeechProvider } from './speech-registry.ts';
import { SpeechUnavailableError, type SpeechProvider } from './speech-types.ts';

/** 内置实现的 id；配置里的 `speechProvider` 写的就是它。 */
export const DSH_SPEECH_PROVIDER_ID = 'dsh';

/** 宿主 `transcribe` 的 signal 是必填的，而契约里可选：没有时用这个永不中止的信号。 */
const NEVER_ABORT = new AbortController().signal;

/**
 * 可用的就绪阶段。
 *
 * `standby` 是资源已就绪、等录音时才唤醒引擎——和 `ready` 一样能立刻用；
 * 其余（unprepared / downloading / failed / cancelled）才是真的不可用。
 */
const USABLE_PHASES: ReadonlySet<string> = new Set(['ready', 'standby']);

/** DSH `speechToText` 的最小形状：只用到列出、就绪状态与转写。 */
interface SpeechToTextLike {
  listProviders(): readonly unknown[];
  snapshot?(): { providers?: readonly { id?: unknown; preparation?: { phase?: unknown } }[] };
  resolve(request: { audio: Uint8Array }): unknown;
  transcribe(spec: unknown, signal: AbortSignal): Promise<{ text?: unknown }>;
}

/**
 * 造内置识别实现。
 *
 * @param deps.speechToText - 惰性取 DSH 的识别服务；没装语音输入插件时返回 undefined。
 * @returns 注册表认得的内置实现。
 */
export function createDshSpeechProvider(deps: { speechToText: () => unknown }): SpeechProvider {
  return {
    id: DSH_SPEECH_PROVIDER_ID,
    name: 'DSH 语音插件',
    async transcribe({ audio, signal }) {
      const speech = deps.speechToText() as SpeechToTextLike | undefined;
      if (speech === undefined || typeof speech.transcribe !== 'function') {
        throw new SpeechUnavailableError('host has no speech-to-text service');
      }
      if (speech.listProviders().length === 0) {
        throw new SpeechUnavailableError('host has no speech provider enabled');
      }
      // 首次使用要下载模型：没有可用状态时回「不可用」，免得用户以为录音有问题。
      // 多识别器时只要有一个可用就算可用——宿主会自己挑，这里不做选择。
      const providers = speech.snapshot?.()?.providers ?? [];
      const isAnyUsable =
        providers.length === 0 || providers.some((item) => USABLE_PHASES.has(String(item.preparation?.phase)));
      if (!isAnyUsable) throw new SpeechUnavailableError('speech provider is not ready');

      const result = await speech.transcribe(speech.resolve({ audio }), signal ?? NEVER_ABORT);
      // 宿主返回值不可信：不是字符串就当失败，不把对象塞进文字里
      if (typeof result?.text !== 'string') throw new Error('invalid transcript from host speech service');
      return result.text;
    },
  };
}

/**
 * 确保内置识别实现在注册表里；重复调用无副作用（多次装配、热重载都会经过这里）。
 *
 * 已经注册过时直接返回，不去覆盖同 id 的另一份。
 *
 * @param deps.speechToText - 惰性取 DSH 的识别服务。
 */
export function ensureDshSpeechProvider(deps: { speechToText: () => unknown }): void {
  if (resolveSpeechProvider(DSH_SPEECH_PROVIDER_ID)) return;
  registerSpeechProvider(createDshSpeechProvider(deps));
}
