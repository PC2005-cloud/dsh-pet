/**
 * 「AI 模型与对话上下文」卡：碎碎念 / 对话各自的模型（条目级），对话历史条数与配图张数上限（全局默认），
 * 以及三个与对话相关的开关（碎碎念配图 / 对话配图 / 对话动作联动）；
 * 长期记忆实现的下拉也在这里，选中 PowerContext 时再多出它的地址与令牌两个输入框（选中别家不渲染）。
 * 都与全局开关同语义：只改本地状态，随「保存」整包写入；宿主生成时优先用模型，失败自动回落。
 * 候选清单拉取失败只在这里提示一行，不阻塞已有配置值的显示与保存。
 * @module dsh-pet/src/client/settings/model-card
 */
import type { FunctionComponent } from 'react';
import { POWERCONTEXT_MEMORY_ID } from '../../shared/memory.ts';
import type { PowerContextConfig } from '../../shared/memory.ts';
import type { ModelSelection } from '../../shared/types.ts';
import { makeSelect } from './panel/select.ts';
import type { ModelCatalogGroup } from './picker/index.ts';
import type { ModelPickerProps } from './picker/index.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit, numberInputProps } from './ui.ts';

/** 两个模型字段的键名。 */
export type ModelFieldKey = 'whisperModel' | 'chatModel';

/** 三个对话开关的键名，与成品配置的字段名一致。 */
export type ChatFlagKey = 'whisperImageEnabled' | 'chatImageEnabled' | 'chatAnimationEnabled';

/** 三个对话开关的当前值。 */
export type ChatFlagValues = Record<ChatFlagKey, boolean>;

/** 对话开关的展示顺序与文案键。 */
const CHAT_TOGGLES: Array<{ key: ChatFlagKey; label: string }> = [
  { key: 'whisperImageEnabled', label: 'whisperImageToggle' },
  { key: 'chatImageEnabled', label: 'chatImageToggle' },
  { key: 'chatAnimationEnabled', label: 'chatAnimationToggle' },
];

/** 模型卡的输入。 */
export interface ModelCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  busy: boolean;
  /** 候选清单；`null` 表示还在拉取。 */
  catalog: readonly ModelCatalogGroup[] | null;
  /** 候选清单拉取失败。 */
  failed: boolean;
  /** 碎碎念用的模型。 */
  whisperModel: ModelSelection;
  /** 对话用的模型。 */
  chatModel: ModelSelection;
  /** 某个模型字段被改。 */
  onModelChange: (key: ModelFieldKey, value: ModelSelection) => void;
  /** 对话历史条数。 */
  chatMemory: number;
  /** 对话配图张数上限。 */
  chatImageLimit: number;
  /** 改对话历史条数。 */
  onChatMemoryChange: (value: number) => void;
  /** 改对话配图张数上限。 */
  onChatImageLimitChange: (value: number) => void;
  /** 三个对话开关的当前值。 */
  values: ChatFlagValues;
  /** 某个对话开关被切换。 */
  onFlagChange: (key: ChatFlagKey, value: boolean) => void;
  /** 当前长期记忆实现 id。 */
  memoryProvider: string;
  /** 可选记忆实现；为空时下拉只显示当前值（列表还没拉回来或拉取失败）。 */
  memoryProviders: readonly { readonly id: string; readonly name: string }[];
  /** 切换长期记忆实现。 */
  onMemoryProviderChange: (value: string) => void;
  /** PowerContext 连接配置；只有选中该实现时才有输入框。 */
  powercontext: PowerContextConfig;
  /** 改 PowerContext 的某一项（两个输入框共用一个整段对象）。 */
  onPowerContextChange: (patch: Partial<PowerContextConfig>) => void;
}

/**
 * 造模型卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @param picker - 模型选择器组件（由外壳用同一份运行时造好，跨渲染稳定）。
 * @returns 卡片组件。
 */
export function makeModelCard(
  rt: SettingsRuntime,
  picker: FunctionComponent<ModelPickerProps>,
): FunctionComponent<ModelCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });
  const Select = makeSelect(rt);

  return function ModelCard(props: ModelCardProps) {
    const { busy, catalog, failed } = props;

    /** 「全局默认」的数字格：标签与问号在上、数字输入在下。 */
    const numField = (label: string, value: number, setter: (v: number) => void) =>
      field(
        t(label),
        h('input', numberInputProps(value, setter, { step: '1', min: '0', disabled: busy })),
        t(label + 'Hint'),
      );

    /** 「AI 模型」的一格：标签与问号在上、单下拉选择器在下。 */
    const modelCell = (key: ModelFieldKey, value: ModelSelection) => {
      const label = t(key === 'whisperModel' ? 'whisperModelLabel' : 'chatModelLabel');
      return field(
        label,
        h(picker, {
          label,
          value,
          disabled: busy,
          catalog,
          failed,
          onChange: (next: ModelSelection) => props.onModelChange(key, next),
        }),
        t('modelFieldHint'),
      );
    };

    /**
     * PowerContext 的连接字段：地址与令牌属于这一个实现，选中别家时整块不渲染。
     * 令牌用密码框、且不回显到气泡说明里——它只该被写入，不该被围观。
     */
    const powerContextFields = () =>
      props.memoryProvider === POWERCONTEXT_MEMORY_ID
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
                  onChange: (e: { target: { value: string } }) => props.onPowerContextChange({ token: e.target.value }),
                }),
                t('powercontextTokenHint'),
              ),
            ],
          })
        : null;

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('modelTitle'), t('modelHint')),
        failed
          ? h('p', {
              className: 'dsh-pet-cfg__note',
              style: { color: 'var(--dsw-alias-state-error-primary)' },
              children: t('modelCatalogFailed'),
            })
          : null,
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [modelCell('whisperModel', props.whisperModel), modelCell('chatModel', props.chatModel)],
        }),
        // 长期记忆实现：与语音识别实现同构，选项来自宿主注册表，不硬编码 id
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            field(
              t('memoryProviderLabel'),
              h(Select, {
                label: t('memoryProviderLabel'),
                value: props.memoryProvider,
                options: props.memoryProviders.map((item) => ({ id: item.id, label: item.name })),
                disabled: busy,
                onChange: props.onMemoryProviderChange,
              }),
              t('memoryProviderHint'),
            ),
          ],
        }),
        powerContextFields(),
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [
            numField('chatMemory', props.chatMemory, props.onChatMemoryChange),
            numField('chatImageLimit', props.chatImageLimit, props.onChatImageLimitChange),
          ],
        }),
        h('div', {
          className: 'dsh-pet-cfg__grid3',
          children: CHAT_TOGGLES.map((toggle) =>
            toggleCell(toggle.label, props.values[toggle.key], busy, (value) => props.onFlagChange(toggle.key, value)),
          ),
        }),
      ],
    });
  };
}
