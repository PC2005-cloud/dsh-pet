/**
 * 动作音效：某段动画开始出画时，按条目的 actionSounds（动画名 → 音效文件名）播一声。
 *
 * 浏览器端与桌面 Helper 共用这一份（桌面经 shared-core.js 取 window.PetShared.playActionSound），
 * 两端只在「新动画翻到前台」那一刻调用，本模块不关心动画链。
 * 总开关由成品配置 main.actionSoundsEnabled 驱动，两端读完配置各调一次 setActionSoundsEnabled；
 * 配置没加载前保守静音。
 * 模块级缓存按音效地址复用 audio 元素，同一文件 100ms 内只响一次：同一页面里多只宠物同播同一动作不叠音
 * （桌面端一只宠物一个窗口，各窗口的节流互不相通）；播放失败一律静默（没有声音也不该有报错）。
 * @module dsh-pet/src/shared/action-sound
 */

/** 音量：与点击音效同一档，不抢对话与语音。 */
const ACTION_SOUND_VOLUME = 0.5;
/** 同一文件的节流窗口：多只宠物同一帧播同一动作时只响一次。 */
const ACTION_SOUND_THROTTLE_MS = 100;
/** audio 元素缓存上限：超出时淘汰最早的一个，防止配置反复热改后无限增长。 */
const ACTION_SOUND_CACHE_MAX = 32;

/** 地址 → 复用的 audio 元素（Map 保持插入序，首个即最早）。 */
const audioByUrl = new Map<string, HTMLAudioElement>();
/** 地址 → 上一次真正播放的时间戳（ms）。 */
const lastPlayedAtByUrl = new Map<string, number>();
/** 动作音效总开关；配置未加载前保守静音。 */
let actionSoundsEnabled = false;

/**
 * 打开或关闭动作音效。
 *
 * @param enabled - 成品配置里 main 条目的 `actionSoundsEnabled`。
 */
export function setActionSoundsEnabled(enabled: boolean): void {
  actionSoundsEnabled = enabled;
}

/**
 * 播放某段动画配的音效；总开关关闭、没配、节流中或音频不可用时静默返回。
 *
 * @param base - 素材通道前缀：网页端是 ROUTE_PATH，桌面端是 BASE（bridge 或 HTTP）。
 * @param sounds - 所属条目的 actionSounds；缺省即该条目没有动作音效。
 * @param anim - 刚翻到前台的动画名。
 */
export function playActionSound(
  base: string,
  sounds: Readonly<Record<string, string>> | undefined,
  anim: string,
): void {
  if (!actionSoundsEnabled || sounds === undefined) return;
  // 只认自有字符串键：动画名恰好是 constructor / toString 这类时不能沿原型链取到函数。
  const file = Object.prototype.hasOwnProperty.call(sounds, anim) ? sounds[anim] : undefined;
  if (typeof file !== 'string' || file === '') return;
  const url = base + '/sound/' + encodeURIComponent(file);
  const now = Date.now();
  if (now - (lastPlayedAtByUrl.get(url) ?? -Infinity) < ACTION_SOUND_THROTTLE_MS) return;
  lastPlayedAtByUrl.set(url, now);
  try {
    const audio = audioByUrl.get(url) ?? cacheAudio(url);
    audio.volume = ACTION_SOUND_VOLUME;
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  } catch {
    /* 音频不可用，静默忽略。 */
  }
}

/** 新建并缓存一个 audio 元素；满额时先淘汰最早的。 */
function cacheAudio(url: string): HTMLAudioElement {
  const audio = new Audio(url);
  if (audioByUrl.size >= ACTION_SOUND_CACHE_MAX) {
    const oldest = audioByUrl.keys().next().value;
    if (oldest !== undefined) {
      audioByUrl.delete(oldest);
      lastPlayedAtByUrl.delete(oldest);
    }
  }
  audioByUrl.set(url, audio);
  return audio;
}

/**
 * 清空缓存与节流记录，总开关回到静音。
 * @internal 只给测试重置模块单例，不对外承诺。
 */
export function resetActionSoundsForTest(): void {
  audioByUrl.clear();
  lastPlayedAtByUrl.clear();
  actionSoundsEnabled = false;
}
