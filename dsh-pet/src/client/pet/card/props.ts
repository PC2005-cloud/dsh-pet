/**
 * 单只宠物的渲染输入：容器把 /state 叶子分发成这些字段，卡片只读不写。
 * 字段全部来自容器（轮询、配置、碰撞站场），卡片内部不订阅事件——它只负责渲染与响应，
 * 需要改 React 状态时走自己的 setter，不向上要回调。
 * @module dsh-pet/src/client/pet/card/props
 */
import type * as ReactNS from 'react';
import type { BalanceState } from '../../../shared/balance/index.ts';
import type { PetCollisionSlot } from '../../../shared/physics.ts';
import type { LockState, PositionMode, SayCue, PetFacing, SleepState, EnvState } from '../../../shared/state.ts';
import type { MenuMoreItem } from '../../../shared/menu.ts';
import type { WorkStatusSnapshot } from '../../../shared/work-status.ts';
import type { MitosisMode, MitosisRole } from '../mitosis/rules.ts';
import type { Center } from '../motion/geometry.ts';
import type { RuntimePet } from '../types.ts';

/** 一张宠物卡的渲染输入。 */
export interface PetCardProps {
  /** 成品配置。 */
  cfg: RuntimePet;
  /** 最近一次余额结果。 */
  balance: BalanceState | null;
  /** 余额成功拉取次数，变化时播档位动画。 */
  balanceTick: number;
  /** 余额不可用提示次数。 */
  balanceNoticeTick: number;
  /** 本次余额是否由用户手动请求；手动请求即使关闭 balanceEnabled 也答复。 */
  balanceManual: boolean;
  /** 本次余额「给谁看」：有值且不是本宠物时只更新数据、不弹气泡；缺省 = 不分组。 */
  balancePetId?: string;
  /** 最近一次环境结果；只有 petId 与本宠物相符时容器才传（环境是机器级事实，一只一份气泡）。 */
  env?: EnvState;
  /** 环境叶子变化次数。 */
  envTick: number;
  /** 工作状态快照。 */
  workStatus: WorkStatusSnapshot | null;
  /** 工作状态变化次数。 */
  workStatusTick: number;
  /** 点工作气泡时跳到它所属会话；缺省即气泡不可点（桌面端由容器转发）。 */
  onFocusSession?: (sessionId: string) => void;
  /** 本宠物的说话指令；kind 为 clear 时收起气泡，其余弹气泡。 */
  say?: SayCue & { seq: number };
  /** 说话指令变化次数。 */
  sayTick: number;
  /** 本宠物的点播指令：name 与 url 恰好一个；facing 未指定时保持当前朝向。 */
  animCue?: { name?: string; url?: string; seq: number; playbackId?: string; facing?: PetFacing };
  /** 点播指令变化次数。 */
  animCueTick: number;
  /** 本宠物的位置指令：x/y 是宠物中心的归一化坐标，duration 仅 line 模式有效。 */
  posCue?: { x: number; y: number; mode: PositionMode; duration: number; seq: number };
  /** 位置指令变化次数。 */
  posCueTick: number;
  /** 本宠物的抛掷指令：angle 单位为度，0 为正右、逆时针为正。 */
  throwCue?: { angle: number; power: number; seq: number };
  /** 抛掷指令变化次数。 */
  throwCueTick: number;
  /** 本宠物的占用锁；expiresAt 是唯一过期真相，宿主不会推「锁没了」。 */
  lock?: LockState;
  /** 锁叶子变化次数。 */
  lockTick: number;
  /** 本宠物的睡觉状态：三段名字由宿主挑定；睡着时随机链停住、自动来源闭嘴。 */
  sleep?: SleepState;
  /** 睡觉叶子变化次数。 */
  sleepTick: number;
  /** 第三方菜单项快照；传 ref 是因为只在右键那一刻读。 */
  menuItemsRef: ReactNS.MutableRefObject<MenuMoreItem[]>;
  /** 宠物间碰撞站场。 */
  arena: ReactNS.MutableRefObject<{ slots: Record<string, PetCollisionSlot> }>;
  /** 有丝分裂身份与通道；缺省 = 这张卡不参与分裂（没开分裂时就是缺省）。 */
  mitosis?: MitosisCardProps;
  /** 分身出生点（归一化中心）：首次渲染就按它定位，之后照常拖拽与飞行。本体不传。 */
  initialPos?: Center;
}

/** 一张卡在「有丝分裂」里的身份：本体与分身共用同一个宿主宠物 id，差别全在这里。
 *  分身只在渲染期存在——刷新回到一只；宿主侧的说话、点播、位置、抛掷、锁与睡觉仍按本体那一只分发，
 *  天然扇出到所有分身，所以这里不需要第二条总线。 */
export interface MitosisCardProps {
  /** 本体还是分身：决定菜单、描边、气泡归属与是否登记全局对话句柄。 */
  role: MitosisRole;
  /** 当前模式：写进 data-mitosis-mode，碰撞模式的描边范围不同。 */
  mode: MitosisMode;
  /** 碰撞站场槽键（也是 React key）：本体 = 宠物 id，分身 = `<id>~m<seq>`。 */
  slotKey: string;
  /** 角标数字（本体 1、分身 2..N）；null = 现在只有一只，不画。 */
  badge: number | null;
  /** 本体现在有几只分身：只用于菜单文案。 */
  cloneCount: number;
  /** 记一次点击：连够次数由容器分裂。只有本体带。 */
  onTap?: (now: number) => void;
  /** 清掉本体的全部分身。只有本体带。 */
  onClear?: () => void;
  /** 切分裂模式。只有本体带。 */
  onMode?: (mode: MitosisMode) => void;
  /** 分身删掉自己。只有分身带。 */
  onDelete?: () => void;
}
