/**
 * 语音卡：四个播报开关与音色、音量。
 *
 * 切换只改本地状态、随「保存」整包写入——即时写盘会重启桌面 Helper、重建全部桌面宠物窗口。
 * 音色选择器由外壳注入（与模型卡注入 picker 同构），卡片本身不硬编码任何音色 id。
 * 合成来源决定「音色」这一栏该填什么：edge 走内置白名单音色，breeze 走 BreezeBlue 的 Voice ID，
 * 两者不共用一个字段，切回来时各自的音色都还在。
 * @module dsh-pet/src/client/settings/voice-card
 */
import type { FunctionComponent } from 'react';
import type { TtsProvider } from '../../shared/voice-provider.ts';
import type { VoiceOption, VoicePickerProps } from './picker/voice-picker.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit, numberInputProps } from './ui.ts';
import { makeSelect } from './panel/select.ts';

export type { VoiceOption } from './picker/voice-picker.ts';

/** 语音卡的输入。 */
export interface VoiceCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  readonly busy: boolean;
  /** 手动播报开关的当前值：手动触发的碎碎念与对话回复。 */
  readonly enabled: boolean;
  /** 当前音色 id。 */
  readonly voiceName: string;
  /** 合成来源：edge（内置，免密钥）或 breeze（BreezeBlue）。 */
  readonly provider: TtsProvider;
  /** BreezeBlue 密钥；空串 = 未配置（运行期回落 edge）。 */
  readonly breezeApiKey: string;
  /** BreezeBlue 音色 id；空串 = 用插件默认。 */
  readonly breezeVoiceId: string;
  /** 播放音量系数：0–1 的小数，1 = 最大音量。 */
  readonly volume: number;
  /** 可选音色；为空时选择器只显示当前值（列表还没拉回来或拉取失败）。 */
  readonly voices: readonly VoiceOption[];
  /** 周期碎碎念要不要念出来。 */
  readonly whisperEnabled: boolean;
  /** 待办提醒要不要念出来。 */
  readonly todoEnabled: boolean;
  /** 工作状态播报要不要念出来。 */
  readonly notifyEnabled: boolean;
  /** 切换手动播报开关。 */
  readonly onToggle: (value: boolean) => void;
  /** 选择音色。 */
  readonly onVoiceChange: (voiceName: string) => void;
  /** 切换合成来源。 */
  readonly onProviderChange: (provider: TtsProvider) => void;
  /** 改 BreezeBlue 密钥。 */
  readonly onBreezeApiKeyChange: (apiKey: string) => void;
  /** 改 BreezeBlue 音色 id。 */
  readonly onBreezeVoiceIdChange: (voiceId: string) => void;
  /** 调整播放音量。 */
  readonly onVolumeChange: (volume: number) => void;
  /** 切换周期碎碎念的播报。 */
  readonly onWhisperToggle: (value: boolean) => void;
  /** 切换待办提醒的播报。 */
  readonly onTodoToggle: (value: boolean) => void;
  /** 切换工作状态播报。 */
  readonly onNotifyToggle: (value: boolean) => void;
}

/**
 * 造语音卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @param picker - 音色选择器组件；与模型卡一样由装配根造一次后注入，保证组件类型跨渲染稳定。
 * @returns 卡片组件。
 */
export function makeVoiceCard(
  rt: SettingsRuntime,
  picker: FunctionComponent<VoicePickerProps>,
): FunctionComponent<VoiceCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });
  const Select = makeSelect(rt);

  return function VoiceCard(props: VoiceCardProps) {
    const breeze = props.provider === 'breeze';

    /** BreezeBlue 专属：密钥与 Voice ID。密钥用 password 输入，避免设置页被旁观时直接泄露。 */
    const breezeFields = () =>
      h('div', {
        className: 'dsh-pet-cfg__grid2',
        children: [
          field(
            t('breezeApiKeyLabel'),
            h('input', {
              type: 'password',
              className: 'dsh-pet-cfg__inp',
              value: props.breezeApiKey,
              disabled: props.busy,
              autoComplete: 'off',
              spellCheck: false,
              placeholder: 'brz_...',
              onChange: (e: { target: { value: string } }) => props.onBreezeApiKeyChange(e.target.value),
            }),
            t('breezeApiKeyHint'),
          ),
          field(
            t('breezeVoiceLabel'),
            h('input', {
              type: 'text',
              className: 'dsh-pet-cfg__inp',
              value: props.breezeVoiceId,
              disabled: props.busy,
              spellCheck: false,
              placeholder: 'voc_...',
              onChange: (e: { target: { value: string } }) => props.onBreezeVoiceIdChange(e.target.value),
            }),
            t('breezeVoiceHint'),
          ),
        ],
      });

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('voiceTitle'), t('voiceHint')),
        // 第一行四个开关：四类语音各一个，必须相邻，读得出是「同一类」；第二行两个输入：音色与音量。
        // 音色不挂文字标签也不挂问号：下拉当前值「晓伊（女·活泼）」自己就说明了它是什么。
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [
            toggleCell('voiceEnabled', props.enabled, props.busy, props.onToggle),
            toggleCell('voiceWhisperEnabled', props.whisperEnabled, props.busy, props.onWhisperToggle),
            toggleCell('voiceTodoEnabled', props.todoEnabled, props.busy, props.onTodoToggle),
            toggleCell('voiceNotifyEnabled', props.notifyEnabled, props.busy, props.onNotifyToggle),
          ],
        }),
        // 来源单独一行：它决定下面「音色」栏的取值域，放在同一行会被读成并列的音色参数
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            field(
              t('voiceProviderLabel'),
              h(Select, {
                label: t('voiceProviderLabel'),
                value: props.provider,
                options: [
                  { id: 'edge', label: t('tts.edge') },
                  { id: 'breeze', label: t('tts.breeze') },
                ],
                disabled: props.busy,
                onChange: (id: string) => props.onProviderChange(id as TtsProvider),
              }),
              t('voiceProviderHint'),
            ),
          ],
        }),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            h(picker, {
              label: t('voiceNameLabel'),
              value: props.voiceName,
              options: props.voices,
              disabled: props.busy,
              onChange: props.onVoiceChange,
            }),
            field(
              t('voiceVolumeLabel'),
              h(
                'input',
                numberInputProps(props.volume, props.onVolumeChange, {
                  step: '0.05',
                  min: '0',
                  max: '1',
                  disabled: props.busy,
                }),
              ),
              t('voiceVolumeHint'),
            ),
          ],
        }),
        // Breeze 的三项只在选中 breeze 时出现：填了也不生效的输入框只会让人以为配置没保存
        breeze ? breezeFields() : null,
      ],
    });
  };
}
