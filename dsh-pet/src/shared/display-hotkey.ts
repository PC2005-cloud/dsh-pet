/**
 * 显示位置的数字键：`1` 仅网页、`2` 仅桌面、`3` 两者、`4` 都不。
 *
 * 顺序与右键「显示位置」子菜单同源（见 {@link displayMenuBranch}），菜单键帽也由这里出。
 * 每个键作用于鼠标停着的那只宠物；`3`/`4` 会让它从网页端消失，因此这两个键是单向门。
 * @module dsh-pet/src/shared/display-hotkey
 */
import { isBareKey } from './hotkey.ts';
import type { HotkeyEvent } from './hotkey.ts';
import type { PetDisplay } from './types.ts';

/** 数字键对应的显示位置，下标从 1 起；改顺序等于改快捷键，必须同步菜单。 */
export const DISPLAY_ORDER = ['web', 'desktop', 'both', 'none'] as const satisfies readonly PetDisplay[];

/** 菜单项右侧的键帽文案；下标与 {@link DISPLAY_ORDER} 对齐。 */
export const DISPLAY_HOTKEY_HINTS: readonly string[] = DISPLAY_ORDER.map((_, index) => String(index + 1) + ' 键');

/**
 * 这次按键该切到哪个显示位置。
 *
 * @param e - 键盘事件。
 * @returns `1`-`4` 对应的显示位置；不是这四个裸键（或在输入框里打字）时 undefined。
 */
export function displayOfHotkey(e: HotkeyEvent): PetDisplay | undefined {
  for (let index = 0; index < DISPLAY_ORDER.length; index += 1) {
    if (isBareKey(e, String(index + 1))) return DISPLAY_ORDER[index];
  }
  return undefined;
}
