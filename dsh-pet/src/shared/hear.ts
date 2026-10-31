/**
 * 端侧语音输入：录一段话，拼成宿主认可的 WAV，`POST /voice/hear` 换回文字。
 *
 * 格式口径（16kHz / 单声道 / PCM16）与宿主 provider 的校验是同一份事实——这里只按它产出，
 * 不再各自校验一遍；真对不上时宿主会回一条可读的失败说明。
 * 只负责「麦克风 → WAV → 文字」，不碰界面：按钮状态、文字落点都归调用方（chat/dom）。
 * @module dsh-pet/src/shared/hear
 */

/** 采样率：宿主 provider 只收 16kHz。 */
export const HEAR_SAMPLE_RATE = 16000;
/**
 * 单次录音上限（ms）。
 *
 * 24 秒 × 32000 B/s ≈ 750KB，base64 后仍落在宿主 1MiB 的请求体里（上限 768KiB 音频）；
 * 再长就必须先想办法分片，那是另一件事。
 */
export const MAX_RECORD_MS = 24_000;
/** 判静音的峰值阈值（0..1）：低于它视为没听到声音，不白送一次识别。 */
export const SILENCE_PEAK = 0.002;
/**
 * 短于它的录音按误触处理。
 *
 * 快捷键按住说话时，一次误碰只会录到几十毫秒；这种片段既不值得送去识别，
 * 也不该报「没听到声音」——它跟麦克风有没有声毫无关系。
 */
export const MIN_RECORD_MS = 300;
/** 等识别结果的上限（ms）：宿主自己 30s 超时，这里留点余量先等它回结构化失败。 */
const HEAR_TIMEOUT_MS = 40_000;
/** 每块采集的样本数：1024 样本 @16kHz = 64ms，松手后等待补齐尾音的时长也按它算。 */
const BLOCK_SAMPLES = 1024;
/** 松手后等最后一块音频落袋（ms）：比一块略长，避免把最后半句话砍掉。 */
const TAIL_SETTLE_MS = 80;

/** 识别结果：成功给文字（空串 = 这段里没人说话），失败给分类与可直接展示的说明。 */
export type HearOutcome =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: 'silent' | 'unsupported' | 'bad-request' | 'generate-error' | 'network';
      readonly message: string;
    };

/** 一段录好的音频：WAV 字节与峰值一起交出去，静音判定不必再解一遍字节。 */
export interface RecordedClip {
  /** 完整的 WAV 字节（16kHz / 单声道 / PCM16）。 */
  readonly wave: Uint8Array;
  /** 峰值（0..1）；低于 {@link SILENCE_PEAK} 就是没听到声音。 */
  readonly peak: number;
}

/** 一次录音的句柄；用完必须 `stop` 或 `cancel`，否则麦克风一直被占着。 */
export interface HearRecorder {
  /** 已录时长（ms）：到 {@link MAX_RECORD_MS} 后不再增长。 */
  elapsedMs(): number;
  /** 停止并交出音频；一个采样都没有时给 null。 */
  stop(): Promise<RecordedClip | null>;
  /** 丢弃录音并释放麦克风；可重复调用。 */
  cancel(): void;
}

/** 浏览器能不能录音；非安全上下文（http 且非 localhost）下 `mediaDevices` 根本不存在。 */
export function canRecord(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * 浮点采样转 16 位整型：超范围先夹紧，负半轴按 32768 缩放，免得 -1 溢出成正数。
 *
 * @param samples - Web Audio 给的 [-1,1] 浮点采样。
 * @returns 可直接写进 WAV 的 16 位采样。
 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/**
 * 量峰值：静音判定只关心「有没有声音进来」，不关心它有多响。
 *
 * @param pcm - 16 位采样。
 * @returns 峰值归一到 0..1；空数组给 0。
 */
export function peakOf(pcm: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (v > peak) peak = v;
  }
  return peak / 0x8000;
}

/**
 * 拼一个裸 PCM 的 WAV：44 字节头 + 采样数据。
 *
 * 头里每个字段宿主都会校验（`fmt ` 长度 16、PCM=1、单声道、16bit、byteRate 自洽），
 * 所以这里按固定偏移逐字节写，不做「挑一个能用的模板」那种取巧。
 *
 * @param pcm - 16 位采样。
 * @param sampleRate - 采样率；缺省 16kHz。
 * @returns 完整 WAV 字节。
 */
export function encodeWave(pcm: Int16Array, sampleRate = HEAR_SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  /** 写 4 字节 ASCII 标记（RIFF/WAVE/fmt /data），全是大写或小写字母，不用考虑编码。 */
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate = 采样率 × 声道 × 位深/8
  view.setUint16(32, 2, true); // blockAlign = 声道 × 位深/8
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

/**
 * 字节转 base64（不带 data: 前缀）。
 *
 * 分段转换：一次性展开几十万字节会撑爆参数栈，而这里是允许 750KB 的量级。
 *
 * @param bytes - 原始字节。
 * @returns 规范 base64。
 */
export function toBase64(bytes: Uint8Array): string {
  const BASE64_CHUNK_BYTES = 8192;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_CHUNK_BYTES, bytes.length);
    for (let i = offset; i < end; i++) binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** 把宿主的失败原因收敛到自己认识的几种；其余一律按生成失败处理。 */
function reasonOf(raw: unknown): 'unsupported' | 'bad-request' | 'generate-error' {
  return raw === 'unsupported' || raw === 'bad-request' ? raw : 'generate-error';
}

/**
 * 把一段 WAV（base64）交给宿主识别。
 *
 * @param url - 已含挂载前缀的识别地址。
 * @param audio - 规范 base64（不带 data: 前缀）。
 * @returns 文字或失败分类；网络异常也收敛成 outcome，不向上抛。
 */
export async function hearAudio(url: string, audio: string, signal?: AbortSignal): Promise<HearOutcome> {
  const timeout = AbortSignal.timeout(HEAR_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const raw: unknown = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: 'network', message: '识别响应不是 JSON' };
    }
    const body = raw as Record<string, unknown>;
    if (body.ok === true && typeof body.text === 'string') return { ok: true, text: body.text };
    return {
      ok: false,
      reason: reasonOf(body.reason),
      message: typeof body.message === 'string' ? body.message : '',
    };
  } catch (e) {
    return { ok: false, reason: 'network', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 开一次录音。
 *
 * 用 `AudioContext({ sampleRate: 16000 })` 让浏览器自己做重采样（硬件通常是 48k），
 * 拿到的就已是目标采样率的单声道浮点；`ScriptProcessor` 虽已标记废弃，但它不需要
 * 额外的 worklet 模块文件——`file://` 页面加载 worklet 会被源头限制卡住。
 *
 * @returns 录音句柄。
 * @throws {Error} 拿不到麦克风时（没权限、设备被占、非安全上下文）——原文交给调用方展示。
 */
export async function startRecording(): Promise<HearRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const ctx = new AudioContext({ sampleRate: HEAR_SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(BLOCK_SAMPLES, 1, 1);
  const chunks: Float32Array[] = [];
  const maxSamples = Math.floor((MAX_RECORD_MS / 1000) * HEAR_SAMPLE_RATE);
  let frames = 0;
  let closed = false;

  processor.onaudioprocess = (event) => {
    if (frames >= maxSamples) return;
    const samples = event.inputBuffer.getChannelData(0);
    const room = maxSamples - frames;
    const take = samples.length > room ? samples.subarray(0, room) : samples;
    // 必须复制：inputBuffer 的底层数组每帧复用，直接存引用会得到一堆相同的数据
    chunks.push(new Float32Array(take));
    frames += take.length;
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  // 上下文默认可能是 suspended（没有用户手势时）；调用方就在 pointerdown 里，够格恢复
  await ctx.resume();

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
    } catch {
      /* 已经断开：无所谓 */
    }
    for (const track of stream.getTracks()) track.stop();
    void ctx.close();
  };

  return {
    elapsedMs: () => (frames / HEAR_SAMPLE_RATE) * 1000,
    async stop() {
      // 采集比释放晚一块：先让最后一块落袋，否则每次都会砍掉几十毫秒的尾音
      await new Promise((resolve) => setTimeout(resolve, TAIL_SETTLE_MS));
      teardown();
      if (frames === 0) return null;
      const all = new Float32Array(frames);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      const pcm = floatToPcm16(all);
      return { wave: encodeWave(pcm), peak: peakOf(pcm) };
    },
    cancel: teardown,
  };
}
