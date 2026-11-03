/**
 * 动作频率卡（main 条目）：待机 / 转向 / 移动三个权重可改，随机动作只读自动算。
 * 只改本地状态，随「保存」整包写入；合计锁在 100%，改一项时其余不动、随机动作吸收差额。
 * 写的是 main 条目，作为所有宠物的全局默认；pet pack 可在自己种类文件里覆盖。
 * @module dsh-pet/src/client/settings/motion-card
 */
import type { FunctionComponent } from 'react';
import type { Weights } from '../../shared/types.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit, numberInputProps } from './ui.ts';
import { actionPercent, WEIGHT_KEYS, withWeight } from '../../shared/weights.ts';

/** 动作频率卡的输入。 */
export interface MotionCardProps {
  /** 保存中或配置未就绪时禁用全部输入。 */
  busy: boolean;
  /** 当前三项权重（随机动作是余量，不在这里）。 */
  weights: Weights;
  /** 改其中一项后的完整权重。 */
  onChange: (weights: Weights) => void;
}

/**
 * 造动作频率卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeMotionCard(rt: SettingsRuntime): FunctionComponent<MotionCardProps> {
  const { h, t } = rt;
  const { cardHead, field } = makeUiKit({ h, t });

  return function MotionCard(props: MotionCardProps) {
    const { busy, weights } = props;
    // 三个可编辑权重：改一项时另两项不动，夹取规则在 weights.withWeight。
    const weightFields = WEIGHT_KEYS.map((key) =>
      field(
        t('motion.' + key),
        h(
          'input',
          numberInputProps(weights[key], (value) => props.onChange(withWeight(weights, key, value)), {
            step: '1',
            min: '0',
            max: '100',
            disabled: busy,
          }),
        ),
      ),
    );
    // 随机动作只读：由 100 − 三项之和算出，不给输入入口。
    const actionField = field(
      t('motion.action'),
      h('input', {
        className: INPUT_CLASS,
        type: 'number',
        value: actionPercent(weights),
        readOnly: true,
        tabIndex: -1,
        'aria-label': t('motion.action'),
      }),
    );
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('motionTitle'), t('motionHint')),
        h('div', { className: 'dsh-pet-cfg__grid4', children: [...weightFields, actionField] }),
      ],
    });
  };
}
