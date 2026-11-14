/**
 * 卡片装配根的迟绑槽：动画链、运动驱动与浮层动作在创建上有先后，却要互相取值。
 * 只在 card-runtime 里填充；消费方都在渲染之后的回调里读，渲染期间不读。
 * 不负责状态：这里全是驱动实例与调用入口，响应式状态归 card-state。
 * @module dsh-pet/src/client/pet/card/live
 */
import type { OwnAnimation } from '../animation/animation.ts';
import type { AnimationFlow } from './animation-flow.ts';
import type { Drag } from '../motion/drag.ts';
import type { Flight } from '../motion/flight.ts';
import type { PositionFollow } from '../motion/position-follow.ts';
import type { SquashDriver } from '../motion/squash.ts';
import type { Walk } from '../motion/walk.ts';

/** 装配根迟绑的驱动与服务：先创建的一方经它回调后创建的一方。 */
export interface CardLive {
  /** 动画链：先于运动驱动创建，回调里要读走位、拖拽与挤压。 */
  ownAnim: OwnAnimation;
  /** 走位。 */
  walk: Walk;
  /** 抛掷飞行。 */
  flight: Flight;
  /** 位置跟随。 */
  posFollow: PositionFollow;
  /** 指针拖拽。 */
  drag: Drag;
  /** Q 弹挤压。 */
  squash: SquashDriver;
  /** 当前飞行倾斜角（°）；抛掷每帧写入，停飞清零；换源 / squash 读它拼 transform。 */
  tiltDeg: number;
  /** 动画流：指令处理之后创建，拖拽与本地解冻要经它恢复档位。 */
  flow: AnimationFlow | null;
  /** 当前宠物中心的视口坐标（含角落兜底）。 */
  center: () => { x: number; y: number };
  /** 停走位与位置跟随。 */
  stopMove: () => void;
  /** 把悬浮提示摆到光标旁。 */
  placeTip: (x: number, y: number) => void;
  /** 悬浮提示当前是否点亮。 */
  tipOn: () => boolean;
  /** 本地解冻并释放宿主锁。 */
  releaseLock: () => void;
}
