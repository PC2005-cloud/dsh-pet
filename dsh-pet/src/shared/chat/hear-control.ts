/**
 * 「按住说话」的控件：话筒按钮的四种状态、录音、识别结果落点。
 *
 * 单独成模块是因为它有独立的失败模式与生命周期：麦克风被拒、采到静音、宿主没开识别、
 * 网络失败各不相同，且带着一个四态状态机与两个定时器——和「上传图片、截屏」没有共同变化原因。
 * 不建 DOM、不管弹窗开合、不发送；元素与提示行由调用方（chat/dom）交进来。
 * @module dsh-pet/src/shared/chat/hear-control
 */
import {
  MAX_RECORD_MS,
  MIN_RECORD_MS,
  SILENCE_PEAK,
  canRecord,
  hearAudio,
  startRecording,
  toBase64,
  type HearOutcome,
  type HearRecorder,
} from '../hear.ts';

/** 录音阶段的四态：`starting` 是等麦克风授权的那一小段，`transcribing` 是等识别结果。 */
type HearState = 'idle' | 'starting' | 'recording' | 'transcribing';

/** 提示行的三种用法：常驻显示、收起、显示后自动收起。 */
export interface HearHint {
  /** 常驻显示，直到 hide。 */
  show: (text: string) => void;
  hide: () => void;
  /** 显示并在一小段时间后自动收起。 */
  flash: (text: string) => void;
}

/** 控件需要的元素与回调。 */
export interface HearControlOptions {
  /** 话筒按钮：状态画在它的 `data-hear` 上，pointer 事件也由本模块绑定。 */
  readonly micBtn: HTMLButtonElement;
  /** 识别结果的落点：文字插在光标处。 */
  readonly input: HTMLTextAreaElement;
  /** 进度与失败提示都走这一行。 */
  readonly hint: HearHint;
  /** 插入文字后重算输入框尺寸。 */
  readonly resizeInput: () => void;
  /** 识别地址；空串表示这个入口没接识别。 */
  readonly hearUrl: string;
}

/** 控件对外只暴露四个动作。 */
export interface HearControl {
  /** 开录；录不了时给一句原因，已在录时什么都不做。 */
  start: () => void;
  /** 收尾；没在录时什么都不做。 */
  stop: () => void;
  /** 此刻是否真的在采集：快捷键要按它决定这一下是开还是关。 */
  isHearing: () => boolean;
  /** 停掉正在进行的录音并清计时器；关闭弹窗时调用。 */
  dispose: () => void;
}

/**
 * 造一个按住说话控件。
 *
 * @param opts - 话筒按钮、输入框、提示行、尺寸重算与识别地址。
 * @returns 开始、收尾与释放三个动作。
 */
export function createHearControl(opts: HearControlOptions): HearControl {
  const { micBtn, input, hint, resizeInput, hearUrl } = opts;
  let hearState: HearState = 'idle';
  let recorder: HearRecorder | null = null;
  let hearTimer = 0;
  /** 还没拿到麦克风就松手了：等 startRecording 一返回立刻收尾，避免麦克风一直开着。 */
  let wasReleasedEarly = false;

  /** 按钮外观：录音阶段画红，识别阶段禁用（避免连点开两次）。 */
  const paint = (): void => {
    if (hearState === 'starting' || hearState === 'recording') micBtn.dataset.hear = 'recording';
    else delete micBtn.dataset.hear;
    micBtn.disabled = hearState === 'transcribing';
  };

  /** 现在录不了的原因；能录时给空串。 */
  const blockedReason = (): string => {
    if (!canRecord()) return '当前地址不支持录音：用 https 或 localhost 打开才有麦克风';
    if (hearUrl === '') return '这个入口没有接上识别地址';
    return '';
  };

  /** 把识别结果接在光标处（替换当前选区），并把焦点交回输入框。 */
  const insertText = (text: string): void => {
    const from = input.selectionStart ?? input.value.length;
    const to = input.selectionEnd ?? from;
    input.value = input.value.slice(0, from) + text + input.value.slice(to);
    const caret = from + text.length;
    input.setSelectionRange(caret, caret);
    resizeInput();
    // 桌面端靠 focusin 向主进程补一次系统键盘焦点（X11 上 DOM 焦点不等于键盘焦点）
    input.focus();
  };

  /** 失败原因翻成人话；宿主给的 message 有就附上，方便对着日志排查。 */
  const describeFailure = (outcome: Extract<HearOutcome, { ok: false }>): string => {
    if (outcome.reason === 'unsupported') return '这个宿主没开语音识别';
    if (outcome.reason === 'bad-request') return '音频没通过宿主校验';
    if (outcome.reason === 'network') return '识别请求失败：' + outcome.message;
    return '识别失败：' + (outcome.message || '未知原因');
  };

  /** 收尾：停采集 → 判误触 → 判静音 → 送宿主 → 文字落进输入框。失败只提示，不动已输入的文字。 */
  const stop = async (): Promise<void> => {
    const current = recorder;
    if (!current) return;
    recorder = null;
    window.clearInterval(hearTimer);
    // 误触（按一下就松）：静默丢弃。弹窗留着、提示不留——录到几十毫秒跟麦克风好坏无关，
    // 报「没听到声音」只会把人引到错误的方向。
    if (current.elapsedMs() < MIN_RECORD_MS) {
      current.cancel();
      hearState = 'idle';
      paint();
      hint.hide();
      return;
    }
    hearState = 'transcribing';
    paint();
    hint.show('识别中…');
    try {
      const clip = await current.stop();
      if (clip === null) {
        hint.flash('没录到声音');
        return;
      }
      if (clip.peak < SILENCE_PEAK) {
        // 麦克风开着却没信号（设备静音 / 耳机没戴上）：不白送一次识别
        hint.flash('没听到声音，检查一下麦克风');
        return;
      }
      if (!input.isConnected) return; // 等结果的这会儿弹窗被关了
      const outcome = await hearAudio(hearUrl, toBase64(clip.wave));
      if (!input.isConnected) return;
      if (!outcome.ok) {
        hint.flash(describeFailure(outcome));
        return;
      }
      const text = outcome.text.trim();
      if (text === '') {
        hint.flash('没听清，再说一次');
        return;
      }
      hint.hide();
      insertText(text);
    } catch (e) {
      hint.flash('录音出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      hearState = 'idle';
      paint();
    }
  };

  /** 开录：先要麦克风，拿到了才开始计时。 */
  const start = async (): Promise<void> => {
    const blocked = blockedReason();
    if (blocked !== '') {
      hint.flash(blocked);
      return;
    }
    if (hearState !== 'idle') return;
    // 焦点交还出去：按住说话不看焦点，可输入框一旦吃着键盘，落进来的 v 就会变成字符。
    // 识别完由 insertText 重新聚焦，回车发送照旧。
    if (document.activeElement === input) input.blur();
    hearState = 'starting';
    wasReleasedEarly = false;
    paint();
    hint.show('正在打开麦克风…');
    try {
      recorder = await startRecording();
    } catch (e) {
      hearState = 'idle';
      paint();
      hint.flash('打不开麦克风：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (wasReleasedEarly) {
      void stop();
      return;
    }
    hearState = 'recording';
    paint();
    hearTimer = window.setInterval(() => {
      const rec = recorder;
      if (!rec) return;
      if (rec.elapsedMs() >= MAX_RECORD_MS) {
        void stop(); // 上限到了自动收尾，不必等松手
        return;
      }
      const total = Math.floor(rec.elapsedMs() / 1000);
      hint.show('录音中 ' + Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0') + ' · 松开结束');
    }, 200);
  };

  micBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 别把焦点从输入框抢走，也别触发选区
    try {
      // 捕获指针：松手时鼠标可能已经移出按钮甚至移出窗口，靠它才收得到 pointerup
      micBtn.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已经不在了（窗口失焦/合成事件）：收不到松手就等 24 秒上限兜底 */
    }
    void start();
  });
  /** 松手或指针被系统抢走（切窗口）都算说完；还在等麦克风时先记下，等它回来立刻收尾。 */
  const onRelease = (): void => {
    if (hearState === 'starting') {
      wasReleasedEarly = true;
      return;
    }
    if (hearState === 'recording') void stop();
  };
  micBtn.addEventListener('pointerup', onRelease);
  micBtn.addEventListener('pointercancel', onRelease);

  return {
    start: () => void start(),
    stop: () => void stop(),
    isHearing: () => hearState === 'recording',
    dispose: () => {
      window.clearInterval(hearTimer);
      // 关弹窗时麦克风必须立刻松手：录音中直接丢弃，不等识别
      if (recorder) {
        recorder.cancel();
        recorder = null;
      }
      hearState = 'idle';
    },
  };
}
