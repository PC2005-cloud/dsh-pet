/**
 * 「吃白饭」要用的五段动画名：从配置 animations.baifan 按槽位取出。
 *
 * 只取名字，不拼地址——点播走 `/anim` 的 name 形态，地址由各端渲染器按宠物素材根拼
 * （网页端相对路径、桌面端用宿主下发的 BASE），因此不依赖页面 origin（桌面壳的 origin 不是 http）。
 * 槽位顺序是玩法契约：跑向屏幕底部 / 追饭侧身跑 / 期待 / 吃碗饭 / 吃饭团。
 * @module dsh-pet/src/client/baifan/assets
 */

/** 一场演出要用的五段动画名。 */
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
 * 按配置取五段动画名。
 *
 * @param names - `animations.baifan` 的 5 个动画名（顺序即槽位）。
 * @returns 五段动画名；配置缺项时为空串（调用方照旧点播，由宿主按名字校验）。
 */
export function activityAssets(names: readonly string[]): ActivityAssets {
  return {
    descend: names[0] ?? '',
    chase: names[1] ?? '',
    expect: names[2] ?? '',
    eatBowl: names[3] ?? '',
    eatBall: names[4] ?? '',
  };
}
