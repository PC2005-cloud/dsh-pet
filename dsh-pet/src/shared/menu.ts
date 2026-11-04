/**
 * 右键菜单的公开出口：树构建、样式与 DOM 挂载。
 *
 * 只做再导出；判据在 ./menu/tree，挂载在 ./menu/mount。
 * 必须始终成立：数据与判据是纯函数，浏览器与桌面两端共用同一份。
 * @module dsh-pet/src/shared/menu
 */
export type { ContextMenuMount, MenuBranch, MenuLeaf, MenuMoreItem, MenuNode, MenuPlacement } from './menu/types.ts';
export type { MemeGroups, MemeGroupSource } from './menu/memes.ts';
export {
  MORE_MENU_LABEL,
  buildMenuTree,
  buildMoreBranch,
  buildTopLevelItems,
  displayMenuBranch,
  isNoMirrorAnimation,
  isSleepAllowedAction,
  readMenuItems,
} from './menu/tree.ts';
export { buildMemeBranch, groupMemes, memeThumbUrl } from './menu/memes.ts';
export { MENU_CSS } from './menu/css.ts';
export { mountContextMenu } from './menu/mount.ts';
