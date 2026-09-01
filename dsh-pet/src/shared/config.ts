// 配置层（src/shared 单一来源，浏览器 bundle 与桌面 shared-core 共用）：
// 配置的读取/合并/校验收敛在 host（src/host/config.ts 的 readAllConfig，经
// GET /dsh-pet-7340/config 暴露成品）；本模块只做一件事：把**成品聚合**
// （{ main: {...}, test1: {...}, ... }，字段已填满、绝对正确）拍平成渲染用宠物列表，
// 条目级字段（animations / animationWeights / eventsRefreshSec / physics）吹进每只实例。
// 不依赖 React/DOM；host 因 DSH 单文件加载约束不 import 本目录。
import type { Animations, Pet, PetDisplay, PhysicsParams, Weights } from './types';

/** 显示位置白名单 */
export const PET_DISPLAYS: PetDisplay[] = ['web', 'desktop', 'both', 'none'];

/** 该宠物是否参与浏览器 overlay 渲染 */
export const isWebVisible = (display: PetDisplay): boolean => display === 'web' || display === 'both';

/** 该宠物是否参与桌面模式（Electron 透明窗）渲染 */
export const isDesktopVisible = (display: PetDisplay): boolean => display === 'desktop' || display === 'both';

/** 把 host 的成品聚合拍平成渲染用宠物列表：
 *  条目级字段（animations / animationWeights / eventsRefreshSec / physics——合并器已填默认）吹进每只实例；
 *  assetRoot = 条目 key（= 素材根，多实例共享）；非 main 条目的实例打 extra 标记
 *  （文件宠物：设置页不可编辑、保存时排除）。 */
export function flattenConfigPets(merged: Record<string, Record<string, unknown>>): Pet[] {
  const out: Pet[] = [];
  for (const [entry, conf] of Object.entries(merged)) {
    const list = Array.isArray(conf?.pets) ? (conf.pets as Pet[]) : [];
    for (const p of list) {
      out.push({
        ...p,
        animations: conf.animations as Animations | undefined,
        animationWeights: conf.animationWeights as Weights | undefined,
        eventsRefreshSec: conf.eventsRefreshSec as Record<string, number> | undefined,
        physics: conf.physics as PhysicsParams | undefined,
        assetRoot: entry,
        extra: entry !== 'main',
      });
    }
  }
  return out;
}
