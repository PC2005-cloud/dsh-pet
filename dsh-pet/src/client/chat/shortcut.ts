/**
 * 「打开右侧栏桌宠对话」的快捷键。
 *
 * 注册后自动出现在 设置 → 通用 → 快捷键（可改绑、有冲突提示），
 * 侧栏 guide 卡片通过 `commandId` 显示键帽。服务缺失（旧宿主）只告警，不影响面板本身。
 * @module dsh-pet/src/client/chat/shortcut
 */
import { keycapOf, registerAppShortcut, type ShortcutHost } from '../app-shortcut.ts';

/** 命令 id：guide 卡片的 `commandId` 与注册都用它。 */
export const PET_CHAT_COMMAND_ID = 'pet-chat.open';

/** 主修饰键 + Shift + P；Web 白名单允许「主键 + Shift/Alt + 字母」，所以两端同一个键。 */
const BINDING = { code: 'KeyP', modifiers: ['primary', 'shift'] } as const;

/** 设置页里显示的键帽；与 {@link BINDING} 同源。 */
export const PET_CHAT_SHORTCUT_HINT = keycapOf(BINDING);

/**
 * 注册「打开桌宠对话」。
 *
 * @param ctx - 客户端上下文（只用到软取）。
 * @param label - 设置页里显示的标题；惰性求值，切语言后重算。
 * @param open - 触发时执行的动作（打开对话标签）。
 * @returns `registered` 表示命令是否真的登记成功；`dispose` 用于注销（失败时是空函数）。
 *   失败时调用方不能再把 `commandId` 交给侧栏——指向不存在的命令会让侧栏注册抛错。
 */
export function registerPetChatShortcut(
  ctx: ShortcutHost,
  label: () => string,
  open: () => void,
): { registered: boolean; dispose: () => void } {
  return registerAppShortcut(ctx, { id: PET_CHAT_COMMAND_ID, label, binding: BINDING, run: open });
}
