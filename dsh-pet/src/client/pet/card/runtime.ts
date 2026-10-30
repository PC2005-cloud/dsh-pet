/**
 * 一张宠物卡的装配根：按固定顺序创建驱动与 hook，再把当帧能力拼成视图输入。
 * 只做接线：不判定（判定在 shared 与各驱动）、不渲染（DOM 在 card-view）、不持有跨卡状态。
 * 装配顺序不能改：动画链早于运动（回调要读走位）、运动早于拖拽（拖拽读飞行）、浮层最后。
 * 必须在渲染期填池：迟绑槽里的驱动实例只在本次渲染内赋值，别处不得写入。
 * @module dsh-pet/src/client/pet/card/runtime
 */
import { pick } from '../../../shared/pickers.ts';
import { postAction } from '../../../shared/state.ts';
import { ROUTE_PATH } from '../../../shared/constants.ts';
import { resolveFontPx } from '../../../shared/fonts.ts';
import { resolvePetSizePx } from '../../../shared/pet-size.ts';
import { makeBalanceBubble, makeWhisperBubble } from '../../bubble.ts';
import { makeTodoBubble } from '../../todo-bubble.ts';
import { petBridge } from '../../settings.ts';
import { playClickSound } from '../click-sound.ts';
import { createMenuActions, type MenuActions } from '../menu-actions.ts';
import { derivePetMetrics, petRootStyle, petStageStyle } from '../motion/geometry.ts';
import { makePlaybackReporter } from '../playback-report.ts';
import { createAnimationFlow } from './animation-flow.ts';
import { createBubbleSlots } from './bubble-slots.ts';
import { createCardAnimation } from './animation.ts';
import { createCardDrag } from './drag.ts';
import { createCardEntry, type CardEntry } from './entry.ts';
import { createCardMotion } from './motion.ts';
import { createCardState } from './state.ts';
import { createCueEffects } from './cue-effects.ts';
import { createLockFreeze } from './lock-freeze.ts';
import type { CardHub } from './hub.ts';
import type { CardLive } from './live.ts';
import type { CardViewProps } from './view.ts';
import type { PetCardProps } from './props.ts';
import type { PetRuntime } from '../types.ts';

/**
 * 造卡片装配根的工厂：组件级单例（气泡、状态、指令、动画流）都在这里建一次。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收容器 props 的 hook，返回交给 card-view 的渲染输入。
 */
export function createCardRuntime(rt: PetRuntime) {
  const { h, useEffect, useRef, useState } = rt;
  /** 余额气泡：数据与显隐由装配根传入。 */
  const BalanceBubble = makeBalanceBubble({ h, useState, useEffect });
  /** 碎碎念气泡：文本与显隐由装配根传入。 */
  const WhisperBubble = makeWhisperBubble({ h });
  /** 待办气泡：面板本体挂在自己身上，关闭按钮回调装配根。 */
  const TodoBubble = makeTodoBubble({ h, useEffect, useRef });
  /** 四种气泡的单槽：显隐、停留计时与优先级都在这里。 */
  const useBubbleSlots = createBubbleSlots(
    { h, useState, useEffect, useRef },
    { balanceBubble: BalanceBubble, todoBubble: TodoBubble, whisperBubble: WhisperBubble },
  );
  const useCardState = createCardState({ useState, useRef });
  const useLockFreeze = createLockFreeze({ useEffect, useRef });
  const useCueEffects = createCueEffects({ useEffect, useRef });
  const useAnimationFlow = createAnimationFlow({ useRef });
  const useCardAnimation = createCardAnimation({ useEffect, useRef });
  const useCardMotion = createCardMotion({ useEffect, useRef });
  const useCardDrag = createCardDrag({ useRef, useEffect });
  const useCardEntry = createCardEntry({ useEffect, useRef });

  return function useCardRuntime(props: PetCardProps): CardViewProps {
    const { arena, balance, balanceManual, cfg, lock, lockTick, menuItemsRef, sleep, sleepTick, workStatus } = props;

    // 实际渲染宽度：百分比只在挂载与配置变更时按当次视口宽解析一次，拖窗口不跟随。
    // 物理、字号与 CSS 变量都吃这一个值——两处各算一次会让命中框与视觉错位。
    const effectiveSizePx = resolvePetSizePx(cfg.size, cfg.sizePercent, window.innerWidth);

    // 卡片状态容器：动画、朝向、拖拽态、提示与自定义位置；写入口在 card-state。
    const card = useCardState({
      anim: cfg.animations.idle[0] ?? '',
      corner: cfg.position.corner,
      margin: { x: cfg.position.marginX, y: cfg.position.marginY },
      size: effectiveSizePx,
    });
    const { actions, state } = card;
    const { corner, customPos, dragging, facing, margin, size, tipOn } = state;

    // 驱动实例与跨关注点入口：创建顺序见模块头，填充只在本函数内。
    const liveRef = useRef<CardLive>({} as CardLive);
    const menuActionsRef = useRef<MenuActions | null>(null);
    const entryRef = useRef<CardEntry | null>(null);
    const pendingSquashRef = useRef(false);

    // 成品配置与工作状态的最新值：回调晚于状态更新，只能读 ref。
    const cfgRef = useRef(cfg);
    cfgRef.current = cfg;
    const workStatusRef = useRef(workStatus);
    workStatusRef.current = workStatus;

    // DOM 节点：视图挂载后才有值，驱动全部经取值函数读。
    const rootRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const videoARef = useRef<HTMLVideoElement | null>(null);
    const videoBRef = useRef<HTMLVideoElement | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);

    // 回执在 playback-report.ts：地址、请求体与失败日志都在那里，这里只要一个函数。
    const reportPlayback = makePlaybackReporter({ petId: cfg.id });

    // 尺寸与派生几何；度量系数在 motion/geometry.ts，这里只解构使用。
    const { halfW, halfH, bottomPad, sideAllow } = derivePetMetrics(size);
    // 字号按本宠物尺寸算好注入 root，气泡与悬浮提示读它。
    const fontPx = resolveFontPx(cfg.font, size);
    const petAnims = cfg.animations;

    // 配置变化即时跟随，容器重新合并或设置页保存后触发。
    useEffect(() => {
      actions.setSize(resolvePetSizePx(cfg.size, cfg.sizePercent, window.innerWidth));
      // eslint-disable-next-line react-hooks/exhaustive-deps -- setter 稳定，变化原因只有配置的两个尺寸字段
    }, [cfg.size, cfg.sizePercent]);

    useEffect(() => {
      actions.setCorner(cfg.position.corner);
      actions.setMargin({ x: cfg.position.marginX, y: cfg.position.marginY });
      // 改位置是明确的「放这里」：清掉会话内的拖拽位置，让配置重新生效——
      // 这也是设置页把跑出视口的宠物叫回来的通道。只调大小不在此列，不该丢位置。
      actions.setCustomPos(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- setter 稳定，变化原因只有这三个位置字段
    }, [cfg.position.corner, cfg.position.marginX, cfg.position.marginY]);

    // 四种气泡的单槽：显隐、停留计时与优先级都在 bubble-slots，这里只喂视图输入。
    const bubbles = useBubbleSlots({
      assetRoot: cfg.assetRoot,
      balance,
      balanceEnabled: cfg.balanceEnabled,
      balanceManual,
      workStatusEnabled: cfg.workStatusEnabled,
      workTerminal: workStatus?.state === 'success' || workStatus?.state === 'error',
    });

    const ownAnim = useCardAnimation({
      card,
      cfgRef,
      live: liveRef,
      lock,
      pendingSquash: pendingSquashRef,
      petId: cfg.id,
      report: reportPlayback,
      setCuePlayback: actions.setCuePlayback,
      videoA: () => videoARef.current,
      videoB: () => videoBRef.current,
      workStatusRef,
    });

    const motion = useCardMotion({
      arena,
      card,
      cfgRef,
      live: liveRef,
      metrics: { bottomPad, halfH, halfW, sideAllow, size },
      moves: petAnims.moves,
      petId: cfg.id,
      root: () => rootRef.current,
      setAnim: actions.setAnim,
      setCustomPos: actions.setCustomPos,
      setOnce: actions.setOnce,
    });

    const drag = useCardDrag({
      bumpSeq: actions.bumpSeq,
      card,
      cfgRef,
      live: liveRef,
      motion,
      pendingSquash: pendingSquashRef,
      root: () => rootRef.current,
      setAnim: actions.setAnim,
      setCustomPos: actions.setCustomPos,
      setDragging: actions.setDragging,
      setOnce: actions.setOnce,
      setTipOn: actions.setTipOn,
      stage: () => stageRef.current,
    });

    // 右键菜单、对话与悬浮提示：动作派发经 ref 转发，避免与 menu-actions 构造期成环。
    const entry = useCardEntry({
      card,
      cfgRef,
      drag,
      live: liveRef,
      menuItemsRef,
      motion,
      runMenuAction: (leaf, playbackId, keepFacing) => menuActionsRef.current?.run(leaf, playbackId, keepFacing),
      showTodo: bubbles.showTodo,
      stage: () => stageRef.current,
      tipRef,
      toggleTodo: bubbles.toggleTodo,
    });
    entryRef.current = entry;

    // 菜单动作派发：依赖运动、拖拽、提示与对话四处入口，所以放在它们之后。
    menuActionsRef.current ??= createMenuActions({
      animations: () => cfgRef.current.animations,
      applyMerged: (merged) => petBridge.reload(merged),
      faceLeft: () => actions.setFacing('left'),
      isFacingRight: () => card.facingRef.current === 'right',
      openChat: () => entryRef.current?.openChat(),
      openTodo: () => entryRef.current?.openTodo(),
      petId: cfg.id,
      playOnce: (anim, playbackId) => {
        actions.setOnce(true);
        actions.setAnim(anim);
        actions.setCuePlayback(playbackId);
      },
      report: reportPlayback,
      resetPosition: () => actions.setCustomPos(null),
      // 睡觉：菜单在点击那一刻就要能拒绝（对话弹窗、待办面板、动作点播都是纯前端行为，宿主拦不到）
      say: (text) => liveRef.current.flow?.speak(text, undefined, undefined, undefined, false),
      locked: () => ownAnim.isFrozen(),
      sleepRefuseTexts: () => cfgRef.current.sleepRefuseTexts ?? [],
      sleeping: () => liveRef.current.flow?.sleeping() ?? false,
      stopMove: motion.stopMove,
      stopThrow: () => motion.flight.stop(),
      tryMove: motion.walk.tryMove,
      warn: (message) => console.warn(message),
    });
    const menuActions = menuActionsRef.current;

    // 占用锁：宿主靠内存持有，渲染端靠 /state 的 pets.<id>.lock 叶子感知。
    // 冻结只挡自播行为；显式指令（say / anim / position / throw）一概不挡，那正是持锁者要保护的内容。
    const lockFreeze = useLockFreeze({
      lock,
      lockTick,
      onFrozen: () => {
        // 光堵随机链不够：它只在动画播完时调用，不暂停会把当前这段播完才停。
        motion.stopMove();
        // 任务状态气泡：锁一生效就收掉，解冻不补亮。
        bubbles.hideWork();
      },
      onResumed: () => {
        // 解冻：非终态工作状态回档位循环，否则回 idle 一次，播完由动画链接回随机链。
        if (liveRef.current.flow?.resumeWorkStatusAnim() ?? false) return;
        if (petAnims.idle.length) {
          actions.setAnim(pick(petAnims.idle, card.animRef.current));
          actions.setOnce(true);
          actions.bumpSeq();
        }
      },
      setFrozen: ownAnim.setFrozen,
    });
    liveRef.current.releaseLock = () => {
      lockFreeze.release();
      void postAction(ROUTE_PATH + '/lock/release?pet=' + encodeURIComponent(cfg.id), { force: true });
    };

    // 共享运行时：状态容器、驱动与跨关注点动作拼成一份，指令处理按需取值。
    const hub: CardHub = {
      anims: () => cfgRef.current.animations,
      applyThrow: motion.applyThrow,
      bubbles,
      card,
      cfg: () => cfgRef.current,
      isDragging: () => drag.isActive(),
      ownAnim,
      // 第四个参数 = 宿主指令：来自 pets.<id>.anim 的点播，不按「用户点击」判睡觉
      playByName: (anim, playbackId, keepFacing) =>
        menuActions.run({ anim, label: anim }, playbackId, keepFacing, true),
      posFollow: motion.posFollow,
      speak: (text, image, url, duration, anim) => liveRef.current.flow?.speak(text, image, url, duration, anim),
      // 睡觉是状态不是指令：自动来源（工作状态/余额/碎碎念）读它决定要不要闭嘴
      sleeping: () => liveRef.current.flow?.sleeping() ?? false,
      // 占用锁：锁的语义是把控制权交给第三方，睡觉的菜单闸门与自动化闸门都对持锁者让路
      locked: () => ownAnim.isFrozen(),
      stopMotion: motion.stopMove,
      tryWalk: motion.walk.tryMove,
    };
    // 七条指令的分派在 cue-effects：这里只把当拍 props 交过去。
    useCueEffects(hub, props);
    // 动画流比指令处理晚一步创建：它要读工作状态，也要经 hub 说话与恢复档位。
    const flow = useAnimationFlow(hub, workStatus);
    liveRef.current.flow = flow;

    // 睡觉：宿主写叶子、渲染端执行；只在叶子变化时推一次（未变化的重渲染不重播动画）。
    useEffect(() => {
      if (sleep) flow.applySleep(sleep);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按叶子变化次数触发，sleep 是当拍快照
    }, [sleepTick]);

    const stageStyle = petStageStyle(dragging, bottomPad);
    const rootStyle = petRootStyle(
      customPos,
      { width: window.innerWidth, height: window.innerHeight },
      { h: halfH, w: halfW },
    );

    return {
      // 气泡单槽：四种气泡共用同一套定位，按优先级只挂一个。
      bubble: bubbles.node(),
      corner,
      facing,
      fontBubblePx: fontPx.bubble,
      fontTipPx: fontPx.tip,
      marginX: margin.x,
      marginY: margin.y,
      name: cfg.name,
      onClick: () => {
        // 拖拽守卫必须在睡觉分支之前：指针捕获后浏览器一定会在松手时补发一次 click，
        // 它不是点击（拖了多久都一样）。醒着时这条由 drag.onClick 内部判，睡觉分支绕过了那里。
        if (drag.justDragged() || drag.isActive()) return;
        const phase = liveRef.current.flow?.sleepPhase() ?? null;
        // 真睡着（循环中或醒来过渡）：点一下 = 叫醒。挤压与音效照常，
        // 但不播点击回应动画——这一下的产物是「起来」。
        if (phase !== null && phase !== 'start') {
          const front = ownAnim.frontVideo();
          if (front) liveRef.current.squash.start(front);
          playClickSound();
          void postAction(ROUTE_PATH + '/wake?pet=' + encodeURIComponent(cfg.id));
          return;
        }
        // 入睡过渡里被点：这次入睡作废，按普通点击处理（挤压 + 音效 + 点击回应），不再播「起来」
        if (phase === 'start') void postAction(ROUTE_PATH + '/wake?pet=' + encodeURIComponent(cfg.id));
        drag.onClick();
      },
      onContextMenu: entry.handleContextMenu,
      onPointerDown: drag.onPointerDown,
      onPointerEnter: entry.onPointerEnter,
      onPointerLeave: entry.onPointerLeave,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      rootRef,
      rootStyle,
      size,
      stageRef,
      stageStyle,
      tipOn,
      tipRef,
      videoARef,
      videoBRef,
    };
  };
}
