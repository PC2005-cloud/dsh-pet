/**
 * 右键菜单、对话弹窗与悬浮提示的入口：三样都是贴在宠物上的浮层，共享同一套关闭与定位时机。
 * 不负责动作本身：菜单叶子交给 menu-actions 派发，对话内容由 shared/chat 与宿主 /chat 处理。
 * 浮层句柄只在本模块持有，卸载时统一关闭；提示位置直接写 style，不走 React 状态。
 * @module dsh-pet/src/client/pet/card/entry
 */
import { CHAT_HOTKEY_HINT, mountChatDialog } from '../../../shared/chat/index.ts';
import { captureDisplayFrame } from '../../../shared/chat/capture.ts';
import { mountTodoPanel, type TodoPanelMount } from '../../../shared/todo/index.ts';
import { bindOpenChat } from './open-chat.ts';
import {
  buildMenuTree,
  buildMoreBranch,
  displayMenuBranch,
  mountContextMenu,
  type MenuNode,
} from '../../../shared/menu.ts';
import { ROUTE_PATH } from '../../../shared/constants.ts';
import { TOOLTIP_GAP_RATIO, tooltipPlacement } from '../../../shared/tooltip.ts';
import type { MenuMoreItem } from '../../../shared/menu.ts';
import type { CardLive } from './live.ts';
import type { CardMotion } from './motion.ts';
import type { CardStateApi } from './state.ts';
import type { Drag } from '../motion/drag.ts';
import type { MenuActions } from '../menu-actions.ts';
import type { RuntimePet } from '../types.ts';
import type * as ReactNS from 'react';

/** 注入的 react 能力。 */
export interface CardEntryRuntime {
  /** 副作用；卸载时关闭浮层。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  /** 引用；浮层句柄与提示节点。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 浮层入口的输入。 */
export interface CardEntryInput {
  /** 卡状态：提示显隐与写入口。 */
  card: CardStateApi;
  /** 成品配置的最新值。 */
  cfgRef: ReactNS.MutableRefObject<RuntimePet>;
  /** 装配根迟绑槽。 */
  live: ReactNS.MutableRefObject<CardLive>;
  /** 运动面：开菜单前要停飞与停走。 */
  motion: CardMotion;
  /** 拖拽驱动：拖拽中或刚拖完不弹菜单。 */
  drag: Drag;
  /** 第三方菜单项快照；只在右键那一刻读。 */
  menuItemsRef: ReactNS.MutableRefObject<MenuMoreItem[]>;
  /** 菜单动作派发。 */
  runMenuAction: MenuActions['run'];
  /** 悬浮提示节点：位置由本模块直接写 style。 */
  tipRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
  /** 舞台节点：对话弹窗贴命中区右上角。 */
  stage: () => HTMLDivElement | null;
}

/** 浮层入口对外的读写面。 */
export interface CardEntry {
  /** 把提示框摆到光标右下，放不下时翻边并夹回视口。 */
  placeTip: (clientX: number, clientY: number) => void;
  /** 打开右键菜单。 */
  handleContextMenu: (e: ReactNS.MouseEvent<HTMLDivElement>) => void;
  /** 打开对话弹窗：菜单里「对话」那一项走这里；带图时直接进入待发送状态（拖拽用）。 */
  openChat: (image?: File) => void;
  /** 打开待办面板（右键菜单入口）。 */
  openTodo: () => void;
  /** 单击宠物：面板开着就收起，没开就打开。 */
  toggleTodo: () => void;
  /** 指针进入：先摆位再显示。 */
  onPointerEnter: (e: ReactNS.PointerEvent<HTMLDivElement>) => void;
  /** 指针离开：收起提示。 */
  onPointerLeave: () => void;
}

/**
 * 造浮层入口的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收装配输入的 hook，返回菜单、对话与提示的入口。
 */
export function createCardEntry(rt: CardEntryRuntime) {
  const { useEffect, useRef } = rt;

  return function useCardEntry(input: CardEntryInput): CardEntry {
    const { card, cfgRef, drag, live, menuItemsRef, motion, runMenuAction, stage, tipRef } = input;
    // 右键菜单、对话弹窗与待办面板当前的 close 句柄，卸载或重开前清理。
    const menuRef = useRef<{ close: () => void } | null>(null);
    const chatRef = useRef<{ close: () => void } | null>(null);
    const todoRef = useRef<TodoPanelMount | null>(null);

    /** 把提示框摆到光标右下，放不下时翻边并夹回视口。
     *  直接写 DOM style：每次鼠标移动都走 React 状态会让整个 PetCard 重渲染。
     */
    const placeTip = (clientX: number, clientY: number): void => {
      const tipEl = tipRef.current;
      if (!tipEl) return;
      const viewport = document.documentElement;
      const p = tooltipPlacement(
        { x: clientX, y: clientY },
        { w: tipEl.offsetWidth, h: tipEl.offsetHeight },
        { x: 0, y: 0, w: viewport.clientWidth, h: viewport.clientHeight },
        motion.metrics().size * TOOLTIP_GAP_RATIO,
      );
      tipEl.style.left = p.x + 'px';
      tipEl.style.top = p.y + 'px';
    };

    // 卸载时关闭可能开着的右键菜单与对话弹窗。
    useEffect(
      () => () => {
        if (menuRef.current) {
          menuRef.current.close();
          menuRef.current = null;
        }
        if (chatRef.current) {
          chatRef.current.close();
          chatRef.current = null;
        }
        if (todoRef.current) {
          todoRef.current.close();
          todoRef.current = null;
        }
      },
      [],
    );

    /** 打开对话弹窗：弹窗贴在身体命中区右上角，视频框右上角不等于宠物右上角；超出视口夹回。 */
    const openChat = (image?: File): void => {
      if (chatRef.current) chatRef.current.close();
      const hitRect = stage()?.querySelector('.dsh-pet-hit')?.getBoundingClientRect();
      chatRef.current = mountChatDialog({
        petId: cfgRef.current.id,
        baseUrl: ROUTE_PATH + '/chat',
        surface: 'web',
        x: hitRect ? hitRect.right + 6 : window.innerWidth - 256,
        y: hitRect ? hitRect.top + 6 : 8,
        ...(image ? { initialImage: image } : {}),
        // 浏览器侧截屏：getDisplayMedia 抓一帧，系统选择器由用户确认
        capture: captureDisplayFrame,
        onSent: () => {
          // 发送成功：回复已写进 /state，长轮询会立刻返回并弹气泡。
          console.info('[dsh-pet] 对话已发送 pet=' + cfgRef.current.id);
        },
        onClose: () => {
          chatRef.current = null;
        },
      });
    };

    /** 宠物命中区的当前矩形：面板贴着它摆，宠物走位时由面板自己巡检跟随。 */
    const anchorRect = () => {
      const rect = stage()?.querySelector('.dsh-pet-hit')?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
    };

    /** 打开待办面板：全页只允许一个，重复调用先由 mountTodoPanel 顶掉旧面板。 */
    const openTodo = (): void => {
      if (todoRef.current) return;
      const hit = stage()?.querySelector<HTMLElement>('.dsh-pet-hit') ?? null;
      todoRef.current = mountTodoPanel({
        anchor: anchorRect,
        anchorEl: hit,
        onClose: () => {
          todoRef.current = null;
        },
      });
    };

    /** 单击宠物 = 面板开关：开着就收起，没开就打开。 */
    const toggleTodo = (): void => {
      if (todoRef.current) {
        todoRef.current.close();
        return;
      }
      openTodo();
    };

    // 悬停标记：快捷键与拖拽都只在"鼠标停在这只宠物上"时生效，避免和页面其它交互抢事件。
    const hoverRef = useRef(false);
    // 挂载时注册一次监听，但始终调用最新的 openChat 闭包（它读 ref，不能捕获旧值）。
    const openChatRef = useRef<(image?: File) => void>(openChat);
    openChatRef.current = openChat;
    // stage 是 getter（首次渲染时节点还不存在），effect 里再取一次，并用 ref 避开依赖告警。
    const stageGetterRef = useRef(stage);
    stageGetterRef.current = stage;
    useEffect(
      () =>
        bindOpenChat({
          stage: stageGetterRef.current(),
          isHovered: () => hoverRef.current,
          openChat: (image) => openChatRef.current(image),
        }),
      [],
    );
    // 菜单的动作面里含「对话」一条，回调注册一次即可：弹窗句柄在闭包里。
    live.current.placeTip = placeTip;
    live.current.tipOn = () => card.state.tipOn;

    /** 打开右键菜单。 */
    const handleContextMenu = (e: ReactNS.MouseEvent<HTMLDivElement>): void => {
      // 工具项与动作树；「查看余额」无条件显示，手动请求不受开关限制。
      // 第三方菜单项收在「更多」下，0 项不出现，单 owner 单条时平铺（见 buildMoreBranch）。
      const more = buildMoreBranch(menuItemsRef.current);
      const tools: MenuNode[] = [
        { label: '待办事项', action: 'todo' },
        { label: '查看余额', action: 'show-balance' },
        { label: '碎碎念', action: 'whisper' },
        { label: '对话', action: 'chat', hint: CHAT_HOTKEY_HINT },
        { label: '回到初始位置', action: 'home' },
        // 显示位置子菜单与桌面端同一份；改成不含 web 的值后本宠物会从页面消失。
        displayMenuBranch(),
      ];
      const tree: MenuNode[] = [...tools, ...buildMenuTree(cfgRef.current.animations), ...(more ? [more] : [])];
      if (!tree.length) return;
      e.preventDefault();
      e.stopPropagation(); // 不触碰 DSH 页面的菜单与右键处理。
      if (drag.isActive() || drag.justDragged()) return;
      motion.flight.stop(); // 菜单弹出前停住飞行中的宠物。
      motion.stopMove(); // 菜单悬停期间宠物不漫游。
      if (menuRef.current) menuRef.current.close();
      menuRef.current = mountContextMenu({
        tree,
        x: e.clientX,
        y: e.clientY,
        onAction: runMenuAction,
        // 菜单被点外或 Esc 关闭时置空句柄，避免残留引用。
        onClose: () => {
          if (menuRef.current) menuRef.current = null;
        },
      });
    };

    return {
      handleContextMenu,
      onPointerEnter: (e) => {
        hoverRef.current = true;
        placeTip(e.clientX, e.clientY); // 先摆位再显示，否则会先在兜底坐标闪一帧。
        card.actions.setTipOn(true);
      },
      onPointerLeave: () => {
        hoverRef.current = false;
        card.actions.setTipOn(false);
      },
      openChat,
      openTodo,
      placeTip,
      toggleTodo,
    };
  };
}
