/**
 * 打开对话的隐式入口：拖拽落到宠物上、悬停时按 L。
 * 只在调用方生命周期内注册，卸载时全部摘除；不认为自己是 React 组件，也不碰状态。
 * 菜单项那条入口由调用方直接接线，不在这里。
 * @module dsh-pet/src/client/pet/card/open-chat
 */
import { isChatHotkey } from '../../../shared/chat/hotkey.ts';
import { claimFileDragEnter, claimFileDragOver, claimFileDrop } from '../../file-drop.ts';

/** 注册来源。 */
export interface OpenChatInput {
  /** 宠物舞台节点；拖拽只在它上面生效，其它区域的 drop 留给页面自己。 */
  readonly stage: HTMLElement | null;
  /** 调用方持有的悬停标记：为 true 时才响应快捷键。 */
  readonly isHovered: () => boolean;
  /** 打开对话；带图时直接进入待发送状态。 */
  readonly openChat: (image?: File) => void;
}

/**
 * 注册拖拽与快捷键。
 *
 * @param input - 舞台节点、悬停判定与打开动作。
 * @returns 解绑函数，交给调用方的 effect 清理。
 */
export function bindOpenChat(input: OpenChatInput): () => void {
  const { stage, isHovered, openChat } = input;
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isHovered() || !isChatHotkey(e)) return;
    e.preventDefault();
    openChat();
  };
  const onDragOver = (e: DragEvent): void => {
    if (!claimFileDragOver(e)) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent): void => {
    const file = claimFileDrop(e);
    if (file !== undefined) openChat(file);
  };
  document.addEventListener('keydown', onKeyDown, true);
  stage?.addEventListener('dragenter', claimFileDragEnter);
  stage?.addEventListener('dragover', onDragOver);
  stage?.addEventListener('drop', onDrop);
  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    stage?.removeEventListener('dragenter', claimFileDragEnter);
    stage?.removeEventListener('dragover', onDragOver);
    stage?.removeEventListener('drop', onDrop);
  };
}
