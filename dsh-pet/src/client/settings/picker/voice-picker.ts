/**
 * 音色单选下拉：把「名称（标签）」拼成一行，交互与外观全交给通用下拉 `../panel/select`。
 * 音色只有几个，不做搜索与预览；标签并入文案，用户在选定前就能看出声色风格。
 * @module dsh-pet/src/client/settings/picker/voice-picker
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from '../runtime.ts';
import { makeSelect } from '../panel/select.ts';

/** 一个可选音色的展示信息；`id`（限定 id）既是提交值也是稳定 key。 */
export interface VoiceOption {
  readonly id: string;
  readonly name: string;
  /** 展示用副标题，如「女 · 活泼」；缺省时只显示名称。 */
  readonly tag?: string;
  /** 所属 provider 的展示名；渲染成下拉里的分组标题。 */
  readonly providerName?: string;
}

/** 音色选择器的对外契约：一个字段一个实例。 */
export interface VoicePickerProps {
  /** 字段标签，作为触发器的无障碍名。 */
  readonly label: string;
  /** 当前音色 id。 */
  readonly value: string;
  /** 可选音色；为空时触发器留空，打开后是空列表。 */
  readonly options: readonly VoiceOption[];
  /** 禁用原因（保存中 / 配置未加载）。 */
  readonly disabled: boolean;
  /** 选中一个音色。 */
  readonly onChange: (voiceName: string) => void;
}

/**
 * 造音色选择器。
 * 依赖只在调用时注入一次：组件类型必须跨渲染稳定，否则浮层状态（打开 / 高亮）每次渲染都会丢。
 *
 * @param rt - 注入的 react 能力；文案由调用方在 options 里给全，不需要翻译。
 * @returns 选择器组件。
 */
export function makeVoicePicker(
  rt: Pick<SettingsRuntime, 'h' | 'useState' | 'useEffect' | 'useRef'>,
): FunctionComponent<VoicePickerProps> {
  const { h } = rt;
  const Select = makeSelect(rt);

  return function VoicePicker(props: VoicePickerProps) {
    return h(Select, {
      label: props.label,
      value: props.value,
      options: props.options.map((option) => ({
        id: option.id,
        label: option.tag === undefined ? option.name : `${option.name}（${option.tag}）`,
        ...(option.providerName === undefined ? {} : { group: option.providerName }),
      })),
      disabled: props.disabled,
      onChange: props.onChange,
    });
  };
}
