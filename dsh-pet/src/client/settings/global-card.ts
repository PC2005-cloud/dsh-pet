/**
 * 全局开关卡：通知、前台聚焦也提醒、点击音效、锁定在当前屏幕与系统托盘。
 * 切换只改本地状态，随「保存」整包写入——即时写盘会重启桌面 Helper、重建全部桌面宠物窗口。
 * 通知开关额外需要用户手势，开与关都要走外壳的同一个入口，因此卡里只回传键名与目标值。
 * @module dsh-pet/src/client/settings/global-card
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

/** 五个全局开关的键名，与成品配置的字段名一致。 */
export type GlobalFlagKey =
  'notificationsEnabled' | 'notifyWhenFocused' | 'clickSoundEnabled' | 'confineToScreen' | 'trayEnabled';

/** 五个全局开关的当前值。 */
export type GlobalFlags = Record<GlobalFlagKey, boolean>;

/** 全局开关卡的输入。 */
export interface GlobalCardProps {
  /** 保存中或配置未就绪时禁用全部开关。 */
  busy: boolean;
  /** 当前值。 */
  values: GlobalFlags;
  /** 某个开关被切换；通知开关的权限申请由外壳处理。 */
  onChange: (key: GlobalFlagKey, value: boolean) => void;
}

/** 开关的展示顺序与文案键。 */
const TOGGLES: Array<{ key: GlobalFlagKey; label: string }> = [
  { key: 'notificationsEnabled', label: 'notifyToggle' },
  { key: 'notifyWhenFocused', label: 'notifyWhenFocusedToggle' },
  { key: 'clickSoundEnabled', label: 'clickSoundToggle' },
  { key: 'confineToScreen', label: 'confineToggle' },
  { key: 'trayEnabled', label: 'trayToggle' },
];

/**
 * 造全局开关卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeGlobalCard(rt: SettingsRuntime): FunctionComponent<GlobalCardProps> {
  const { h, t } = rt;
  const { cardHead, toggleCell } = makeUiKit({ h, t });

  return function GlobalCard(props: GlobalCardProps) {
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('globalTitle'), t('globalHint')),
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: TOGGLES.map((toggle) =>
            toggleCell(toggle.label, props.values[toggle.key], props.busy, (value) =>
              props.onChange(toggle.key, value),
            ),
          ),
        }),
      ],
    });
  };
}
