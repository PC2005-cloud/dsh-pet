/**
 * 把「桌宠对话」注册成 DSH 右侧栏的一种标签页。
 *
 * 右侧栏在 DSH 里是可选能力：缺 `sidebarRightTabs` 服务时只告警、不注册，
 * 宠物 overlay 与设置页照常工作——一个可选面板失败不该让整个插件加载失败。
 * @module dsh-pet/src/client/chat/register
 */
import { LOGO_URL } from './api.ts';
import { makePetChatPanel, type ChatPanelRuntime } from './panel.ts';
import { injectPanelCss } from './styles.ts';
import { disposeTip } from './tooltip.ts';

/** 标签实现身份；同时也是正文与标题插槽的 key。 */
const TAB_ID = 'dsh-pet-chat';
/** 标签类型；`openTab` 按它打开。 */
const TAB_KIND = 'pet-chat';
/** 标签头与指南页卡片的文案。 */
const TAB_TITLE = '桌宠对话';

/** 右侧栏标签注册表的最小形状（按用到的成员声明，不引整包类型）。 */
interface SidebarTabRegistry {
  register(definition: {
    readonly id: string;
    readonly kind: string;
    readonly priority: 'extension';
    readonly title: () => string;
    readonly guide: readonly {
      id: string;
      order: number;
      title: () => string;
      description?: () => string;
      /** 指南页卡片左侧的图标组件；不给时框架画一个立方体占位。 */
      icon?: () => unknown;
      /** 该入口对应的快捷键命令 id：给了就在卡片右侧显示键帽。 */
      commandId?: string;
    }[];
  }): () => void;
}

/** 注册对话标签需要的最小上下文。 */
export interface PetChatTabHost {
  /** Cordis 的软取服务：拿不到返回 undefined。 */
  get?(name: string): unknown;
  /** 插槽注册表。 */
  slots: {
    /** 等到某个插槽被声明后再执行注册（与 shell.overlay 同一套等待方式）。 */
    inject(name: string, generator: () => Generator<unknown, void, unknown>): void;
    /**
     * 注册一个挂载点。
     *
     * keyed 插槽按 `key` 分派（值即标签类型定义的 `id`）；写成 `id` 会让侧栏查不到正文，
     * 落到「这类内容还没有可用的查看方式」的兜底文案。
     */
    register(registration: { name: string; key: string; order: number }, component: () => unknown): () => void;
  };
}

/**
 * 打开右侧栏的对话标签。
 *
 * 侧栏导航面可能比注册表晚到，取不到就什么都不做。快捷键的触发动作走这里，
 * 这样「标签类型」这个事实仍只在 registerPetChatTab 里出现一次。
 *
 * @param ctx - 客户端上下文（只用到软取）。
 */
export function openPetChatTab(ctx: PetChatTabHost): void {
  const controller = ctx.get?.('sidebarRight') as { openTab?(kind: string): void } | undefined;
  controller?.openTab?.(TAB_KIND);
}

/**
 * 注册对话标签（标签类型 + 正文插槽 + 样式）。
 *
 * @param ctx - 客户端上下文。
 * @param rt - 注入的 react 能力。
 * @param options.commandId - 快捷键命令 id；只有命令真的登记成功才传，指向不存在的命令会让侧栏抛错。
 * @returns 注销标签类型并释放样式的函数；正文插槽交给 slots.inject 的作用域随插件卸载。
 */
export function registerPetChatTab(
  ctx: PetChatTabHost,
  rt: ChatPanelRuntime,
  options: { commandId?: string } = {},
): () => void {
  const tabs = ctx.get?.('sidebarRightTabs') as SidebarTabRegistry | undefined;
  if (tabs === undefined || typeof tabs.register !== 'function') {
    console.warn('[dsh-pet] 右侧栏不可用：没有 sidebarRightTabs 服务，桌宠对话标签未注册');
    return () => {};
  }
  const disposeCss = injectPanelCss();
  const Panel = makePetChatPanel(rt);
  /** 指南页卡片的图标：插件 logo；框架给的位置只有 16px 左右，靠 CSS 铺满。 */
  const GuideIcon = () => rt.h('img', { className: 'pet-chat-guide-icon', src: LOGO_URL, alt: '', loading: 'lazy' });

  const commandId = options.commandId;

  const disposeType = tabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    // extension 是外部插件最高优先带：不与内置类型抢地址，但可以覆盖同名 kind
    priority: 'extension',
    title: () => TAB_TITLE,
    guide: [
      {
        id: TAB_KIND,
        order: 400,
        title: () => TAB_TITLE,
        description: () => '与所有桌宠对话，点标签切换',
        icon: GuideIcon,
        ...(commandId === undefined ? {} : { commandId }),
      },
    ],
  });
  // 右侧栏可能晚于本插件挂载：等插槽声明后再注册，避免「打开标签却空白」
  ctx.slots.inject('sidebar.right.pane.tab', function* () {
    yield ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, order: 100 }, () => rt.h(Panel, {}));
  });
  return () => {
    disposeType();
    disposeTip();
    disposeCss();
  };
}
