/**
 * 语音实现注册表：多槽，每个 provider id 一份，互不覆盖。
 *
 * 插入顺序即注册顺序，目录按它输出；注销只删自己那条，迟到的注销不会顶掉后来者。
 * 只登记与查找：不合成、不缓存、不读配置。内置的 edge 也走这里注册，没有特权路径。
 * @module dsh-pet/src/host/voice/registry
 */
import {
  limitedVoiceId,
  splitVoiceId,
  validateVoiceProvider,
  type ResolvedVoice,
  type VoiceCatalog,
  type VoiceProvider,
} from './types.ts';

/** 已注册的实现：provider id → 定义；Map 的插入顺序就是对外顺序。 */
const providers = new Map<string, VoiceProvider>();

/**
 * 注册一个语音实现。
 *
 * @param def - 实现定义；`id` 已被占用时拒绝，不做覆盖。
 * @returns 注销函数；只在「当前仍是这一份」时才清空自己那条。
 * @throws {TypeError} 定义不合法或 `id` 已被注册时。
 */
export function registerVoiceProvider(def: VoiceProvider): () => void {
  validateVoiceProvider(def);
  if (providers.has(def.id)) throw new TypeError(`provider id 已被注册: ${def.id}`);
  providers.set(def.id, def);
  return () => {
    if (providers.get(def.id) === def) providers.delete(def.id);
  };
}

/**
 * 按限定 id 查找实现与音色。
 *
 * @param limitedId - `providerId/voiceId` 形态的音色 id。
 * @returns 命中时给出实现、音色与原始限定 id；provider 或音色任一缺失时返回 `undefined`。
 */
export function resolveVoice(limitedId: string): ResolvedVoice | undefined {
  const parts = splitVoiceId(limitedId);
  if (!parts) return undefined;
  const provider = providers.get(parts.providerId);
  if (!provider) return undefined;
  const voice = provider.voices.find((item) => item.id === parts.voiceId);
  if (!voice) return undefined;
  return { provider, voice, limitedId };
}

/**
 * 当前可用的完整音色目录；Cordis `list()` 与 `GET /voice/voices` 共用这一份。
 * @returns 按注册顺序分组的目录；没有注册时 `providers` 为空数组。
 */
export function listCatalog(): VoiceCatalog {
  return {
    providers: [...providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      voices: provider.voices.map((voice) => ({
        id: limitedVoiceId(provider.id, voice.id),
        name: voice.name,
        ...(voice.tag === undefined ? {} : { tag: voice.tag }),
      })),
    })),
  };
}

/**
 * 清空注册，供测试隔离用例。
 * @internal
 */
export function resetVoiceProviders(): void {
  providers.clear();
}
