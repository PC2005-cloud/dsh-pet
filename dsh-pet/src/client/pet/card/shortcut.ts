/**
 * 浮动对话的三条应用级快捷键：开关弹窗、开关录音、截图。
 *
 * 都作用于「主配置第一只」宠物（见 card/registry），不看鼠标在哪——这正是「全局」的意思。
 * 弹窗那条是开关：同一个键再按一次必须关掉，不能只是把焦点塞回输入框。
 * 录音只能做成开关：DSH 快捷键只派发 keydown，没有抬手事件，做不了按住说话。
 * @module dsh-pet/src/client/pet/card/shortcut
 */
import {
  keycapOf,
  readShortcutKeycap,
  registerAppShortcut,
  type ShortcutBinding,
  type ShortcutHost,
} from '../../app-shortcut.ts';
import { pickPetChatHandle, togglePetChat, togglePetChatHear } from './registry.ts';

/** 打开浮动对话弹窗的命令 id。 */
export const PET_FLOAT_COMMAND_ID = 'pet-chat.float';
/** 开关录音的命令 id。 */
export const PET_HEAR_COMMAND_ID = 'pet-chat.hear';
/** 截图并塞进对话的命令 id。 */
export const PET_CAPTURE_COMMAND_ID = 'pet-chat.capture';

/** 弹窗键位：主修饰键 + Shift + L。T 在浏览器里被「恢复标签页」占用，L 两端都空着。 */
const FLOAT_BINDING = { code: 'KeyL', modifiers: ['primary', 'shift'] } as const;
/** 录音键位：主修饰键 + Shift + M（M = mic）。V 在输入框里会被浏览器当成「粘贴为纯文本」，避开。 */
const HEAR_BINDING = { code: 'KeyM', modifiers: ['primary', 'shift'] } as const;
/** 截图键位：主修饰键 + Shift + S。Edge 与 Firefox 把它给了自己的截图，Chrome 空着。 */
const CAPTURE_BINDING = { code: 'KeyS', modifiers: ['primary', 'shift'] } as const;

/** 设置页要列出的三条命令。 */
export type PetShortcutKey = 'chat' | 'hear' | 'capture';

/** 命令 id 与默认键位：注册与展示都从这里取，不写第二份。 */
const COMMANDS: Readonly<Record<PetShortcutKey, { readonly id: string; readonly binding: ShortcutBinding }>> = {
  chat: { id: PET_FLOAT_COMMAND_ID, binding: FLOAT_BINDING },
  hear: { id: PET_HEAR_COMMAND_ID, binding: HEAR_BINDING },
  capture: { id: PET_CAPTURE_COMMAND_ID, binding: CAPTURE_BINDING },
};

/**
 * 设置页显示的键帽：跟着用户改绑走。
 *
 * @param ctx - 客户端上下文。
 * @param key - 要显示哪一条。
 * @returns 键帽文案；还没登记、或宿主没有快捷键服务时退回默认组合。
 */
export function petShortcutKeycap(ctx: ShortcutHost, key: PetShortcutKey): string {
  const command = COMMANDS[key];
  return readShortcutKeycap(ctx, command.id) ?? keycapOf(command.binding);
}

/** 取标题的键；调用方传 `t` 的薄封装即可。 */
export type ShortcutLabel = (key: 'shortcut.capture' | 'shortcut.chat' | 'shortcut.hear') => string;

/**
 * 注册浮动对话的两条快捷键。
 *
 * @param ctx - 客户端上下文（只用到软取）。
 * @param label - 取标题；惰性求值，切语言后重算。
 * @returns 注销函数：两条一起摘。
 */
export function registerPetCardShortcuts(ctx: ShortcutHost, label: ShortcutLabel): { dispose: () => void } {
  const float = registerAppShortcut(ctx, {
    id: COMMANDS.chat.id,
    label: () => label('shortcut.chat'),
    binding: COMMANDS.chat.binding,
    run: () => togglePetChat(pickPetChatHandle()),
  });
  const hear = registerAppShortcut(ctx, {
    id: COMMANDS.hear.id,
    label: () => label('shortcut.hear'),
    binding: COMMANDS.hear.binding,
    run: () => togglePetChatHear(pickPetChatHandle()),
  });
  const capture = registerAppShortcut(ctx, {
    id: COMMANDS.capture.id,
    label: () => label('shortcut.capture'),
    binding: COMMANDS.capture.binding,
    run: () => pickPetChatHandle()?.screenshot(),
  });
  return {
    dispose: () => {
      float.dispose();
      hear.dispose();
      capture.dispose();
    },
  };
}
