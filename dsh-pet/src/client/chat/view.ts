/**
 * 对话面板的根元素：宠物标签条 + 工具栏 + 列表 + 错误行 + 输入区。
 *
 * 只做装配，节点细节在 ./view-node；不取数、不持状态。
 * @module dsh-pet/src/client/chat/view
 */
import { HISTORY_ROUNDS, memoryBoundaryIndex, MEMORY_LINE_ATTR } from './api.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import type { ChatPanelState } from './types.ts';
import { composerNode, confirmNode, orphansNode, personaNode, toolsNode } from './view-node.ts';
import { roundNode } from './view-message.ts';

/** 宠物标签条：点击切换对话。 */
function tabsNode(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  return h('div', {
    className: 'pet-chat-tabs',
    children: state.pets.map((pet) =>
      h('button', {
        key: pet.id,
        type: 'button',
        className: 'pet-chat-tab',
        'aria-pressed': String(pet.id === state.petId),
        onClick: () => state.pickPet(pet.id),
        children: pet.name || pet.id,
      }),
    ),
  });
}

/**
 * 顶部「加载更早」：与 DSH 自己的历史加载同一个位置与形态。
 *
 * 内存里没有更早的轮时，同一个位置换成一行说明——不然按钮消失后用户不知道是「到底了」还是「坏了」。
 */
function olderNode(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  if (state.rounds.length === 0) return null; // 空态由列表里的提示负责
  if (state.hasOlder) {
    return h('div', {
      className: 'pet-chat-older',
      children: [
        h('button', {
          type: 'button',
          className: 'pet-chat-older-btn',
          onClick: () => state.showOlder(),
          children: '加载更早',
        }),
      ],
    });
  }
  // 取满 200 轮时再加一句上限说明：再多接口也给不出来了
  const capped = state.rounds.length >= HISTORY_ROUNDS;
  return h('div', {
    className: 'pet-chat-older',
    children: [
      h('span', {
        className: 'pet-chat-older-note',
        children: capped ? '已经到底了（最多加载 ' + HISTORY_ROUNDS + ' 轮）' : '已经到底了',
      }),
    ],
  });
}

/** 记忆边界：线以下才是桌宠每次真正带进上下文的最近 N 轮。 */
function memoryLineNode(h: ChatPanelRuntime['h'], rounds: number): unknown {
  return h('div', {
    key: 'memory-line',
    className: 'pet-chat-memory',
    // 工具栏的「记忆线」按钮按这个标记滚过来：线在不在窗口里、第几个，都由渲染决定
    [MEMORY_LINE_ATTR]: 'true',
    children: [h('span', { className: 'pet-chat-memory-note', children: `以下 ${rounds} 轮进入桌宠的记忆` })],
  });
}

/** 消息列表：加载更早 + 记忆边界 + 空态提示或按轮渲染。 */
function listNode(rt: ChatPanelRuntime, state: ChatPanelState): unknown {
  const emptyText = state.loading ? '加载中…' : state.petId === '' ? '没有可对话的桌宠' : '还没有聊过天';
  const body =
    state.rounds.length === 0
      ? [rt.h('div', { key: 'empty', className: 'pet-chat-hint', children: emptyText })]
      : state.rounds.map((round) => roundNode(rt, state, round));
  const cut = memoryBoundaryIndex(state.rounds.length, state.memoryRounds);
  if (cut !== null && state.memoryRounds !== undefined) {
    body.splice(cut, 0, memoryLineNode(rt.h, state.memoryRounds));
  }
  return rt.h('div', {
    className: 'pet-chat-list',
    ref: state.listRef,
    children: [olderNode(rt.h, state), ...body],
  });
}

/**
 * 图片放大：直接用平台的 `ImageLightbox`——与 DSH 会话里点开图片是同一个组件，
 * 全屏遮罩、Esc / 点遮罩关闭、关闭后焦点回到原处都由它负责。
 *
 * @returns 没有预览或拿不到 primitives 时是 null。
 */
function previewNode(rt: ChatPanelRuntime, state: ChatPanelState): unknown {
  if (state.previewUrl === undefined || rt.ui === undefined) return null;
  const { ImageLightbox } = rt.ui;
  return rt.h(ImageLightbox, {
    src: state.previewUrl,
    alt: '对话图片',
    labels: { dialog: '图片预览', close: '关闭' },
    onClose: () => state.closeImage(),
  });
}

/**
 * 造面板根元素。
 *
 * @param rt - 注入的 react 能力。
 * @param state - 当前状态与动作。
 * @returns 面板根元素。
 */
export function buildPanel(rt: ChatPanelRuntime, state: ChatPanelState): unknown {
  const { h } = rt;
  return h('div', {
    className: 'pet-chat',
    // Esc 收起卷帘：焦点在按钮上还是在输入框里都收得到（事件冒泡到根节点）
    onKeyDown: (event: { key: string }) => {
      if (state.personaOpen && event.key === 'Escape') state.closePersona();
    },
    children: [
      tabsNode(h, state),
      orphansNode(h, state),
      toolsNode(h, state),
      personaNode(h, state),
      listNode(rt, state),
      confirmNode(rt, state),
      previewNode(rt, state),
      state.error === '' ? null : h('div', { className: 'pet-chat-error', role: 'alert', children: state.error }),
      composerNode(h, state),
    ],
  });
}
