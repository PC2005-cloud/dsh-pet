/**
 * 右键菜单、对话弹窗与悬浮提示的入口：三样都是贴在宠物上的浮层，共享同一套关闭与定位时机。
 * 不负责动作本身：菜单叶子交给 menu-actions 派发，对话内容由 shared/chat 与宿主 /chat 处理。
 * 浮层句柄只在本模块持有，卸载时统一关闭；提示位置直接写 style，不走 React 状态。
 * @module dsh-pet/src/client/pet/card/entry
 */
import { CHAT_HOTKEY_HINT, createHearHold, mountChatDialog, type ChatDialogMount } from '../../../shared/chat/index.ts';
import { captureDisplayFrame } from '../../../shared/chat/capture.ts';
import { SLEEP_HOTKEY_HINT, isSleepHotkey } from '../../../shared/sleep-hotkey.ts';
import { TODO_HOTKEY_HINT, isTodoHotkey } from '../../../shared/todo/hotkey.ts';
import { bindOpenChat } from './open-chat.ts';
import { registerPetChatHandle } from './registry.ts';
import {
  buildMemeBranch,
  buildMenuTree,
  buildMoreBranch,
  displayMenuBranch,
  memeThumbUrl,
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
  /** 打开待办面板：面板占气泡槽，显隐归气泡单槽管。 */
  showTodo: () => void;
  /** 开关待办面板：D 键用，已开则收起。 */
  toggleTodo: () => void;
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
    const { card, cfgRef, drag, live, menuItemsRef, motion, runMenuAction, showTodo, stage, tipRef, toggleTodo } =
      input;
    // 右键菜单与对话弹窗当前的句柄，卸载或重开前清理。对话弹窗还要按住说话遥控开录/收尾。
    const menuRef = useRef<{ close: () => void } | null>(null);
    const chatRef = useRef<ChatDialogMount | null>(null);

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

    /** 打开待办面板：面板占气泡槽，重复点击是幂等的。 */
    const openTodo = (): void => showTodo();

    /** 「按住说话」按下：弹窗没开就先开一个，再让它开录；已开着就直接在它上面开录。 */
    const startChatHear = (): void => {
      if (!chatRef.current) openChat();
      chatRef.current?.startHear();
    };
    /** 「按住说话」松开：只收尾，不关弹窗——识别结果要落进输入框让人看一眼。 */
    const stopChatHear = (): void => {
      chatRef.current?.stopHear();
    };
    /** 打开对话：已经开着就只把焦点交回输入框，重开会把打了一半的字丢掉。 */
    const openChatOrFocus = (): void => {
      const existing = chatRef.current;
      if (existing === null) {
        openChat();
        return;
      }
      existing.el.querySelector<HTMLTextAreaElement>('.dsh-pet-chat-input')?.focus();
    };

    // 悬停标记：快捷键与拖拽都只在"鼠标停在这只宠物上"时生效，避免和页面其它交互抢事件。
    const hoverRef = useRef(false);
    // 挂载时注册一次监听，但始终调用最新的 openChat 闭包（它读 ref，不能捕获旧值）。
    const openChatRef = useRef<(image?: File) => void>(openChat);
    openChatRef.current = openChat;
    // stage 是 getter（首次渲染时节点还不存在），effect 里再取一次，并用 ref 避开依赖告警。
    const stageGetterRef = useRef(stage);
    stageGetterRef.current = stage;
    // 待办开关同样只在悬停时生效；存 ref 是因为它每次渲染都新建，闭包会捕获旧的那份。
    const toggleTodoRef = useRef(toggleTodo);
    toggleTodoRef.current = toggleTodo;
    // 睡觉同样是切换语义：按下的那一刻现读状态，决定发 /sleep 还是 /wake（与菜单那一项同一件事）。
    const toggleSleepRef = useRef<() => void>(() => {});
    toggleSleepRef.current = () => {
      const asleep = live.current.flow?.sleeping() ?? false;
      runMenuAction(asleep ? { label: '起来', action: 'wake' } : { label: '睡觉', action: 'sleep' });
    };
    // 按住说话的按下/松开同样每次渲染都新建闭包；状态机只建一次，只能经 ref 取最新的那两个。
    const startChatHearRef = useRef<() => void>(startChatHear);
    startChatHearRef.current = startChatHear;
    const stopChatHearRef = useRef<() => void>(stopChatHear);
    stopChatHearRef.current = stopChatHear;
    const openChatOrFocusRef = useRef<() => void>(openChatOrFocus);
    openChatOrFocusRef.current = openChatOrFocus;
    // 全局快捷键要能遥控这一只：登记开窗与开关录音，卸载时摘掉。
    // 句柄里全走 ref，卡片重渲染不会让登记表拿到过期闭包；cfgRef 本身也是稳定引用，列进依赖只为满足规则。
    useEffect(
      () =>
        registerPetChatHandle(cfgRef.current.id, {
          open: () => openChatOrFocusRef.current(),
          startHear: () => startChatHearRef.current(),
          stopHear: () => stopChatHearRef.current(),
          isHearing: () => chatRef.current?.isHearing() ?? false,
        }),
      [cfgRef],
    );
    // 四个快捷键共用一次挂载：L 开对话、按住 M 说话、D 开关待办、S 切换睡/醒。
    // 前三个都只在鼠标停在这只宠物上时生效；按住说话多一条——光标还在宠物自己的弹窗里也算，
    // 否则弹窗一开焦点被输入框拿走，最想说话的时机反而按不动。
    useEffect(() => {
      const offChat = bindOpenChat({
        stage: stageGetterRef.current(),
        isHovered: () => hoverRef.current,
        openChat: (image) => openChatRef.current(image),
      });
      // 按住 M：按下开录、松手收尾。状态机自己管自动重复与松开，这里只管把事件送进去。
      const hearHold = createHearHold({
        isArmed: () => {
          if (hoverRef.current) return true;
          const chat = chatRef.current;
          const active = document.activeElement;
          return !!chat && !!active && chat.el.contains(active);
        },
        onPress: () => startChatHearRef.current(),
        onRelease: () => stopChatHearRef.current(),
      });
      const onKeyDown = (e: KeyboardEvent): void => {
        if (hearHold.onKeyDown(e)) {
          e.preventDefault();
          return;
        }
        if (!hoverRef.current) return;
        if (isSleepHotkey(e)) {
          e.preventDefault();
          toggleSleepRef.current();
          return;
        }
        if (!isTodoHotkey(e)) return;
        e.preventDefault();
        toggleTodoRef.current();
      };
      const onKeyUp = (e: KeyboardEvent): void => hearHold.onKeyUp(e);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      return () => {
        offChat();
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('keyup', onKeyUp, true);
      };
    }, []);
    // 菜单的动作面里含「对话」一条，回调注册一次即可：弹窗句柄在闭包里。
    live.current.placeTip = placeTip;
    live.current.tipOn = () => card.state.tipOn;

    /** 打开右键菜单。 */
    const handleContextMenu = (e: ReactNS.MouseEvent<HTMLDivElement>): void => {
      // 工具项与动作树；「查看余额」无条件显示，手动请求不受开关限制。
      // 第三方菜单项收在「更多」下，0 项不出现，单 owner 单条时平铺（见 buildMoreBranch）。
      const more = buildMoreBranch(menuItemsRef.current);
      // 「配图」：按配置里的清单分成「纳入对话的配图 / 其他」，点一张就用它说一句。
      // 没有可用图时返回 null，整项不出现（不占一个点开是空的菜单）。
      // 缩略图靠 /pic/memes/<素材根>/<名称>.png：素材根就是拍平时写入的条目 key。
      const pic = cfgRef.current;
      const memes = buildMemeBranch(pic, (name) => memeThumbUrl(ROUTE_PATH, pic.assetRoot, name));
      // 睡觉/起来是同一个入口的两种文案：睡着时点它等于叫醒（与「点击宠物」同义）。
      // 该条目没配 animations.sleep 就整项不出现——与配置注释「不写 = 没有睡觉功能」一致。
      const asleep = live.current.flow?.sleeping() ?? false;
      const canSleep = (cfgRef.current.animations.sleep ?? []).length > 0;
      const sleepItem: MenuNode = asleep
        ? { label: '起来', action: 'wake', hint: SLEEP_HOTKEY_HINT }
        : { label: '睡觉', action: 'sleep', hint: SLEEP_HOTKEY_HINT };
      const tools: MenuNode[] = [
        { label: '查看余额', action: 'show-balance' },
        { label: '待办事项', action: 'todo', hint: TODO_HOTKEY_HINT },
        ...(canSleep ? [sleepItem] : []),
        { label: '碎碎念', action: 'whisper' },
        ...(memes ? [memes] : []),
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
    };
  };
}
