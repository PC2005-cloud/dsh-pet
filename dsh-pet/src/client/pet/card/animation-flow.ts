/**
 * 动画流：碎碎念联动、随机链掷骰、互动结束后恢复档位循环，以及播完判定的落地。
 * 不负责判定本身（播完分支在 animation/cues，选下一段在 animation/next-animation），也不持有动画链。
 * 依赖卡运行时与当前工作状态；工作状态用 ref 镜像，因为播完回调晚于状态更新。
 * 不变量：冻结期间随机链与档位恢复都不动手；换源后必须递增序号，否则同段重播不会生效。
 * @module dsh-pet/src/client/pet/card/animation-flow
 */
import { pick, pickSlot, rollKind } from '../../../shared/pickers.ts';
import type { SleepState } from '../../../shared/state.ts';
import { WORK_STATUS_INDEX } from '../../../shared/work-status.ts';
import { decideNextAnimation } from '../animation/next-animation.ts';
import { createSleepMachine } from './sleep-machine.ts';
import type { CardHub } from './hub.ts';
import type { EndedCue } from '../animation/cues.ts';
import type { WorkStatusSnapshot } from '../../../shared/work-status.ts';
import type * as ReactNS from 'react';

/** 动画流对外的动作面。 */
export interface AnimationFlow {
  /** 按播完判定改状态；回执与门禁已在动画链里处理过。 */
  applyEndedCue(cue: EndedCue): void;
  /** 按权重掷骰选下一段自播动画。 */
  pickNext(): void;
  /** 非终态工作状态回到档位循环；没有可恢复状态时返回 false。 */
  resumeWorkStatusAnim(): boolean;
  /** 说一句：抽碎碎念动画并弹气泡，动画与气泡时长互相独立。 */
  speak(text: string, image?: string, url?: string, duration?: number, anim?: boolean): void;
  /** 应用宿主写的睡觉状态：进入 → 播开始；退出 → 播起来。 */
  applySleep(state: SleepState): void;
  /** 此刻是否在睡（含入睡与醒来两段过渡）。 */
  sleeping(): boolean;
  /** 当前睡觉阶段；醒着为 null。点击路径要区分「入睡过渡」与「真睡着」。 */
  sleepPhase(): 'start' | 'loop' | 'end' | null;
}

/** 注入的 react 能力。 */
export interface AnimationFlowRuntime {
  /** 引用；工作状态的镜像。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 日志行的时刻前缀。 */
const stamp = (): string => new Date().toTimeString().slice(0, 8);

/** 一行带时刻与宠物 id 的日志。 */
const log = (petId: string, message: string): void => {
  console.log('[dsh-pet] ' + stamp() + ' pet=' + petId + ' ' + message);
};

/**
 * 制造动画流的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收运行时与工作状态的 hook；回调里读 ref，不会读到旧值。
 */
export function createAnimationFlow(rt: AnimationFlowRuntime) {
  const { useRef } = rt;

  return function useAnimationFlow(hub: CardHub, workStatus: WorkStatusSnapshot | null): AnimationFlow {
    // 播完回调晚于状态更新：镜像当前值，避免闭包读到注册那一刻的状态。
    const workStatusRef = useRef(workStatus);
    workStatusRef.current = workStatus;

    // 睡觉交给独立状态机：这里只装配并转发（pickNext 在下方定义，状态机只持有引用，调用发生在播完之后）。
    // 必须放 ref：状态机持有「当前阶段」，放函数体局部变量会在每次渲染重建，睡觉状态当场丢失
    // （视频还在睡姿、菜单却显示「睡觉」，点它也不叫醒）。
    const machineRef = useRef<ReturnType<typeof createSleepMachine> | null>(null);
    const sleep = (): ReturnType<typeof createSleepMachine> =>
      (machineRef.current ??= createSleepMachine(hub, pickNext, log));
    /** 此刻是否在睡（含两段过渡）。 */
    const sleeping = (): boolean => sleep().sleeping();
    /** 当前睡觉阶段；醒着为 null。 */
    const sleepPhase = (): 'start' | 'loop' | 'end' | null => sleep().phase();
    /** 应用宿主写的睡觉状态（转发给状态机）。 */
    const applySleep = (state: SleepState): void => sleep().apply(state);
    /** 非终态工作状态回到档位循环；冻结、空闲与终态都返回 false。 */
    const resumeWorkStatusAnim = (): boolean => {
      const card = hub.card;
      // 锁定期间不由这条路恢复档位动画；解冻路径会先解除冻结再调用。
      if (hub.ownAnim.isFrozen()) return false;
      // 睡觉期间不恢复档位动画：工作状态照旧在跑，但睡着就是不看不听。
      if (sleeping()) return false;
      const ws = workStatusRef.current;
      if (!ws || !ws.state || ws.state === 'success' || ws.state === 'error') return false;
      const pool = hub.anims().events?.workStatus;
      if (!pool || pool.length === 0) return false;
      const idx = WORK_STATUS_INDEX[ws.state];
      const slot = pool[idx];
      if (slot === undefined) return false;
      const name = pickSlot(slot, card.animRef.current); // 档内随机抽 1，并避开当前正播动画。
      log(hub.cfg().id, '互动结束恢复状态动画: ' + name);
      // 多候选档位恢复后同样走播完轮换；单候选维持无限循环。
      card.actions.setOnce(Array.isArray(slot) && slot.length > 1);
      card.actions.setAnim(name);
      return true;
    };

    /** 按权重掷骰选择下一段自播动画。 */
    const pickNext = (): void => {
      const card = hub.card;
      // 占用锁：随机链唯一入口不掷骰，随机动画、转向、走位一起停住。
      if (hub.ownAnim.isFrozen()) return;
      // 睡觉：随机链彻底停住（不掷骰、不转向、不走位），醒来由 applySleep 的 end 段收尾
      if (sleeping()) return;
      const roll = Math.random();
      // 宠物固定时，掷骰把「转向/移动」权重按 0 算；菜单点播与显式点播不走这里。
      const kind = rollKind(roll, hub.cfg().animationWeights, { fixed: hub.cfg().fixedEnabled });
      // 只有掷到 move 档才试走位：占用中返回 true（已有移动在跑），无法移动返回 false。
      const move = kind === 'move' ? hub.tryWalk() : undefined;
      const decision = decideNextAnimation({
        kind,
        animations: hub.anims(),
        facing: card.facingRef.current,
        current: card.animRef.current,
        move,
      });
      log(
        hub.cfg().id,
        'facing=' +
          card.facingRef.current +
          ' roll=' +
          roll.toFixed(4) +
          ' -> [' +
          decision.kind +
          '] ' +
          (decision.anim ?? '移动进行中(不重播)'),
      );
      if (decision.play && decision.anim !== null) card.actions.setAnim(decision.anim);
      card.actions.setOnce(true);
      card.actions.bumpSeq();
    };

    /** 按播完判定改状态。 */
    const applyEndedCue = (cue: EndedCue): void => {
      const card = hub.card;
      // 睡觉的三段推进与「起来播完回随机链」都在状态机里：它说这次 ended 归它管就直接返回。
      if (sleep().consumeEnded()) return;
      if (cue.kind === 'ignore') return;
      if (cue.kind === 'work-rotate') {
        card.actions.setOnce(true); // 保持 once=true，下一段播完再轮换。
        card.actions.setAnim(cue.anim);
        card.actions.bumpSeq();
        return;
      }
      if (cue.kind === 'work-replay') {
        card.actions.setOnce(false);
        card.actions.bumpSeq();
        return;
      }
      if (cue.kind === 'event-done') {
        // 事件动画抢占播完后立即恢复档位循环，否则长事件期间会误入随机链。
        if (resumeWorkStatusAnim()) return;
        if (hub.anims().idle.length) card.actions.setAnim(pick(hub.anims().idle, card.animRef.current));
        card.actions.setOnce(true);
        card.actions.bumpSeq();
        return;
      }
      if (cue.kind === 'turn') {
        const next = card.state.facing === 'left' ? 'right' : 'left';
        card.actions.setFacing(next);
        card.facingRef.current = next; // 立即同步：翻转后的掷骰用新朝向过滤。
        // 翻面不改 anim/once/seq，换源 effect 不会重跑：不显式回链，随机链就此停在末帧。
        pickNext();
        return;
      }
      if (cue.kind === 'interaction-done') {
        // 互动动画播完：非终态恢复状态循环，否则回 idle。
        if (resumeWorkStatusAnim()) return;
        if (hub.anims().idle.length) card.actions.setAnim(pick(hub.anims().idle, card.animRef.current));
        card.actions.setOnce(true);
        card.actions.bumpSeq();
        return;
      }
      pickNext();
    };

    /** 说一句：抽碎碎念动画并弹气泡，两者独立。 */
    const speak = (text: string, image?: string, url?: string, duration?: number, anim?: boolean): void => {
      const card = hub.card;
      let name: string | null = null;
      // 睡着时只弹气泡、不换动画：梦话与命令气泡都要显示，但睡姿不能被打断
      if (anim !== false && !sleeping()) {
        const pool = hub.anims().events?.whisper;
        if (!pool || pool.length === 0) {
          console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
          return;
        }
        // 整池随机抽 1 槽并避开当前正播动画；槽位为数组时再在档内随机。
        name = pickSlot(pick(pool, card.animRef.current), card.animRef.current);
      }
      log(hub.cfg().id, 'whisper' + (name === null ? ' （不联动动画）' : ' -> [' + name + ']') + ' 「' + text + '」');
      // 先起动画：动画与气泡时长是两个独立参数。
      if (name !== null) {
        hub.stopMotion();
        card.actions.setOnce(true);
        card.actions.setAnim(name);
      }
      hub.bubbles.showWhisper(text, { image, url }, duration);
    };

    return { applyEndedCue, applySleep, pickNext, resumeWorkStatusAnim, sleepPhase, sleeping, speak };
  };
}
