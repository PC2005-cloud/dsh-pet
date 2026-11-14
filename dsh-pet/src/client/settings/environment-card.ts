/**
 * 环境卡：天气查哪个城市。留空 = 跟随出口 IP 自动定位，填了就按城市名查。
 *
 * 「检测」按钮走宿主已有的环境查询，把当前 IP 定位结果回填到输入框——IP 库把家宽
 * 标到省会或邻市时，用户能先看到它认为你在哪，再改成真实城市。
 * 修改只进本地状态、随「保存」整包写入，不即时写盘。
 * @module dsh-pet/src/client/settings/environment-card
 */
import type { FunctionComponent } from 'react';
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit } from './ui.ts';

/** 环境卡的输入。 */
export interface EnvironmentCardProps {
  /** 保存中或配置未就绪时禁用输入框与检测按钮。 */
  readonly busy: boolean;
  /** 当前城市覆盖；空串表示跟随 IP 自动定位。 */
  readonly city: string;
  /** 改城市覆盖。 */
  readonly onChange: (city: string) => void;
}

/**
 * 查一次宿主环境，取当前 IP 定位到的城市。
 *
 * 不带 `pet` 参数 = 纯查询，不写轮询状态、不点亮任何气泡。
 * 带 `ip=1` 才会忽略配置里已填的城市——否则它回显的就是用户自己填的值。
 * 带 `fresh=1` 跳过缓存，拿的是此刻的定位而不是十分钟前的。
 *
 * @returns 城市名；查询失败或宿主没给城市时 `null`。
 */
export async function detectEnvironmentCity(): Promise<string | null> {
  try {
    const response = await fetch(ROUTE_PATH + '/environment?fresh=1&ip=1', { method: 'POST' });
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: unknown; city?: unknown };
    if (body.ok === false) return null;
    return typeof body.city === 'string' && body.city.trim() !== '' ? body.city : null;
  } catch {
    return null;
  }
}

/**
 * 造环境卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeEnvironmentCard(rt: SettingsRuntime): FunctionComponent<EnvironmentCardProps> {
  const { h, t, useState } = rt;
  const { cardHead, field } = makeUiKit({ h, t });

  return function EnvironmentCard(props: EnvironmentCardProps) {
    const [detecting, setDetecting] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });

    // 回填后不自动保存：用户可能还要改，保存统一走页面底部的「保存」。
    const detect = (): void => {
      setDetecting(true);
      setFeedback({ kind: '', text: '' });
      void (async () => {
        try {
          const city = await detectEnvironmentCity();
          if (city === null) {
            setFeedback({ kind: 'err', text: t('environmentDetectFailed') });
            return;
          }
          props.onChange(city);
          setFeedback({ kind: 'ok', text: t('environmentDetected').replace('{city}', city) });
        } finally {
          setDetecting(false);
        }
      })();
    };

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('environmentTitle'), t('environmentHint')),
        field(
          t('environmentCityLabel'),
          h('div', {
            className: 'dsh-pet-cfg__row',
            children: [
              h('input', {
                key: 'i',
                type: 'text',
                className: INPUT_CLASS,
                value: props.city,
                placeholder: t('environmentCityPlaceholder'),
                disabled: props.busy,
                // 手改即清掉上一次的检测结果，免得「已填入」与框里的值对不上。
                onChange: (e: { target: { value: string } }) => {
                  setFeedback({ kind: '', text: '' });
                  props.onChange(e.target.value);
                },
              }),
              h('button', {
                key: 'b',
                type: 'button',
                className: 'dsh-pet-cfg__btn is-sm',
                disabled: props.busy || detecting,
                onClick: detect,
                children: t('environmentDetect'),
              }),
            ],
          }),
          t('environmentCityHint'),
        ),
        feedback.text
          ? h('span', {
              className: 'dsh-pet-cfg__msg' + (feedback.kind === 'err' ? ' is-err' : ''),
              children: feedback.text,
            })
          : null,
      ],
    });
  };
}
