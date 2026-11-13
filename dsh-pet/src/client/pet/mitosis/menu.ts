/**
 * 有丝分裂的右键菜单项：本体两条（清除所有分裂体 + 模式），分身一条（删除我）。
 *
 * 纯构建：不派发、不判状态、不读 DOM；动作名是 shared/menu 叶子词汇表里的四条，
 * 落地的副作用在 menu-actions 的分支里。
 * 不变量：条数与文案只随 mode 与 cloneCount 变，切换模式不会让菜单位置跳动。
 * @module dsh-pet/src/client/pet/mitosis/menu
 */
import { MITOSIS_CAP, type MitosisMode } from './rules.ts';
import type { MenuNode } from '../../../shared/menu.ts';

/** 两种模式各自的菜单文案主干：上限写进 label，切之前就能看见代价。 */
const MODE_LABELS: Readonly<Record<MitosisMode, string>> = {
  normal: '普通模式 · 上限 ' + MITOSIS_CAP.normal,
  collide: '碰撞模式 · 上限 ' + MITOSIS_CAP.collide + ' · 互撞',
};

/** 模式 → 菜单动作名（叶子 action 是闭合联合，这里只能是它登记过的四条之一）。 */
const MODE_ACTIONS: Readonly<Record<MitosisMode, 'mitosis-normal' | 'mitosis-collide'>> = {
  normal: 'mitosis-normal',
  collide: 'mitosis-collide',
};

/**
 * 本体右键菜单尾部的两条。
 *
 * @param mode - 当前模式（决定哪一项带「（当前）」）。
 * @param cloneCount - 现有分身只数；0 时清除项写成「暂无」而不是消失。
 * @returns 挂在菜单树尾部的节点列表。
 */
export const mainBranch = (mode: MitosisMode, cloneCount: number): MenuNode[] => [
  {
    label: cloneCount > 0 ? '清除所有分裂体（' + cloneCount + ' 只）' : '清除所有分裂体（暂无）',
    action: 'mitosis-clear',
  },
  {
    label: '模式',
    children: (Object.keys(MODE_LABELS) as MitosisMode[]).map((target) => ({
      label: MODE_LABELS[target] + (target === mode ? '（当前）' : ''),
      action: MODE_ACTIONS[target],
    })),
  },
];

/**
 * 分身右键菜单：只有删除自己，余额、显示位置、回到初始位置这些归本体管。
 *
 * @returns 单节点列表，直接拼在分身菜单树末尾。
 */
export const cloneBranch = (): MenuNode[] => [{ label: '删除我', action: 'mitosis-delete' }];
