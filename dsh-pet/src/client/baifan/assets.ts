/**
 * 「吃白饭」的动画地址：把配置 animations.baifan 的 5 个名字拼成点播地址。
 *
 * 与插件其他动画同一条路（./pet/animation/assets 的 animationAssetUrl），素材根与动画名都编码；
 * 点播接口的 url 形态只收完整 http(s) 地址，所以这里补上 origin。
 * 槽位顺序是玩法契约：跑向底部 / 追饭侧身跑 / 期待 / 吃碗饭 / 吃饭团。
 * @module dsh-pet/src/client/baifan/assets
 */
import { ANIMATION_EXT } from '../../shared/constants.ts';
import { animationAssetUrl } from '../pet/animation/assets.ts';

/** 一场演出要用的五段动画。 */
export interface ActivityAssets {
  /** 跑向屏幕底部（一次性）。 */
  descend: string;
  /** 追饭时的侧身跑（循环）。 */
  chase: string;
  /** 到位后等开饭（一次性）。 */
  expect: string;
  /** 吃到碗饭。 */
  eatBowl: string;
  /** 吃饭团。 */
  eatBall: string;
}

/**
 * 按配置拼五段动画的地址。
 *
 * @param names - `animations.baifan` 的 5 个动画名（顺序即槽位）。
 * @param assetRoot - 被点宠物所属条目的素材根。
 * @param id - 宠物 id；素材根为空时的兜底。
 * @returns 五段动画的完整 http(s) 地址。
 */
export function activityAssets(names: readonly string[], assetRoot: string, id: string): ActivityAssets {
  const url = (anim: string): string =>
    window.location.origin + animationAssetUrl({ assetRoot, id, anim, ext: ANIMATION_EXT });
  return {
    descend: url(names[0] ?? ''),
    chase: url(names[1] ?? ''),
    expect: url(names[2] ?? ''),
    eatBowl: url(names[3] ?? ''),
    eatBall: url(names[4] ?? ''),
  };
}
