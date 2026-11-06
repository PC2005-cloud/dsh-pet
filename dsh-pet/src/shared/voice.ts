/**
 * 端侧语音播报：按 `say` 叶子决定这一句要不要念，以及合成请求与播放。
 *
 * 两端各判各的：叶子里的 `voiceTo` 指向哪一端，就只有那一端出声；缺省 = 谁都不念。
 * 网页端另加一道「页面可见」——被切到后台的页面没人看，出声只是打扰。
 * 音色、总开关与音量经 `setVoiceConfig` 从成品配置注入；手动点播（对话面板的喇叭）不受这些门控。
 * 每句的开始与结束经 {@link subscribeVoiceUtterance} 广播出去：说话气泡靠它决定何时收起。
 * 不负责合成与缓存：那些在宿主侧（`/voice/speak`）。
 * @module dsh-pet/src/shared/voice
 */
import { ROUTE_PATH } from './constants.ts';
import type { VoiceTarget } from './state.ts';

/** 当前音色；空串 = 不指定，由宿主用默认音色。 */
let voiceName = '';
/** 播报总开关；只有成品配置明确为 true 才播。 */
let voiceEnabled = false;
/** 播放音量系数（0–1，1 = 最大音量）；两端共用，只作用于播放，不影响已合成好的音频。 */
let voiceVolume = 1;
/** 本端是网页端还是桌面端；`null` = 还没声明，此时不按叶子播放。 */
let surface: VoiceTarget | null = null;
/** 接口基址：网页端是同源前缀，桌面端由 `setVoiceBase` 换成 bridge 地址。 */
let voiceBase = ROUTE_PATH;
/** 配置是否已就绪；网页端由 `setVoiceConfig` 置位，桌面端首次播放时懒加载。 */
let configLoaded = false;
/** 当前播报状态；气泡据此显示图标。 */
let voiceState: VoiceState = 'idle';
/** 状态订阅者：两端的说话气泡据此渲染图标。 */
const stateListeners = new Set<(state: VoiceState) => void>();
/** 播报开始/结束的订阅者：说话气泡据此挂起与收尾。 */
const utteranceListeners = new Set<(event: VoiceUtteranceEvent) => void>();
/** 播报序号；每次决定要念一句就自增，用来让气泡丢掉迟到的「上一句播完了」。 */
let utteranceSeq = 0;

/** 语音播报对外的四种状态；只用于展示，不接受外部驱动。`failed` = 这次合成没成功。 */
export type VoiceState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * 一句播报的开始与结束事件。
 *
 * `text` 是气泡上的原文，不是送合成的截断文本——气泡要按它认句：同一页面上的多只宠物
 * 共用这份模块单例状态，不认句就会把别人那一句算到自己头上。
 */
export type VoiceUtteranceEvent =
  | { readonly kind: 'start'; readonly seq: number; readonly text: string }
  | { readonly kind: 'end'; readonly seq: number; readonly text: string };

/**
 * 客户端等合成结果的上限（ms）。
 *
 * 比宿主侧的总超时（28s）再宽一点：让宿主先超时并回结构化失败，
 * 客户端这道只是兜底，避免上游挂住时气泡上的转圈永远停不下来。
 */
const SPEAK_TIMEOUT_MS = 30_000;

/**
 * 等一句播完的上限（ms）。
 *
 * 比气泡自身的挂起上限（50s）再宽一点：正常单句远小于它，到点还没收尾说明播放这条线
 * 已经断了，此时按收尾处理，气泡不至于跟着永久挂住。
 */
export const PLAYBACK_WAIT_MAX_MS = 60_000;

/** 合成请求的超时信号；自动播报与手动点播共用同一份口径。 */
function speakSignal(): AbortSignal {
  return AbortSignal.timeout(SPEAK_TIMEOUT_MS);
}

/** 切换状态并通知订阅者；同值不重复通知。 */
function setVoiceState(next: VoiceState): void {
  if (voiceState === next) return;
  voiceState = next;
  for (const listener of stateListeners) listener(next);
}

/**
 * 读当前播报状态；桌面端在重绘气泡时直接取（它没有 react 的订阅机制）。
 * @returns `idle` / `loading` / `ready`。
 */
export function getVoiceState(): VoiceState {
  return voiceState;
}

/**
 * 订阅播报状态；订阅时会立刻收到当前值。
 * @param listener - 状态变化回调。
 * @returns 取消订阅；组件卸载/气泡关闭时必须调用。
 */
export function subscribeVoiceState(listener: (state: VoiceState) => void): () => void {
  stateListeners.add(listener);
  listener(voiceState);
  return () => {
    stateListeners.delete(listener);
  };
}

/**
 * 订阅每句播报的开始与结束；不补发历史状态，只报后续事件。
 *
 * @param listener - 事件回调：`start` 表示已经决定要念这一句（合成开始），
 *   `end` 表示播完、合成失败或超时——三种结局都会报一次，气泡不必自己判超时。
 * @returns 取消订阅；卡片卸载或气泡关闭时必须调用。
 */
export function subscribeVoiceUtterance(listener: (event: VoiceUtteranceEvent) => void): () => void {
  utteranceListeners.add(listener);
  return () => {
    utteranceListeners.delete(listener);
  };
}

/** 广播一次播报事件；单个订阅者抛错不能挡住其余订阅者。 */
function emitUtterance(event: VoiceUtteranceEvent): void {
  for (const listener of utteranceListeners) listener(event);
}

/**
 * 换掉接口基址；桌面端在模块加载时调一次（`file://` 页面不能用相对路径）。
 * @param base - 已含前缀的地址，如 `dsh-pet-bridge://dsh-pet/dsh-pet-7340`。
 */
export function setVoiceBase(base: unknown): void {
  if (typeof base === 'string' && base) voiceBase = base;
}

/**
 * 声明本端是网页端还是桌面端；两端各自在启动时调一次。
 * 没声明时不按 `say` 叶子播放——宁可没声音，也不替另一端出声。
 * @param next - `web` / `desktop`；其余值忽略。
 */
export function setSurface(next: unknown): void {
  if (next === 'web' || next === 'desktop') surface = next;
}

/**
 * 记录成品配置里的音色、总开关与音量；网页端在读到 `/config` 时调一次。
 * 调用即视为配置已就绪，后续播放不再自己去拉。
 * @param name - 音色 id（非字符串按未指定处理）。
 * @param enabled - 播报总开关（严格 `=== true` 才算开启）。
 * @param volume - 音量系数（0–1）；缺省或非数值按最大音量播放。
 */
export function setVoiceConfig(name: unknown, enabled: unknown, volume?: unknown): void {
  voiceName = typeof name === 'string' ? name : '';
  voiceEnabled = enabled === true;
  voiceVolume = clampVolume(volume);
  configLoaded = true;
}

/** 把音量收敛到 0–1；非数值按最大音量（1）处理——脏配置不该把声音悄悄变成 0。 */
function clampVolume(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/** 懒加载成品配置；失败按「不播」处理，且只试一次（避免每句都发请求）。 */
async function loadConfigOnce(): Promise<void> {
  if (configLoaded) return;
  try {
    const response = await fetch(voiceBase + '/config', { cache: 'no-store' });
    const body = (await response.json()) as { main?: Record<string, unknown> } | null;
    const main = body?.main;
    voiceName = typeof main?.voiceName === 'string' ? main.voiceName : '';
    voiceEnabled = main?.voiceEnabled === true;
    voiceVolume = clampVolume(main?.voiceVolume);
    // 只有成功才置位：拉不到（bridge 还没就绪 / 瞬时故障）留给下一句重试——
    // 否则一次失败就把这一端永久静音了。
    configLoaded = true;
  } catch {
    /* 拉不到就保持关闭：宁可没声音，也不乱播 */
  }
}

/**
 * 按 `say` 叶子播放：叶子指定了本端、且总开关开着才念。
 *
 * 三个门依次是：叶子有没有点名本端 → 网页端页面是否可见 → 成品配置的总开关。
 * 任何一道没过都只把状态归回 `idle`，气泡照常显示，不打断渲染。
 *
 * @param say - 要念的那一句：`text` 正文，`voiceTo` 该由哪一端念。
 */
export function playSayVoice(say: { readonly text: string; readonly voiceTo?: VoiceTarget }): void {
  const isMine = say.voiceTo !== undefined && say.voiceTo === surface;
  if (!say.text || !isMine) {
    setVoiceState('idle');
    return;
  }
  if (surface === 'web' && typeof document !== 'undefined' && document.hidden) {
    setVoiceState('idle');
    return;
  }
  void speakIfEnabled(say.text); // 不 await：播放是旁路，不能挡住气泡与动画
}

/** 确认配置后再播；桌面端首次调用会顺手拉一次 `/config`。 */
async function speakIfEnabled(text: string): Promise<void> {
  await loadConfigOnce();
  if (!voiceEnabled) {
    setVoiceState('idle');
    return;
  }
  const seq = ++utteranceSeq;
  // 先报开始再置 loading：气泡要靠这条事件挂起收起计时，晚一步它就可能已经收了。
  emitUtterance({ kind: 'start', seq, text });
  setVoiceState('loading');
  try {
    await speak(text);
  } finally {
    // 成功、失败、超时都走这里：气泡在等这个收尾，漏一次就永远挂着。
    emitUtterance({ kind: 'end', seq, text });
  }
}

/**
 * 等到这一句真正播完。
 *
 * `play()` 的 Promise 在「开播」时就 resolve，而气泡要的是「播完」：两者的差就是气泡提前
 * 收起的全部原因。所以这里另等收尾信号，并用 {@link PLAYBACK_WAIT_MAX_MS} 兜底。
 *
 * @param audio - 正在播的元素。
 * @param objectUrl - 收尾时要释放的 blob 地址。
 */
function waitForPlaybackEnd(audio: HTMLAudioElement, objectUrl: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) return; // ended 与 pause 会先后到达，只收一次尾
      settled = true;
      if (timer !== null) clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      resolve();
    };
    timer = setTimeout(finish, PLAYBACK_WAIT_MAX_MS);
    timer.unref?.(); // 与宿主侧定时器同一策略：别把这个等待钉进事件循环
    audio.onended = finish;
    audio.onerror = finish;
    audio.onpause = finish; // 被下一句顶掉或用户暂停：同样算收尾，气泡不该再等一个不会响的音频
  });
}

/** 请求合成并播放；任何一步失败都落到 `failed`（气泡上留一个静音喇叭，而不是干脆没图标）。 */
async function speak(text: string): Promise<void> {
  try {
    const response = await fetch(voiceBase + '/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(voiceName ? { voice: voiceName } : {}) }),
      signal: speakSignal(),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('audio')) {
      setVoiceState('failed');
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    const audio = new Audio(objectUrl);
    audio.volume = voiceVolume;
    // 音频就绪即置 ready：喇叭表示「这句有语音」，不跟播放进度绑定
    setVoiceState('ready');
    try {
      await audio.play(); // 只代表开播：开播就失败要落到 failed，也不必再等收尾
    } catch {
      URL.revokeObjectURL(objectUrl);
      setVoiceState('failed');
      return;
    }
    // 气泡靠 end 事件收起，所以必须等播完：停在「已经开播」会让气泡提早 1.5 秒消失
    await waitForPlaybackEnd(audio, objectUrl);
  } catch {
    /* 含超时：气泡已经显示，失败也不能反过来打断渲染，只把图标换成静音喇叭 */
    setVoiceState('failed');
  }
}

/** 手动点播时正在响的那个音频；新的一句先掐掉旧的，避免两句话叠在一起。 */
let manualAudio: HTMLAudioElement | null = null;

/** 手动点播对外暴露的阶段；`idle` = 没在放（含被打断），`failed` = 合成没成功。 */
export type SpeakPhase = 'idle' | 'loading' | 'playing' | 'failed';

/** 手动点播的世代号：新的点播会作废旧请求的阶段回调，避免旧回调清掉新状态。 */
let manualSeq = 0;

/**
 * 手动播报一句（对话面板的喇叭按钮用）。
 *
 * 与自动播报有两点不同：不看待播标记（用户点的就是这一句），也不受总开关限制——
 * 开关管的是「自动念不念」，用户主动点播是明确意图。音色仍取配置值。
 *
 * @param text - 要念的正文。
 * @param onPhase - 阶段回调：请求合成时 `loading`、音频就绪开始播时 `playing`、播完 `idle`、失败或超时 `failed`。
 */
export function speakText(text: string, onPhase?: (phase: SpeakPhase) => void): void {
  if (!text) return;
  void playManual(text, onPhase);
}

/** 请求合成并播放手动点播；失败静默，不打断面板交互。 */
async function playManual(text: string, onPhase?: (phase: SpeakPhase) => void): Promise<void> {
  const token = ++manualSeq;
  await loadConfigOnce();
  if (manualAudio) {
    manualAudio.pause();
    manualAudio = null;
  }
  if (token !== manualSeq) return; // 等配置期间又被点了一次：这次直接让位
  onPhase?.('loading');
  try {
    const response = await fetch(voiceBase + '/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(voiceName ? { voice: voiceName } : {}) }),
      signal: speakSignal(),
    });
    if (token !== manualSeq) return;
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('audio')) {
      onPhase?.('failed');
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    if (token !== manualSeq) return;
    const audio = new Audio(objectUrl);
    audio.volume = voiceVolume;
    audio.onended = () => {
      URL.revokeObjectURL(objectUrl);
      if (manualAudio === audio) {
        manualAudio = null;
        onPhase?.('idle');
      }
    };
    audio.onerror = () => URL.revokeObjectURL(objectUrl);
    manualAudio = audio;
    onPhase?.('playing');
    await audio.play();
  } catch {
    /* 含超时：面板里还有文字，不弹错误打断阅读，只把按钮换成失败态 */
    if (token === manualSeq) onPhase?.('failed');
  }
}
