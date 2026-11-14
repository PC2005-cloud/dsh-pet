/**
 * edge 在线语音的封装：按需加载 @andresaya/edge-tts 拿 mp3，把任何失败收敛成一个错误类型。
 *
 * 依赖在真正合成时才 import：语音是可选能力，包缺失只能让这一次合成失败，不能把整个插件
 * 卡在启动阶段（插件加载期缺一个可选依赖 → 宿主判定必需插件未激活 → 整个 DSH 启动失败）。
 * 用动态 import 而不是 createRequire：应用产物把依赖内联进单文件（tsdown 的 noExternal），
 * 打包器只跟踪静态可见的 import；放在 try 里，缺包时照样只失败这一次。
 * SSML 拼装、XML 转义、WebSocket 与 DRM 令牌都由依赖负责——它**已经做了转义**，本模块传
 * 原文即可，再转一次会把 `&` 念成「amp」。协议变动时只需升级依赖，这里不改代码。
 * @module dsh-pet/src/host/voice/edge
 */
import type { SynthInput } from './types.ts';

/** 依赖的模块形状：运行时代码只出现在按需 import 处。 */
type EdgeTtsModule = typeof import('@andresaya/edge-tts');

/** 依赖自带的静默超时（ms）：每来一帧就重置，只能防卡死，不能当总时限用。 */
const SYNTHESIS_TIMEOUT_MS = 15_000;

/** 合成失败：上层据此回 `generate-error`，不区分上游细节。 */
export class VoiceSynthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceSynthError';
  }
}

/**
 * 把一段文本合成为 mp3 字节。
 *
 * @param input - 文本、音色、语速与中止信号；音色必须是 edge 服务端的 short name。
 * @returns mp3 字节；落盘由调用方负责。
 * @throws {VoiceSynthError} 依赖缺失、上游失败或超时时。
 */
export async function synthesize({ signal, text, voice, rate }: SynthInput): Promise<Uint8Array> {
  try {
    // 按需加载：包缺失时这里抛 MODULE_NOT_FOUND，由下面统一归成 VoiceSynthError。
    // CJS 包经 dynamic import 后可能只露 default，两种形状都认。
    const mod = (await import('@andresaya/edge-tts')) as EdgeTtsModule & { default?: EdgeTtsModule };
    const EdgeTTS = mod.EdgeTTS ?? mod.default?.EdgeTTS;
    if (!EdgeTTS) throw new VoiceSynthError('依赖未导出 EdgeTTS');
    const tts = new EdgeTTS();
    const result = await tts.generate(text, voice, { rate, signal, timeout: SYNTHESIS_TIMEOUT_MS });
    return result.audio;
  } catch (error) {
    throw new VoiceSynthError(error instanceof Error ? error.message : String(error));
  }
}
