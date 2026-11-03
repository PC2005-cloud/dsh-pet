/**
 * 宠物卡的共享运行时：状态容器、各驱动与跨关注点动作的取值面。
 * 只声明契约，不构造实现——装配根用当帧闭包拼出来，全部按 getter 取，避免驱动读到旧值。
 * 依赖卡状态、动画链、气泡单槽与三条运动驱动。
 * 不变量：每次渲染重新绑定；消费方不得缓存整个 hub，只能在调用点取值。
 * @module dsh-pet/src/client/pet/card/hub
 */
import type { CardStateApi } from './state.ts';
import type { OwnAnimation } from '../animation/animation.ts';
import type { BubbleSlots } from './bubble-slots.ts';
import type { PositionFollow } from '../motion/position-follow.ts';
import type { Animations } from '../../../shared/types.ts';
import type { RuntimePet } from '../types.ts';

/** 依据名点播：与右键菜单同一套语义（文字类强制朝左、移动类会走位）。 */
export type PlayByName = (anim: string, playbackId?: string, keepFacing?: boolean) => void;

/** 说一句：文本与配图二选一，时长缺省用气泡默认值。 */
export type Speak = (text: string, image?: string, url?: string, duration?: number, anim?: boolean) => void;

/** 卡片运行时：跨关注点共享的那一份。 */
export interface CardHub {
  /** 成品配置的最新值。 */
  cfg(): RuntimePet;
  /** 该宠物的动画池（与 `cfg().animations` 同源，单独取出避免每次深取）。 */
  anims(): Animations;
  /** 卡片状态与写入口。 */
  card: CardStateApi;
  /** 动画链：换源、冻结、回执都在这里。 */
  ownAnim: OwnAnimation;
  /** 三种气泡的单槽。 */
  bubbles: BubbleSlots;
  /** 位置跟随的弹簧。 */
  posFollow: PositionFollow;
  /** 指针是否按着（抛掷指令要避让）。 */
  isDragging(): boolean;
  /** 停走位与位置跟随。 */
  stopMotion(): void;
  /** 抛掷指令：角度（度，0 为正右、逆时针为正）与力度倍率。 */
  applyThrow(angleDeg: number, power: number): void;
  /** 试发起一次自主走位：占用中返回 true，无法移动返回 false，成功返回动作名。 */
  tryWalk(): boolean | string;
  /** 依据名点播。 */
  playByName: PlayByName;
  /** 说一句。 */
  speak: Speak;
  /** 按概率弹一句台词气泡（内容 = learningTxt.json 随机一行，回退空内容（不弹气泡））。 */
  showLearningBubble(): void;
  /** 此刻是否在睡（含入睡/醒来两段过渡）：自动来源据此闭嘴，显式唤醒走菜单或点击。 */
  sleeping(): boolean;
  /** 此刻是否被占用锁冻结：锁的语义是「把控制权交给第三方」，睡觉闸门对它让路。 */
  locked(): boolean;
}
