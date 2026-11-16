/**
 * 「长期记忆」卡：用哪个记忆实现，以及内置 PowerContext 的连接参数。
 *
 * 实现 id 来自宿主注册表，不硬编码；地址、令牌、查询优化只属于 PowerContext，选中别家时整块不渲染。
 * 都只改本地状态，随「保存」整包写入；配置里是同一个 `memory` 段。
 * @module dsh-pet/src/client/settings/memory-card
 */
import type { FunctionComponent } from 'react';
import { POWERCONTEXT_MEMORY_ID } from '../../shared/memory.ts';
import type { PowerContextConfig } from '../../shared/memory.ts';
import { makeSelect } from './panel/select.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit } from './ui.ts';

/** 记忆卡的输入。 */
export interface MemoryCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  readonly busy: boolean;
  /** 当前记忆实现 id。 */
  readonly provider: string;
  /** 可选实现；为空时下拉只显示当前值（列表还没拉回来或拉取失败）。 */
  readonly providers: readonly { readonly id: string; readonly name: string }[];
  /** 切换记忆实现。 */
  readonly onProviderChange: (value: string) => void;
  /** PowerContext 连接参数；只有选中该实现时才有输入框。 */
  readonly powercontext: PowerContextConfig;
  /** 改 PowerContext 的某一项。 */
  readonly onPowerContextChange: (patch: Partial<PowerContextConfig>) => void;
}

/**
 * 造记忆卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeMemoryCard(rt: SettingsRuntime): FunctionComponent<MemoryCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });
  const Select = makeSelect(rt);

  return function MemoryCard(props: MemoryCardProps) {
    const { busy } = props;
    const isPowerContext = props.provider === POWERCONTEXT_MEMORY_ID;

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('memoryTitle'), t('memoryHint')),
        field(
          t('memoryProviderLabel'),
          h(Select, {
            label: t('memoryProviderLabel'),
            value: props.provider,
            options: props.providers.map((item) => ({ id: item.id, label: item.name })),
            disabled: busy,
            onChange: props.onProviderChange,
          }),
          t('memoryProviderHint'),
        ),
        // 地址与令牌属于 PowerContext 实现，选中别家时整块不渲染
        isPowerContext
          ? h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                field(
                  t('powercontextEndpointLabel'),
                  h('input', {
                    type: 'text',
                    className: INPUT_CLASS,
                    value: props.powercontext.endpoint,
                    disabled: busy,
                    autoComplete: 'off',
                    onChange: (e: { target: { value: string } }) =>
                      props.onPowerContextChange({ endpoint: e.target.value }),
                  }),
                  t('powercontextEndpointHint'),
                ),
                field(
                  t('powercontextTokenLabel'),
                  h('input', {
                    type: 'password',
                    className: INPUT_CLASS,
                    value: props.powercontext.token,
                    disabled: busy,
                    autoComplete: 'new-password',
                    onChange: (e: { target: { value: string } }) =>
                      props.onPowerContextChange({ token: e.target.value }),
                  }),
                  t('powercontextTokenHint'),
                ),
              ],
            })
          : null,
        isPowerContext
          ? h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                toggleCell('optimizeQuery', props.powercontext.optimizeQuery, busy, (value) =>
                  props.onPowerContextChange({ optimizeQuery: value }),
                ),
              ],
            })
          : null,
      ],
    });
  };
}
