/**
 * 一张宠物卡的响应式状态与写入口：动画、朝向、提示与自定义位置。
 * 不负责派生几何（geometry 负责）与驱动实例（由装配根持有），也不做任何判定。
 * 依赖注入的 react；状态只在卡内使用，跨卡不共享。
 * 不变量：anim / once / seq 三者共同决定是否换源，只改其中一个会走进防重分支。
 * @module dsh-pet/src/client/pet/card/state
 */
import type { Center } from '../motion/geometry.ts';
import type { Corner } from '../../../shared/types.ts';
import type { PetFacing } from '../../../shared/state.ts';
import type * as ReactNS from 'react';

/** 一张宠物卡的状态。 */
export interface CardState {
  /** 当前动画名，可能是一段绝对地址。 */
  anim: string;
  /** 这段只播一次；false 表示循环。 */
  once: boolean;
  /** 换源序号：同一动画重播时靠它强制再走一遍换源。 */
  seq: number;
  /** 点播编号，随 anim 下发给回执关联；自播换源时必须清空。 */
  cuePlayback: string | null;
  /** 朝向，决定镜像与走位方向。 */
  facing: PetFacing;
  /** 悬浮提示显隐。 */
  tipOn: boolean;
  /** 用户拖拽后的归一化中心；null 表示仍按角落定位。 */
  customPos: Center | null;
  /** 宠物宽度（px）；配置镜像，设置页改尺寸时跟随。 */
  size: number;
  /** 角落定位。 */
  corner: Corner;
  /** 角落边距（px）。 */
  margin: { x: number; y: number };
}

/** 状态写入口；只读的消费方拿 state 即可。 */
export interface CardStateActions {
  /** 换成指定动画。 */
  setAnim(anim: string): void;
  /** 设置是否只播一次。 */
  setOnce(once: boolean): void;
  /** 递增换源序号，强制重播当前动画。 */
  bumpSeq(): void;
  /** 设置点播编号；自播换源传 null。 */
  setCuePlayback(id: string | null): void;
  /** 设置朝向。 */
  setFacing(facing: PetFacing): void;
  /** 设置提示显隐。 */
  setTipOn(on: boolean): void;
  /** 设置归一化中心；null 表示回到角落定位，也接受函数式更新以强制重排。 */
  setCustomPos(pos: ReactNS.SetStateAction<Center | null>): void;
  /** 设置宠物宽度。 */
  setSize(size: number): void;
  /** 设置角落。 */
  setCorner(corner: Corner): void;
  /** 设置角落边距。 */
  setMargin(margin: { x: number; y: number }): void;
  /**
   * 一次换源：设置动画与播放方式，可选强制重播。
   *
   * @param anim - 要播的动画名或绝对地址。
   * @param opts - once 缺省 true；replay 为 true 时递增序号强制再走一遍；cue 为点播编号。
   */
  play(anim: string, opts?: { once?: boolean; replay?: boolean; cue?: string | null }): void;
}

/** 卡状态容器：状态、写入口与三个随状态同步的 ref。 */
export interface CardStateApi {
  /** 当帧状态。 */
  state: CardState;
  /** 写入口。 */
  actions: CardStateActions;
  /** 当前动画名的最新值；驱动与回调读它，避免闭包读到旧值。 */
  animRef: ReactNS.MutableRefObject<string>;
  /** 朝向的最新值。 */
  facingRef: ReactNS.MutableRefObject<PetFacing>;
  /** 归一化中心的最新值。 */
  customPosRef: ReactNS.MutableRefObject<Center | null>;
}

/** 注入的 react 能力。 */
export interface CardStateRuntime {
  /** 状态。 */
  useState: <T>(init: T) => [T, ReactNS.Dispatch<ReactNS.SetStateAction<T>>];
  /** 引用。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 初始值：尺寸、首播动画、角落与边距都来自成品配置。 */
export interface CardStateInit {
  /** 宠物宽度（px）。 */
  size: number;
  /** 首播动画名。 */
  anim: string;
  /** 角落定位。 */
  corner: Corner;
  /** 角落边距（px）。 */
  margin: { x: number; y: number };
}

/**
 * 制造卡状态容器的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收初始值的 hook；状态与 ref 在卡内跨渲染保留。
 */
export function createCardState(rt: CardStateRuntime) {
  const { useState, useRef } = rt;

  return function useCardState(init: CardStateInit): CardStateApi {
    const [anim, setAnim] = useState(init.anim);
    const [once, setOnce] = useState(true);
    const [seq, setSeq] = useState(0);
    const [cuePlayback, setCuePlayback] = useState<string | null>(null);
    const [facing, setFacing] = useState<PetFacing>('left');
    const [tipOn, setTipOn] = useState(false);
    const [customPos, setCustomPos] = useState<Center | null>(null);
    const [size, setSize] = useState(init.size);
    const [corner, setCorner] = useState<Corner>(init.corner);
    const [margin, setMargin] = useState(init.margin);

    // ref 是状态的镜像：驱动与事件回调在闭包外读它们，不能等到下一帧。
    const animRef = useRef(anim);
    animRef.current = anim;
    const facingRef = useRef(facing);
    facingRef.current = facing;
    const customPosRef = useRef(customPos);
    customPosRef.current = customPos;

    const bumpSeq = () => setSeq((s) => s + 1);
    const play: CardStateActions['play'] = (next, opts) => {
      setAnim(next);
      setOnce(opts?.once ?? true);
      if (opts?.replay) bumpSeq();
      if (opts?.cue !== undefined) setCuePlayback(opts.cue);
    };

    return {
      actions: {
        bumpSeq,
        play,
        setAnim,
        setCorner,
        setCuePlayback,
        setCustomPos,
        setFacing,
        setMargin,
        setOnce,
        setSize,
        setTipOn,
      },
      animRef,
      customPosRef,
      facingRef,
      state: { anim, corner, cuePlayback, customPos, facing, margin, once, seq, size, tipOn },
    };
  };
}
