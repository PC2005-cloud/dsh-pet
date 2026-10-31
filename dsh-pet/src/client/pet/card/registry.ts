/**
 * 浮动对话的全局入口表：每张宠物卡挂载时登记，卸载时摘掉。
 *
 * 快捷键是全局的一个，而对话弹窗是每只宠物各一份，两者之间需要一张「现在能对谁动手」的表。
 * 取目标时优先主条目（配置里 main.pets[0]），它不在网页端就退到第一个登记过的。
 * 只存句柄、不存状态机：录音状态仍在 chat/hear-control 里。
 * @module dsh-pet/src/client/pet/card/registry
 */
import { petBridge } from '../../settings/bridge.ts';

/** 一张卡对外能做的四件事。 */
export interface PetChatHandle {
  /** 打开（或聚焦）这只宠物的浮动对话弹窗。 */
  readonly open: () => void;
  /** 开录；没有弹窗时先开一个。 */
  readonly startHear: () => void;
  /** 收尾。 */
  readonly stopHear: () => void;
  /** 此刻是否在采集。 */
  readonly isHearing: () => boolean;
}

/** 按宠物 id 登记；Map 的插入序就是渲染序，「第一只」的兜底直接靠它。 */
const handles = new Map<string, PetChatHandle>();

/**
 * 登记一只宠物的浮动对话入口。
 *
 * @param id - 宠物 id（配置里的键）。
 * @param handle - 四个动作。
 * @returns 注销函数；卡片卸载时必须调用，且只摘自己那一次。
 */
export function registerPetChatHandle(id: string, handle: PetChatHandle): () => void {
  handles.set(id, handle);
  return () => {
    if (handles.get(id) === handle) handles.delete(id);
  };
}

/**
 * 取快捷键要操作的那一只：主配置第一只，其次第一个登记过的。
 *
 * @returns 对话句柄；网页端一只宠物都没有时 undefined。
 */
export function pickPetChatHandle(): PetChatHandle | undefined {
  const mainId = petBridge.template?.id;
  if (typeof mainId === 'string') {
    const main = handles.get(mainId);
    if (main !== undefined) return main;
  }
  return handles.values().next().value;
}

/**
 * 开关录音：已经在采就收尾，否则开录。
 *
 * 快捷键只收到 keydown（没有抬手事件），所以「按住说话」在这里只能是开关。
 *
 * @param handle - 目标宠物；undefined 时什么都不做。
 */
export function togglePetChatHear(handle: PetChatHandle | undefined): void {
  if (handle === undefined) return;
  if (handle.isHearing()) handle.stopHear();
  else handle.startHear();
}
