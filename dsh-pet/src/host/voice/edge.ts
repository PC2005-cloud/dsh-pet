/**
 * edge 在线语音的封装：按需加载 @andresaya/edge-tts 拿 mp3，把任何失败收敛成一个错误类型。
 *
 * 依赖在真正合成时才 import：语音是可选能力，包缺失只能让这一次合成失败，不能把整个插件
 * 卡在启动阶段（插件加载期缺一个可选依赖 → 宿主判定必需插件未激活 → 整个 DSH 启动失败）。
 * SSML 拼装、XML 转义、WebSocket 与 DRM 令牌都由依赖负责——它**已经做了转义**，本模块传
 * 原文即可，再转一次会把 `&` 念成「amp」。协议变动时只需升级依赖，这里不改代码。
 * 不负责缓存与队列：本模块只保证「给定文本 → 一个 mp3 文件」这一件事。
 * @module dsh-pet/src/host/voice/edge
 */
import { createRequire } from 'node:module';
import { rename, rm, writeFile } from 'node:fs/promises';

/** 依赖的模块形状：类型位置引用不会产生运行时代码，运行时代码只出现在按需 require 处。 */
type EdgeTtsModule = typeof import('@andresaya/edge-tts');

/**
 * 按需加载可选依赖用的 CommonJS require。
 *
 * 不用动态 `import()`：宿主产物按单文件加载，动态 import 会被打包器拆成 chunk；这个依赖是 CJS，
 * require 既能在包缺失时抛出可捕获的错误，也不会把可选依赖拖进启动路径。
 */
const requireOptional = createRequire(import.meta.url);

/** 单次合成超时（ms）：上游长时间无响应就判失败，不拖住串行队列。 */
const SYNTHESIS_TIMEOUT_MS = 15_000;

/** 合成失败：上层据此回 `generate-error`，不区分上游细节。 */
export class VoiceSynthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceSynthError';
  }
}

/** 合成一次需要的参数。 */
export interface SynthInput {
  /** 已通过长度与空白校验的文本，原样交给依赖（转义由它负责）。 */
  readonly text: string;
  /** 白名单内的音色 id。 */
  readonly voice: string;
  /** prosody rate 表达式，如 `+0%`。 */
  readonly rate: string;
  /** 目标 mp3 的最终路径；父目录必须已存在。 */
  readonly target: string;
}

/**
 * 把一段文本合成到目标 mp3。
 *
 * 先写 `<target>.part` 再改名：`target` 一旦出现就是完整文件，中途失败不会留下半截 mp3
 * 被缓存命中逻辑当成有效音频。
 *
 * @param input - 文本、音色、语速与目标路径。
 * @throws {VoiceSynthError} 上游失败、超时或写盘失败时。
 */
export async function synthesize({ text, voice, rate, target }: SynthInput): Promise<void> {
  const staging = `${target}.part`;
  try {
    // 按需加载：包缺失时这里抛 MODULE_NOT_FOUND，由下面统一归成 VoiceSynthError。
    const { EdgeTTS } = requireOptional('@andresaya/edge-tts') as EdgeTtsModule;
    const tts = new EdgeTTS();
    const result = await tts.generate(text, voice, { rate, timeout: SYNTHESIS_TIMEOUT_MS });
    await writeFile(staging, result.audio);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw new VoiceSynthError(error instanceof Error ? error.message : String(error));
  }
}
