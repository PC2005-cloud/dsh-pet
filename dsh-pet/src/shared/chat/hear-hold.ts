/**
 * 「按住说话」的悬停快捷键：按住 `M` 开录，松手收尾。
 *
 * 管的是「按下到松开」这一段，不是一次按键。首次按下与其他悬停键同一条判据
 * （{@link isBareKey}：输入框、contenteditable 里打字不算），否则拼音里的 m 会被当成开录；
 * 进入按住状态后不再判焦点——开录时输入框已 blur，期间系统持续补发的 keydown 必须照单全收，
 * 漏一个就会往框里灌字符。
 * 只做判定与状态，不碰 DOM 与录音。
 * @module dsh-pet/src/shared/chat/hear-hold
 */
import { isBareKey } from '../hotkey.ts';
import type { HotkeyEvent } from '../hotkey.ts';

/** 目标键的小写形式：判定与状态机共用这一份，避免两处各写一个字面量。 */
const HEAR_KEY = 'm';

/** 快捷键的显示文案（设置页用）。与 {@link isHearHotkey} 的按键保持同一份事实。 */
export const HEAR_HOTKEY_HINT = 'M 键';

/**
 * 这次按下该不该被「按住说话」接走：与其他悬停键共用同一条判据。
 *
 * @param e - 键盘事件。
 * @returns 裸按 `M`（含大写）、且焦点不在可编辑元素上时为 true。
 */
export function isHearHotkey(e: HotkeyEvent): boolean {
  return isBareKey(e, HEAR_KEY);
}

/** 状态机的前置判据与两个动作。 */
export interface HearHoldHooks {
  /**
   * 现在该不该响应按下：鼠标停在这只宠物身上，或焦点在宠物自己的弹窗里。
   *
   * 后一条留的是「焦点在麦克风按钮这类非可编辑元素上」这条路；在输入框里打字由
   * {@link isHearHotkey} 挡在前面。
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
