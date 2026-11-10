/**
 * 语音服务：校验输入、串行排队、查缓存、调合成，把结果收敛成「文件路径或失败原因」。
 *
 * 队列放在这里而不是路由里：并发上限是资源约束，与 HTTP 无关。串行保证同一时刻只有
 * 一条上游连接，也保证先点先响——并发合成会让顺序不可预测。
 * 三个来源按优先级选：第三方注册的实现 → 配置指定的 BreezeBlue → 内置 edge。
 * 选了 breeze 却没配密钥时回落 edge 并留一行告警：宁可换个嗓子出声，也不要整条语音链静默失效。
 * 不负责把 mp3 交给客户端：那是路由与 bridge 的事。
 * @module dsh-pet/src/host/voice/speak
 */
import { stat, writeFile } from 'node:fs/promises';
import { cacheKey, cachePath, ensureCacheDir, pruneCache } from './cache.ts';
import { isBreezeVoiceId, rateToSpeed, synthesizeBreeze } from './breeze.ts';
import { VoiceSynthError, synthesize, type SynthInput } from './edge.ts';
import { activeVoiceProvider, type VoiceProvider } from './registry.ts';
import { DEFAULT_VOICE, VOICES, isKnownVoice, type VoiceInfo } from './voices.ts';

/** 单次请求允许的最大文本长度（字符，按 UTF-16 计）。 */
export const MAX_TEXT_CHARS = 500;
/** 同时排队的合成上限（含正在跑的那个）；超出直接拒绝，不无限堆积。 */
export const MAX_QUEUE = 3;

/** 语速表达式：`+N%` 或 `-N%`。 */
const RATE_PATTERN = /^[+-]\d{1,3}%$/;
/** 语速下界（百分比）。 */
const RATE_MIN_PERCENT = -50;
/** 语速上界（百分比）。 */
const RATE_MAX_PERCENT = 100;
/** 第三方实现的单次合成上限（ms）：与内置同口径，避免一句卡住串行队列。 */
const PROVIDER_TIMEOUT_MS = 15_000;
/** 内置 edge 合成的总时限（ms）：依赖自带的 15s 只是「静默」超时，每来一帧就重置，不能当总时限用。 */
const BUILTIN_TIMEOUT_MS = 28_000;
/** 排队超过这么久还没轮到就丢弃（ms）：等得比一次合成还久，客户端早已放弃，再合成只是白烧上游。 */
const STALE_WAIT_MS = BUILTIN_TIMEOUT_MS;

/** 一次合成的输入（已校验）。 */
interface SpeakInput {
  readonly text: string;
  readonly voice: string;
  readonly rate: string;
}

/** 配置里的 BreezeBlue 参数（已解析成可用的形状）。 */
export interface BreezeSettings {
  /** API key；空串 = 未配置，调用方应回落 edge。 */
  readonly apiKey: string;
  /** 音色 id（`voc_...`）。 */
  readonly voiceId: string;
  /** 回复语言（ISO 639-1）；空串 = 让上游按文本判断。 */
  readonly languageCode?: string;
}

/** 合成来源：第三方实现 / BreezeBlue / 内置 edge。 */
type VoiceSource =
  | { readonly kind: 'provider'; readonly provider: VoiceProvider }
  | { readonly kind: 'breeze'; readonly settings: BreezeSettings }
  | { readonly kind: 'edge' };

/** 失败原因；路由层原样映射成 `result.ts` 的 reason。 */
export type SpeakFailure = 'bad-request' | 'voice-busy' | 'generate-error';

/** 合成结果：成功时给出最终 mp3 的绝对路径。 */
export type SpeakResult = { ok: true; file: string } | { ok: false; reason: SpeakFailure; message: string };

/** 语音服务：路由层只依赖这两个方法。 */
export interface VoiceService {
  /** 合成一段文本；同一输入命中缓存时不再联网。 */
  speak(raw: unknown): Promise<SpeakResult>;
  /** 可选音色列表（与白名单同源）。 */
  listVoices(): readonly VoiceInfo[];
}

/** 解析结论：成功给已校验输入，失败给一句可直接回给调用方的说明。 */
type ParseResult = { ok: true; value: SpeakInput } | { ok: false; message: string };

/**
 * 校验请求体；只认 `text` / `voice` / `rate` 三个字段，其余忽略。
 *
 * `voice` 的合法域跟随当前来源：edge 只认四个内置音色，BreezeBlue 只认 `voc_...` 形状
 * （音色由用户在 Breeze 控制台自建，插件枚举不全），第三方实现则整段忽略。
 * 这样客户端照配置回传 `voiceName` 时，三条路径都能原样通过。
 */
function parseSpeakInput(raw: unknown, source: VoiceSource): ParseResult {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { ok: false, message: 'text is required' };
  if (text.length > MAX_TEXT_CHARS) return { ok: false, message: `text too long (max ${MAX_TEXT_CHARS} chars)` };
  const voice = resolveVoice(body.voice, source);
  if (!voice.ok) return voice;
  const rate = body.rate === undefined ? '+0%' : body.rate;
  if (typeof rate !== 'string' || !RATE_PATTERN.test(rate)) {
    return { ok: false, message: 'rate must look like +0% or -10%' };
  }
  const percent = Number(rate.slice(1, -1));
  if (!Number.isFinite(percent) || percent < RATE_MIN_PERCENT || percent > RATE_MAX_PERCENT) {
    return { ok: false, message: `rate out of range (${RATE_MIN_PERCENT}%..+${RATE_MAX_PERCENT}%)` };
  }
  return { ok: true, value: { text, voice: voice.value, rate } };
}

/** 校验 `voice` 并归一化成本次真正要用的音色 id（第三方实现恒为空串：嗓子由它自己决定）。 */
function resolveVoice(raw: unknown, source: VoiceSource): { ok: true; value: string } | { ok: false; message: string } {
  if (source.kind === 'provider') return { ok: true, value: '' };
  if (source.kind === 'breeze') {
    if (raw === undefined) return { ok: true, value: source.settings.voiceId };
    if (typeof raw === 'string' && isBreezeVoiceId(raw)) return { ok: true, value: raw };
    // 端上会把配置里的 voiceName 原样回传（它与 ttsProvider 是两个独立字段，切来源时不会一起变）。
    // 那是 edge 的白名单音色，在 breeze 下**不是错误**：当作「没指定」，用配置里的 Breeze 音色发声。
    // 不这么做的话，切到 breeze 后每一句都会被判 bad-request，表现为「配了但完全没声音」。
    if (typeof raw === 'string' && isKnownVoice(raw)) return { ok: true, value: source.settings.voiceId };
    return { ok: false, message: 'unknown voice; breeze expects an id like voc_xxxxxxxx' };
  }
  const voice = raw === undefined ? DEFAULT_VOICE : raw;
  if (typeof voice !== 'string' || !isKnownVoice(voice)) {
    return { ok: false, message: `unknown voice; allowed: ${VOICES.map((item) => item.id).join(', ')}` };
  }
  return { ok: true, value: voice };
}

/** 断言用：`SpeakResult` 的构造点都经过这里，避免各处手写同一句文案。 */
function dropped(): SpeakResult {
  return { ok: false, reason: 'voice-busy', message: 'queued too long, dropped' };
}

/**
 * 这一条排队等得太久了吗。
 *
 * 等得比一次合成允许的时长还久，客户端那边早已超时放弃：再合成只是白烧上游，
 * 而且声音出来时说的已经是上一件事。
 *
 * @param queuedMs - 入队时刻。
 * @param nowMs - 轮到自己时的时刻。
 * @param waitMs - 容许的最长排队时间；缺省用 {@link STALE_WAIT_MS}，测试注入更短的值。
 * @returns 应该丢弃时为 true。
 * @internal
 */
export function isQueueStale(queuedMs: number, nowMs: number, waitMs: number = STALE_WAIT_MS): boolean {
  return nowMs - queuedMs > waitMs;
}

/** 造语音服务。 */
export function createVoiceService(options: {
  /** 用户数据根；缓存落在 `<userRoot>/voice-cache/`。 */
  userRoot: string;
  /** 留痕用；不传则静默。只记字数与结果，不记正文（用户内容不进日志）。 */
  log?: { info?(message: string): void; warn?(message: string): void };
  /** 合成实现；测试注入替身，缺省走 edge 的真实实现。 */
  synthesize?: (input: SynthInput) => Promise<void>;
  /** 容许的最长排队时间（ms）；缺省 {@link STALE_WAIT_MS}，测试用它把丢弃分支逼出来。 */
  staleWaitMs?: number;
  /**
   * BreezeBlue 配置来源：每次合成现读，改配置不必重建服务。
   * 返回 `undefined` = 该来源未启用（回落 edge）；返回对象但 `apiKey` 为空 = 配了没填密钥，同样回落并告警。
   */
  breeze?: () => BreezeSettings | undefined;
  /** Breeze 合成实现；测试注入替身，缺省走真实 HTTP。 */
  synthesizeBreeze?: typeof synthesizeBreeze;
}): VoiceService {
  const { userRoot, log } = options;
  const synthesizeImpl = options.synthesize ?? synthesize;
  const breezeImpl = options.synthesizeBreeze ?? synthesizeBreeze;
  const staleWaitMs = options.staleWaitMs ?? STALE_WAIT_MS;
  /** 已占用的队列名额（含正在跑的那个）。 */
  let queueUsed = 0;
  /** 串行链：上一件事收尾（成功或失败）后才轮到下一件。 */
  let chain: Promise<void> = Promise.resolve();
  /** 缺密钥的告警已打过：配置没改时每个请求都打一遍会把日志刷满，一次足够定位。 */
  let warnedMissingBreezeKey = false;

  /**
   * 本次该用哪个来源。
   *
   * 优先级：第三方注册 > BreezeBlue > edge。第三方优先是既有契约（注册即接管），不能因为
   * 新增 Breeze 就悄悄把它挤掉；Breeze 配了没密钥时回落 edge 而不是报错——用户只是忘了填 key，
   * 整条语音链不该因此静默失效。
   */
  function activeSource(): VoiceSource {
    const provider = activeVoiceProvider();
    if (provider) return { kind: 'provider', provider };
    const breeze = options.breeze?.();
    if (!breeze) return { kind: 'edge' };
    if (breeze.apiKey === '') {
      if (!warnedMissingBreezeKey) {
        warnedMissingBreezeKey = true;
        log?.warn?.('[dsh-pet] voice speak: ttsProvider=breeze 但未配置 Breeze API key，本次回落 edge');
      }
      return { kind: 'edge' };
    }
    return { kind: 'breeze', settings: breeze };
  }

  /** 把一次合成排进串行链；无论成败都释放名额。 */
  function enqueue(task: () => Promise<void>): Promise<void> {
    queueUsed += 1;
    const run = chain.then(task, task);
    // 链本身不能带拒绝，否则后续任务会继承同一个失败；拒绝只交给本次的调用方
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      queueUsed -= 1;
    });
  }

  /** 缓存命中返回文件路径；不存在或空文件返回 undefined。 */
  async function findCached(target: string): Promise<string | undefined> {
    try {
      const info = await stat(target);
      return info.isFile() && info.size > 0 ? target : undefined;
    } catch {
      return undefined;
    }
  }

  async function speak(raw: unknown): Promise<SpeakResult> {
    // 每次请求现查一次：第三方可能运行中才注册、配置也可能刚改过，启动快照会漏掉这些
    const source = activeSource();
    const parsed = parseSpeakInput(raw, source);
    if (!parsed.ok) return { ok: false, reason: 'bad-request', message: parsed.message };
    const { text, voice, rate } = parsed.value;
    const sourceId = source.kind === 'provider' ? source.provider.id : source.kind;
    // 来源进键，换实现不会命中旧音频；voice 已是本次真正生效的那个（第三方为空串）。
    // Breeze 的语种也进键：同一句话换语言念是两份音频，不隔离会命中上一语种的旧文件。
    const cacheSource = source.kind === 'breeze' ? `breeze:${source.settings.languageCode ?? ''}` : sourceId;
    const target = cachePath(userRoot, cacheKey(cacheSource, voice, rate, text));
    const startedMs = Date.now();
    const cached = await findCached(target);
    if (cached) {
      log?.info?.(`[dsh-pet] voice speak: cache=hit chars=${text.length} voice=${sourceId}`);
      return { ok: true, file: cached };
    }
    if (queueUsed >= MAX_QUEUE) {
      log?.warn?.(`[dsh-pet] voice speak: queue full (max ${MAX_QUEUE}) chars=${text.length} voice=${sourceId}`);
      return { ok: false, reason: 'voice-busy', message: 'voice queue is full, retry later' };
    }
    const queue = { dropped: false };
    const queuedMs = Date.now();
    try {
      await enqueue(async () => {
        if (isQueueStale(queuedMs, Date.now(), staleWaitMs)) {
          queue.dropped = true;
          return;
        }
        const dir = await ensureCacheDir(userRoot);
        await synthesizeBySource(source, { text, voice, rate, target });
        // 淘汰放在成功之后：失败时不该为腾地方而删掉还能用的缓存
        await pruneCache(dir);
      });
    } catch (error) {
      // 上游细节（含 URL、状态码）不外泄，只留在日志里
      log?.warn?.(
        `[dsh-pet] voice speak: failed chars=${text.length} voice=${sourceId} ` +
          `ms=${Date.now() - startedMs} reason=${error instanceof VoiceSynthError ? error.message : String(error)}`,
      );
      return { ok: false, reason: 'generate-error', message: 'voice synthesis failed' };
    }
    if (queue.dropped) {
      log?.warn?.(
        `[dsh-pet] voice speak: dropped chars=${text.length} voice=${sourceId} queued=${Date.now() - queuedMs}ms`,
      );
      return dropped();
    }
    log?.info?.(
      `[dsh-pet] voice speak: cache=miss chars=${text.length} voice=${sourceId} ms=${Date.now() - startedMs}`,
    );
    return { ok: true, file: target };
  }

  /** 按来源合成一次到 `input.target`；失败一律抛 {@link VoiceSynthError}。 */
  async function synthesizeBySource(
    source: VoiceSource,
    input: { text: string; voice: string; rate: string; target: string },
  ) {
    if (source.kind === 'provider') {
      await synthesizeWithProvider(source.provider, input);
      return;
    }
    if (source.kind === 'breeze') {
      await breezeImpl({
        text: input.text,
        voiceId: input.voice,
        apiKey: source.settings.apiKey,
        ...(source.settings.languageCode ? { languageCode: source.settings.languageCode } : {}),
        speed: rateToSpeed(input.rate),
        target: input.target,
        signal: AbortSignal.timeout(BUILTIN_TIMEOUT_MS),
      });
      return;
    }
    await synthesizeImpl({
      signal: AbortSignal.timeout(BUILTIN_TIMEOUT_MS),
      target: input.target,
      text: input.text,
      voice: input.voice,
      rate: input.rate,
    });
  }

  return { listVoices: () => VOICES, speak };
}

/** 给一个 Promise 套超时；超时 reject，原 Promise 不被取消（provider 自己该处理放弃）。 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('voice provider timed out')), timeoutMs);
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 用第三方实现合成并落盘。
 *
 * 空字节按失败处理：0 字节文件会被 {@link findCached} 的 `size > 0` 跳过，
 * 于是每次请求都重新合成、每次又得到空文件，白烧上游。
 */
async function synthesizeWithProvider(provider: VoiceProvider, input: SynthInput): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await withTimeout(provider.synthesize({ text: input.text, rate: input.rate }), PROVIDER_TIMEOUT_MS);
  } catch (error) {
    throw new VoiceSynthError(error instanceof Error ? error.message : String(error));
  }
  if (bytes.length === 0) throw new VoiceSynthError('voice provider returned empty audio');
  await writeFile(input.target, bytes);
}
