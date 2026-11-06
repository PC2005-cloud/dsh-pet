/**
 * 对话面板的 react 能力契约（宿主注入，不直接 import react）。
 *
 * `h` 就是 `react/jsx-runtime` 的 `jsx`：子节点只能放进 `props.children`，
 * 它的第三个参数是 key 而不是 children——传成变参会把内容静默丢掉（表现为整块空白）。
 * @module dsh-pet/src/client/chat/runtime
 */
import type { Button, ImageLightbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Key } from './locales/index.ts';

/** 面板文案的翻译函数：`params` 用于 `{name}` 占位符替换。 */
export type ChatTranslate = (key: Key, params?: Record<string, unknown>) => string;

/** DSH 的 UI 原语：确认弹窗与图片灯箱都用平台组件，不自己造。 */
export interface PetChatUi {
  readonly Modal: typeof Modal;
  readonly Button: typeof Button;
  /** 原图灯箱：点击消息里的图片时用它（与 DSH 会话里的看图完全同一个组件）。 */
  readonly ImageLightbox: typeof ImageLightbox;
}

/** 组件与 hook 需要的 react 子集。 */
export interface ChatPanelRuntime {
  /** 创建元素；子节点写进 `props.children`。 */
  h: (type: unknown, props?: Record<string, unknown> | null) => unknown;
  /** 状态。 */
  useState: <T>(init: T) => [T, (next: T | ((prev: T) => T)) => void];
  /** 副作用。 */
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => void;
  /** 跨渲染引用。 */
  useRef: <T>(initial: T) => { current: T };
  /** 文案翻译；读取的是宿主当前语言，随语言切换即时生效。 */
  readonly t: ChatTranslate;
  /** 平台 UI 原语；缺失时确认弹窗退化为内联确认条。 */
  readonly ui?: PetChatUi;
}
