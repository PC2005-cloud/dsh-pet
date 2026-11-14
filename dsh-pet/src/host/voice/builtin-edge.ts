/**
 * 内置 edge 实现：把 edge.ts 接到注册表的 `VoiceProvider` 契约上。
 *
 * 与第三方走同一条注册路径，注册表里没有它的分支；装配层调一次 {@link ensureEdgeProvider} 即可。
 * 只声明能力，不读配置、不落盘：落盘与排队在 speak.ts。
 * @module dsh-pet/src/host/voice/builtin-edge
 */
import { registerVoiceProvider, resolveVoice } from './registry.ts';
import { synthesize } from './edge.ts';
import { limitedVoiceId, type VoiceProvider } from './types.ts';
import { DEFAULT_VOICE, VOICES } from './voices.ts';

/** 内置实现的 id；配置里的音色写作 `edge/<音色>`。 */
export const EDGE_PROVIDER_ID = 'edge';

/**
 * 内置实现的单次合成上限（ms）。
 *
 * 比依赖自带的 15s 静默超时更宽：那个超时每来一帧就重置，只能防卡死，
 * 长文本在正常网络下也可能超过 15s。
 */
const EDGE_TIMEOUT_MS = 28_000;

/** 内置实现：四个中文音色，其余字段全走契约缺省（mp3、无额外元数据）。 */
export const EDGE_PROVIDER: VoiceProvider = {
  id: EDGE_PROVIDER_ID,
  // 分组标题用品牌写法；id 仍是小写 kebab-case，两者不必一致
  name: 'Edge',
  voices: VOICES.map((voice) => ({ id: voice.id, name: voice.name, tag: voice.tag })),
  format: 'mp3',
  timeoutMs: EDGE_TIMEOUT_MS,
  synthesize,
};

/**
 * 确保内置实现在注册表里；重复调用无副作用（多次装配、热重载都会经过这里）。
 *
 * 已经注册过时直接返回，不去覆盖同 id 的另一份——那会让配置里已选的音色在背后换实现。
 */
export function ensureEdgeProvider(): void {
  if (resolveVoice(limitedVoiceId(EDGE_PROVIDER_ID, DEFAULT_VOICE))) return;
  registerVoiceProvider(EDGE_PROVIDER);
}
