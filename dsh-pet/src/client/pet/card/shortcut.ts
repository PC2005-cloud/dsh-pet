/**
 * 浮动对话的两条应用级快捷键：打开弹窗、开关录音。
 *
 * 都作用于「主配置第一只」宠物（见 card/registry），不看鼠标在哪——这正是「全局」的意思。
 * 录音只能做成开关：DSH 快捷键只派发 keydown，没有抬手事件，做不了按住说话。
 * @module dsh-pet/src/client/pet/card/shortcut
 */
import { keycapOf, registerAppShortcut, type ShortcutHost } from '../../app-shortcut.ts';
import { pickPetChatHandle, togglePetChatHear } from './registry.ts';

/** 打开浮动对话弹窗的命令 id。 */
export const PET_FLOAT_COMMAND_ID = 'pet-chat.float';
/** 开关录音的命令 id。 */
export const PET_HEAR_COMMAND_ID = 'pet-chat.hear';

/** 弹窗键位：主修饰键 + Shift + L。T 在浏览器里被「恢复标签页」占用，L 两端都空着。 */
const FLOAT_BINDING = { code: 'KeyL', modifiers: ['primary', 'shift'] } as const;
/** 录音键位：主修饰键 + Shift + M（M = mic）。V 在输入框里会被浏览器当成「粘贴为纯文本」，避开。 */
const HEAR_BINDING = { code: 'KeyM', modifiers: ['primary', 'shift'] } as const;

/** 设置页与菜单里显示的键帽；与 {@link FLOAT_BINDING} 同源，改键自动跟着变。 */
export const PET_FLOAT_SHORTCUT_HINT = keycapOf(FLOAT_BINDING);
/** 录音键的键帽；同上。 */
export const PET_HEAR_SHORTCUT_HINT = keycapOf(HEAR_BINDING);

/** 取标题的键；调用方传 `t` 的薄封装即可。 */
export type ShortcutLabel = (key: 'shortcut.chat' | 'shortcut.hear') => string;

/**
 * 注册浮动对话的两条快捷键。
 *
 * @param ctx - 客户端上下文（只用到软取）。
 * @param label - 取标题；惰性求值，切语言后重算。
 * @returns 注销函数：两条一起摘。
 */
export function registerPetCardShortcuts(ctx: ShortcutHost, label: ShortcutLabel): { dispose: () => void } {
  const float = registerAppShortcut(ctx, {
    id: PET_FLOAT_COMMAND_ID,
    label: () => label('shortcut.chat'),
    binding: FLOAT_BINDING,
    run: () => pickPetChatHandle()?.open(),
  });
  const hear = registerAppShortcut(ctx, {
    id: PET_HEAR_COMMAND_ID,
    label: () => label('shortcut.hear'),
    binding: HEAR_BINDING,
    run: () => togglePetChatHear(pickPetChatHandle()),
  });
  return {
    dispose: () => {
      float.dispose();
      hear.dispose();
    },
  };
}
