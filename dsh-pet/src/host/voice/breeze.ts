/**
 * BreezeBlue 在线语音的封装：一次 POST 换回 mp3，把任何失败收敛成 VoiceSynthError。
 *
 * 用全局 fetch 而不是引 SDK：只用到「一段文本 → 一段音频」这一个端点，多一个依赖就多一份
 * 打包与升级负担（见 https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech）。
 * 不负责缓存、队列、密钥读取：那些分别归 ./cache、./speak、./breeze-key。
 * @module dsh-pet/src/host/voice/breeze
 */
import { rename, rm, writeFile } from 'node:fs/promises';
import { VoiceSynthError } from './edge.ts';

// 默认音色的真源在 shared：设置页也要用它，而本模块依赖 node:fs，浏览器半侧引用不了。
export { BREEZE_DEFAULT_VOICE_ID } from '../../shared/voice-provider.ts';

/** 默认 API 根地址；单测可注入本地替身。 */
export const BREEZE_DEFAULT_BASE_URL = 'https://api.breeze.blue';

/** 输出格式：24 kHz / 128 kbps mp3，与 edge 那一路的播放假定一致（音频元素直接播）。 */
const OUTPUT_FORMAT = 'mp3_24000_128';

/** 错误体最多记这么多字符：上游偶尔回整页 HTML，日志不该被它撑爆。 */
const MAX_ERROR_SNIPPET = 200;

/**
 * Breeze 音色 id 的形状：`voc_` + 小写字母数字。
 * 只做形状校验而不是白名单——音色由用户在 Breeze 控制台自建，插件不可能枚举全量。
 */
const BREEZE_VOICE_PATTERN = /^voc_[a-z0-9]{4,64}$/i;

/** 判断一个串是不是 Breeze 音色 id（形状层面）。 */
export function isBreezeVoiceId(id: unknown): id is string {
  return typeof id === 'string' && BREEZE_VOICE_PATTERN.test(id);
}

/** 一次 Breeze 合成需要的参数。 */
export interface BreezeSynthInput {
  /** 已通过长度与空白校验的文本。 */
  readonly text: string;
  /** 音色 id（`voc_...`）。 */
  readonly voiceId: string;
  /** API key；调用方保证非空（缺 key 时不该走到这里）。 */
  readonly apiKey: string;
  /** ISO 639-1 语言代码；空串 = 不传，由上游按文本自动判断。 */
  readonly languageCode?: string;
  /** 语速倍率 0.5–2.0；缺省 1。 */
  readonly speed?: number;
  /** 目标 mp3 的最终路径；父目录必须已存在。 */
  readonly target: string;
  /** 总时限。 */
  readonly signal?: AbortSignal;
  /** API 根地址；缺省 {@link BREEZE_DEFAULT_BASE_URL}。 */
  readonly baseUrl?: string;
}

/** 把上游错误体压成一行可进日志的摘要；不含 key、不含完整 URL。 */
function describeFailure(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_SNIPPET);
  return snippet ? `breeze ${status}: ${snippet}` : `breeze ${status}`;
}

/**
 * 把一段文本合成到目标 mp3。
 *
 * 先写 `<target>.part` 再改名：target 一旦出现就是完整文件，中途失败不会留下半截 mp3
 * 被缓存命中逻辑当成有效音频。
 *
 * @param input - 文本、音色、密钥、语言、语速与目标路径。
 * @throws {VoiceSynthError} 上游失败、超时、返回空体或写盘失败时。
 */
export async function synthesizeBreeze(input: BreezeSynthInput): Promise<void> {
  const base = input.baseUrl ?? BREEZE_DEFAULT_BASE_URL;
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${OUTPUT_FORMAT}`;
  const staging = `${input.target}.part`;
  const body = {
    text: input.text,
    ...(input.languageCode ? { language_code: input.languageCode } : {}),
    ...(input.speed === undefined || input.speed === 1 ? {} : { voice_settings: { speed: input.speed } }),
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': input.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!response.ok) {
      // 错误体只在日志里留摘要：上游可能回整页 HTML，而且不该把请求头带出去
      throw new VoiceSynthError(describeFailure(response.status, await response.text().catch(() => '')));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new VoiceSynthError('breeze returned empty audio');
    await writeFile(staging, bytes);
    await rename(staging, input.target);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    if (error instanceof VoiceSynthError) throw error;
    throw new VoiceSynthError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 把 edge 的 prosody 百分比换算成 Breeze 的语速倍率。
 *
 * 两侧口径不同：edge 是「相对基线加减百分比」，Breeze 是「绝对值倍率」。`+0%` → 1.0，
 * `+100%` → 2.0（上游上界），`-50%` → 0.5（上游下界）；越界按边界夹取，不抛错。
 *
 * @param rate - `+N%` / `-N%` 形式的语速表达式。
 * @returns 0.5–2.0 的倍率。
 */
export function rateToSpeed(rate: string): number {
  // 只去掉末尾的 `%`：连首个字符一起切会把负号一起切掉，`-50%` 变成 `+50%`。
  const percent = Number(rate.slice(0, -1));
  if (!Number.isFinite(percent)) return 1;
  return Math.min(2, Math.max(0.5, 1 + percent / 100));
}
