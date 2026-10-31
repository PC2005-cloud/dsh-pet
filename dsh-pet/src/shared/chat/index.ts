/**
 * 对话弹窗的对外出口：挂载、发送、样式与两个类型。
 * 拆成 styles / icons / send / image-pick / dom / dialog / hear-hold 后，本文件只做再导出，
 * 让 `shared/index.ts`（打包成 window.PetShared）与浏览器入口各取所需。
 * @module dsh-pet/src/shared/chat
 */
export type { ChatDialogMount, ChatDialogOptions } from './dialog.ts';
export { mountChatDialog } from './dialog.ts';
export type { HearHold, HearHoldHooks } from './hear-hold.ts';
export { createHearHold, isHearHotkey } from './hear-hold.ts';
export { dragHasFiles, firstImageFile, isImageFile } from './image-pick.ts';
export { CHAT_HOTKEY_HINT, isChatHotkey, isTypingTarget } from './hotkey.ts';
export type { ChatSendState, ChatAttachment } from './send.ts';
export { sendChat } from './send.ts';
export { CHAT_CSS } from './styles.ts';
