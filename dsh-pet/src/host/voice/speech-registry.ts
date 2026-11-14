/**
 * 语音识别注册表：多槽，每个 provider id 一份，互不覆盖。
 *
 * 插入顺序即注册顺序，目录按它输出；注销只删自己那条，迟到的注销不会顶掉后来者。
 * 只登记与查找：不识别、不排队、不设超时（那些归 hear.ts）。
 * @module dsh-pet/src/host/voice/speech-registry
 */
import { validateSpeechProvider, type SpeechCatalog, type SpeechProvider } from './speech-types.ts';

/** 已注册的实现：provider id → 定义；Map 的插入顺序就是对外顺序。 */
const providers = new Map<string, SpeechProvider>();

/**
 * 注册一个语音识别实现。
 *
 * @param def - 实现定义；`id` 已被占用时拒绝，不做覆盖。
 * @returns 注销函数；只在「当前仍是这一份」时才清空自己那条。
 * @throws {TypeError} 定义不合法或 `id` 已被注册时。
 */
export function registerSpeechProvider(def: SpeechProvider): () => void {
  validateSpeechProvider(def);
  if (providers.has(def.id)) throw new TypeError(`识别 provider id 已被注册: ${def.id}`);
  providers.set(def.id, def);
  return () => {
    if (providers.get(def.id) === def) providers.delete(def.id);
  };
}

/**
 * 按 id 查找实现。
 * @param id - 注册时声明的 provider id。
 * @returns 命中时给出定义；没注册过返回 `undefined`。
 */
export function resolveSpeechProvider(id: string): SpeechProvider | undefined {
  return providers.get(id);
}

/**
 * 当前可用的实现目录；Cordis `list()` 与 `GET /voice/hear-providers` 共用这一份。
 * @returns 按注册顺序排列；没有注册时 `providers` 为空数组。
 */
export function listSpeechCatalog(): SpeechCatalog {
  return {
    providers: [...providers.values()].map((provider) => ({ id: provider.id, name: provider.name })),
  };
}

/**
 * 清空注册，供测试隔离用例。
 * @internal
 */
export function resetSpeechProviders(): void {
  providers.clear();
}
