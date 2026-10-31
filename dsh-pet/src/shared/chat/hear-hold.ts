/**
 * 「按住说话」的悬停快捷键：按住 `M` 开录，松手收尾。
 *
 * 管的是「按下到松开」这一段，不是一次按键。按住期间系统持续补发重复的 keydown，
 * 而弹窗一开焦点就进了输入框，不拦就会灌一串 m，所以这里**不看焦点**：
 * 闸门只有 isArmed（鼠标在宠物上，或光标在宠物自己的弹窗里），开录时由调用方 blur 输入框。
 * 只做判定与状态，不碰 DOM 与录音。
 * @module dsh-pet/src/shared/chat/hear-hold
 */
import type { HotkeyEvent } from '../hotkey.ts';

/** 目标键的小写形式：判定与状态机共用这一份，避免两处各写一个字面量。 */
const HEAR_KEY = 'm';

/** 快捷键的显示文案（设置页用）。与 {@link isHearHotkey} 的按键保持同一份事实。 */
export const HEAR_HOTKEY_HINT = 'M 键';

/**
 * 这次按下该不该被「按住说话」接走。
 *
 * 只认键名与修饰键，不看焦点——弹窗一打开焦点就在输入框里，那时恰恰是最想按住说话的时候。
 *
 * @param e - 键盘事件。
 * @returns 裸按 `V`（含大写）时为 true，带 Ctrl/Meta/Alt 时为 false。
 */
export function isHearHotkey(e: HotkeyEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return String(e.key).toLowerCase() === HEAR_KEY;
}

/** 状态机的前置判据与两个动作。 */
export interface HearHoldHooks {
  /**
   * 现在该不该响应按下。
   *
   * 两个来源：鼠标停在这只宠物身上，或光标还在宠物自己的对话弹窗里——
   * 后者是「弹窗开着、焦点在输入框」的那条路，正是按住说话的主场景。
   */
  isArmed: () => boolean;
  /** 按下：打开对话弹窗并开始录音。 */
  onPress: () => void;
  /** 松开：结束录音，等识别结果。 */
  onRelease: () => void;
}

/** 按住状态机：两端各持一个，键盘事件原样转进来。 */
export interface HearHold {
  /** 处理 keydown；返回 true 表示这次事件已被吃掉，调用方必须 `preventDefault`。 */
  onKeyDown: (e: HotkeyEvent & { readonly repeat?: boolean }) => boolean;
  /** 处理 keyup；只认开录那个键的松开，其余不管。 */
  onKeyUp: (e: Pick<HotkeyEvent, 'key'>) => void;
  /** 强制收尾（窗口失焦、宠物卸载这类收不到 keyup 的场合）；没按着时什么都不做。 */
  release: () => void;
}

/**
 * 造一个按住状态机。
 *
 * @param hooks - 前置判据与按下/松开动作。
 * @returns 供调用方接线的三个处理器。
 */
export function createHearHold(hooks: HearHoldHooks): HearHold {
  let holding = false;
  /** 只比键名：按住期间焦点已交给输入框，不能再套「不在可编辑元素里」那道判据。 */
  const sameKey = (key: string): boolean => String(key).toLowerCase() === HEAR_KEY;

  const release = (): void => {
    if (!holding) return;
    holding = false;
    hooks.onRelease();
  };

  return {
    onKeyDown(e) {
      // 按住中：同一个键的事件（主要是自动重复）全部吃掉，一个漏网的就会打进输入框
      if (holding) return sameKey(e.key);
      if (e.repeat === true || !isHearHotkey(e) || !hooks.isArmed()) return false;
      holding = true;
      hooks.onPress();
      return true;
    },
    onKeyUp(e) {
      if (sameKey(e.key)) release();
    },
    release,
  };
}
