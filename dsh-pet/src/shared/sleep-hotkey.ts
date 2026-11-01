/**
 * 睡觉的悬停快捷键：鼠标停在宠物上时按 `Z` 切换睡 / 醒。
 *
 * 按键规则归 shared/hotkey，本模块只绑定「哪个键 + 菜单文案」。
 * 语义是切换而不是单向睡觉：醒着按 = 睡下，睡着按 = 叫醒——与右键那一项完全同一件事。
 * 用 `Z` 而不是 `S`：`S` 让给了截图，一个裸键不能挂两件事。
 * @module dsh-pet/src/shared/sleep-hotkey
 */
import { isBareKey } from './hotkey.ts';
import type { HotkeyEvent } from './hotkey.ts';

/** 快捷键的显示文案（菜单项右侧灰字）。与 {@link isSleepHotkey} 的按键保持同一份事实。 */
export const SLEEP_HOTKEY_HINT = 'Z 键';

/**
 * 这次按键该不该切换睡觉状态。
 *
 * @param e - 键盘事件。
 * @returns 裸按 `Z`（含大写）时为 true，输入框里打字则为 false。
 */
export function isSleepHotkey(e: HotkeyEvent): boolean {
  return isBareKey(e, 'z');
}
