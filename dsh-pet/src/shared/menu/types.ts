/**
 * 菜单节点类型：叶子、分支与挂载句柄。
 *
 * 纯类型声明，不含实现。
 * 必须始终成立：叶子带 action 或 anim（至少其一），分支必须带 children，二者不可兼得。
 * @module dsh-pet/src/shared/menu/types
 */
import { type PetDisplay } from '../types.ts';

/** 叶子：可点击的菜单项。 */
export interface MenuLeaf {
  label: string;
  /** 播放的动画名（点播动作）；action 优先于 anim */
  anim?: string;
  /** 自定义动作：打开网站 / 查看余额 / 立即碎碎念 / 打开对话弹窗 / 打开待办面板 / 回到初始位置 /
   *  重载配置（桌面端专属，重启桌面 Helper 并按最新配置重建窗口）/ 改显示位置（目标值见 display，
   *  两端都注入）/ 第三方菜单项（只把 owner 与 label 上报给注册方，具体做什么由它决定）。
   *  手动触发均不受 whisperEnabled 影响——那个字段只关自动轮询。 */
  action?:
    'open-site' | 'show-balance' | 'whisper' | 'chat' | 'todo' | 'home' | 'reload' | 'set-display' | 'third-party';
  /** set-display 的目标显示位置（与设置页的下拉框同一套取值） */
  display?: PetDisplay;
  /** third-party：注册它的 owner（身份键，只用于回传，不显示）；同一个 owner 的项收在同一分组下，
   *  只有一项时跳过这层直接平铺。 */
  owner?: string;
  /** 项目右侧的灰色小字（如快捷键）：纯视觉提示，不参与文本匹配也不影响动作分发，缺省不占位。 */
  hint?: string;
}

/** 分支：带子菜单的项。 */
export interface MenuBranch {
  label: string;
  children: MenuNode[];
}

export type MenuNode = MenuLeaf | MenuBranch;

/** 第三方菜单项（宿主经 /state 的 sections.menu 下发的快照，一条 = 一个可点项）。 */
export interface MenuMoreItem {
  /** 注册方身份；同时也是一级分组名（显示用） */
  owner: string;
  /** 项名（显示用，也是回传给注册方的标识） */
  label: string;
}

/** 右键菜单挂载句柄。 */
export interface ContextMenuMount {
  /** 已挂载的根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}
