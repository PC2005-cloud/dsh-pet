/**
 * 对话面板的本地状态形状与对外状态契约。
 *
 * 只声明类型：取值流程归 ./state，动作实现归 ./actions。
 * @module dsh-pet/src/client/chat/types
 */
import type { EncodedImage } from '../../shared/chat/encode.ts';
import type { Pet } from '../../shared/types.ts';
import type { ChatMessageView, ChatRound, OrphanHistory } from './api.ts';

/** 面板的全部可渲染字段；一次性替换，避免多个 useState 各提交一半。 */
export interface PanelData {
  readonly pets: Pet[];
  readonly petId: string;
  readonly messages: ChatMessageView[];
  readonly draft: string;
  /** 待发送的图；undefined = 这一条是纯文字。 */
  readonly attachment: EncodedImage | undefined;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly error: string;
  /** 勾选的轮（`ts`），删除按这个集合走。 */
  readonly selected: number[];
  /** 多选模式：默认关闭，勾选框只在开启后出现。 */
  readonly selecting: boolean;
  /** 已删宠物残留的历史（配置里已没有的宠物），用于顶部提示与一键清理。 */
  readonly orphans: OrphanHistory[];
  /** 正在等待确认的破坏性操作；null = 没有。 */
  readonly pending: ConfirmKind | null;
  /** 当前展示多少轮（默认 10）：更早的留在内存里，点「加载更早」再放出来。 */
  readonly visibleRounds: number;
  /** 正在放大的图片地址；undefined = 没有预览。 */
  readonly previewUrl: string | undefined;
  /** 条目（素材根）→ 该条目保留的对话轮数；来自同一份 `/config`。 */
  readonly roundsByEntry: Readonly<Record<string, number>>;
  /** 宠物 id → 实际在用的人设正文；与轮数出自同一份 `/config`。 */
  readonly personas: Readonly<Record<string, string>>;
  /** 「人设」卷帘是否展开：收起时内容留在 DOM 里、高度归零，展开过渡才播得起来。 */
  readonly personaOpen: boolean;
  /** 正在点播的那一轮与阶段；null = 没有在播。同一时刻只播一条。 */
  readonly speaking: { readonly ts: number; readonly phase: 'loading' | 'playing' | 'failed' } | null;
}

/** 需要二次确认的破坏性操作：用面板内的确认条，不用浏览器原生 `confirm`。 */
export type ConfirmKind = 'delete-selected' | 'clear-all' | 'clear-orphans';

/** hook 返回：状态、派生值、动作与列表引用。 */
export interface ChatPanelState extends PanelData {
  /** 当前要渲染的轮（已经按 {@link PanelData.visibleRounds} 截过）。 */
  readonly rounds: readonly ChatRound[];
  /** 内存里还有更早的轮没展示。 */
  readonly hasOlder: boolean;
  /** 多放一批更早的轮出来。 */
  readonly showOlder: () => void;
  readonly petName: string;
  readonly assetRoot: string;
  /** 当前条目保留的轮数（`chatMemoryRounds`）；配置里没有时不画记忆边界线。 */
  readonly memoryRounds: number | undefined;
  /** 当前这只宠物实际在用的人设正文；空串 = 实例与条目都没写。 */
  readonly persona: string;
  /** 展开 / 收起人设卷帘。 */
  readonly togglePersona: () => void;
  /** 收起人设卷帘（Esc）。 */
  readonly closePersona: () => void;
  /** 消息列表容器：滚动到底部要用。 */
  readonly listRef: { current: HTMLDivElement | null };
  /** 输入框：内容变高时要直接改它的 height。 */
  readonly draftRef: { current: HTMLTextAreaElement | null };
  readonly pickPet: (petId: string) => void;
  readonly toggleRound: (ts: number) => void;
  /** 进入 / 退出多选模式；退出时清空已勾选。 */
  readonly toggleSelecting: () => void;
  readonly deleteSelected: () => void;
  readonly clearAll: () => void;
  /** 清掉已删宠物残留的历史（顶部提示条上的「清理」）。 */
  readonly clearOrphans: () => void;
  /** 请求确认某个破坏性操作（只弹出确认条，不执行）。 */
  readonly ask: (kind: ConfirmKind) => void;
  /** 取消确认条。 */
  readonly cancelAsk: () => void;
  /** 确认并执行；没有待确认项时什么都不做。 */
  readonly confirmAsk: () => void;
  /** 放大一张对话图片。 */
  readonly showImage: (url: string) => void;
  /** 关闭图片放大。 */
  readonly closeImage: () => void;
  readonly setDraft: (text: string) => void;
  /** 点播某一轮的回答：请求合成 → 播放 → 归位，阶段写进 {@link PanelData.speaking}。 */
  readonly speakRound: (ts: number, text: string) => void;
  readonly pickFile: (file: File) => void;
  readonly clearAttachment: () => void;
  readonly send: () => void;
}
