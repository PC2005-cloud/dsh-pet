/**
 * 悬停快捷键的判据：鼠标停在某只宠物上时，按 `L` 打开对话。
 * 按键规则归 shared/hotkey，本模块只绑定「哪个键 + 菜单文案」。
 * @module dsh-pet/src/shared/chat/hotkey
 */
import { isBareKey } from '../hotkey.ts';
import type { HotkeyEvent } from '../hotkey.ts';

export { isTypingTarget } from '../hotkey.ts';
export type { HotkeyEvent } from '../hotkey.ts';

/** 快捷键的显示文案（菜单项右侧灰字）。与 {@link isChatHotkey} 的按键保持同一份事实。 */
export const CHAT_HOTKEY_HINT = 'L 键';

/**
 * 这次按键该不该打开对话。
 *
 * @param e - 键盘事件。
 * @returns 裸按 `L`（含大写）时为 true，输入框里打字则为 false。
 */
export function isChatHotkey(e: HotkeyEvent): boolean {
  return isBareKey(e, 'l');
}
