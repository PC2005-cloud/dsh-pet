/**
 * 宠物 UI 字典的注册出口（命名空间 `pet.ui`）。
 *
 * 真源在 src/shared/ui/locales：共享模块（菜单、气泡、待办、通知）也要取词，
 * 而 src/shared 不能反向依赖 src/client，所以这里只做一层薄转发。
 * @module dsh-pet/src/client/ui/locales
 */
export { NS, dicts, zh } from '../../../shared/ui/locales/index.ts';
export type { Key } from '../../../shared/ui/locales/index.ts';
