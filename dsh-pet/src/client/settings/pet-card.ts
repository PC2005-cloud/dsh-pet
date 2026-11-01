/**
 * 选中宠物的配置卡：名字 / 大小 / 显示位置、角落与偏移、四个功能开关、实例级人设。
 * 只编辑 main 条目的实例字段：条目级字段由成品配置回落，卡里不出现也不回写；文件宠物永不进这张卡。
 * 纯展示 + 回调，状态全在设置页外壳；`onChange` 的补丁形状即提交形状的预览。
 * @module dsh-pet/src/client/settings/pet-card
 */
import type { ChangeEvent, FunctionComponent } from 'react';
import type { Corner, Pet, PetDisplay } from '../../shared/types.ts';
import { PET_DISPLAYS } from '../../shared/config.ts';
import { SIZE_PERCENT_DEFAULT, SIZE_PERCENT_MIN } from '../../shared/pet-size.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit, numberInputProps } from './ui.ts';
import { makeSelect } from './panel/select.ts';

/** 宠物字段补丁：`position` 只带要改的子字段，其余字段走顶层。 */
export type PetPatch = Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> };

/** 宠物卡的全部输入。 */
export interface PetCardProps {
  /** 当前选中的宠物；`null` 表示列表为空。 */
  pet: Pet | null;
  /** 表单是否禁用（保存中或配置还没加载好）。 */
  busy: boolean;
  /** 保存 / 同步的最近一次反馈，就近显示在卡片右上角。 */
  msg: { kind: 'ok' | 'err' | ''; text: string };
  /** 条目级人设正文，作为实例人设输入框的 placeholder。 */
  entryPrompt: string;
  /** 改选中宠物的字段。 */
  onChange: (patch: PetPatch) => void;
  /** 就近保存。 */
  onSave: () => void;
  /** 删除当前宠物（先弹确认）。 */
  onRemove: () => void;
}

/** 四个角落的固定顺序；文案走 `corner.<corner>`。 */
const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * 造宠物配置卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makePetCard(rt: SettingsRuntime): FunctionComponent<PetCardProps> {
  const { h, t } = rt;
  const { tip, q, field, toggleCell } = makeUiKit({ h, t });
  const Select = makeSelect(rt);

  /** 宠物数值输入（大小 / 水平偏移 / 垂直偏移）；宽度交给栅格。 */
  const numInput = (
    key: 'size' | 'marginX' | 'marginY',
    value: number,
    disabled: boolean,
    setter: (v: number) => void,
  ) =>
    h(
      'input',
      numberInputProps(value, setter, {
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        disabled,
      }),
    );

  /** 百分比输入：默认 20；不设上限（超过 100 只在 size 也够大时才生效）。 */
  const percentInput = (value: number, disabled: boolean, setter: (v: number) => void) =>
    h(
      'input',
      numberInputProps(value, setter, {
        min: String(SIZE_PERCENT_MIN),
        step: '1',
        disabled,
      }),
    );

  return function PetCard(props: PetCardProps) {
    const { pet, busy, msg } = props;
    if (pet === null) return h('p', { className: 'dsh-pet-cfg__note', children: t('emptyPets') });
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        h('div', {
          className: 'dsh-pet-cfg__cardHead',
          children: [
            h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: t('petCardTitle') }),
            q(t('petCardHint')),
            // 右侧动作组：auto margin 挂在这层 wrapper 上，保存结果出现 / 消失时按钮位置不会跳。
            h('div', {
              key: 'acts',
              style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' },
              children: [
                // 保存结果就近反馈（与页面底部同一份 msg 状态），否则在卡片上点保存看不到结果。
                msg.text
                  ? h('span', {
                      key: 'msg',
                      className: 'dsh-pet-cfg__msg' + (msg.kind === 'err' ? ' is-err' : ''),
                      children: msg.text,
                    })
                  : null,
                // 就近保存：宠物这一块改完就地存盘，不必滚到底部的「保存」；悬浮按钮即出快捷键气泡。
                h('button', {
                  key: 'sv',
                  type: 'button',
                  onClick: props.onSave,
                  disabled: busy,
                  className: 'dsh-pet-cfg__btn is-primary is-sm',
                  ...tip(t('saveHotkey')),
                  children: t('save'),
                }),
                h('button', {
                  key: 'rm',
                  type: 'button',
                  onClick: props.onRemove,
                  disabled: busy,
                  className: 'dsh-pet-cfg__btn is-danger is-sm',
                  children: t('remove'),
                }),
              ],
            }),
          ],
        }),

        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [
            field(
              t('nameLabel'),
              h('input', {
                type: 'text',
                className: INPUT_CLASS,
                value: String(pet.name ?? ''),
                disabled: busy,
                maxLength: 50,
                onChange: (e: ChangeEvent<HTMLInputElement>) => props.onChange({ name: e.target.value }),
              }),
              t('nameHint'),
            ),
            field(
              t('sizeLabel'),
              numInput('size', pet.size, busy, (v) => props.onChange({ size: v })),
              t('sizeHint'),
            ),
            field(
              t('sizePercentLabel'),
              percentInput(pet.sizePercent ?? SIZE_PERCENT_DEFAULT, busy, (v) => props.onChange({ sizePercent: v })),
              t('sizePercentHint'),
            ),
            field(
              t('displayLabel'),
              h(Select, {
                label: t('displayLabel'),
                value: pet.display,
                options: PET_DISPLAYS.map((d) => ({ id: d, label: t('display.' + d) })),
                disabled: busy,
                onChange: (id: string) => props.onChange({ display: id as PetDisplay }),
              }),
              t('displayHint'),
            ),
          ],
        }),

        h('div', {
          className: 'dsh-pet-cfg__grid3',
          children: [
            field(
              t('cornerLabel'),
              h(Select, {
                label: t('cornerLabel'),
                value: pet.position.corner,
                options: CORNERS.map((c) => ({ id: c, label: t('corner.' + c) })),
                disabled: busy,
                onChange: (id: string) => props.onChange({ position: { corner: id as Corner } }),
              }),
              t('cornerHint'),
            ),
            field(
              t('marginX'),
              numInput('marginX', pet.position.marginX, busy, (v) => props.onChange({ position: { marginX: v } })),
              t('marginXHint'),
            ),
            field(
              t('marginY'),
              numInput('marginY', pet.position.marginY, busy, (v) => props.onChange({ position: { marginY: v } })),
              t('marginYHint'),
            ),
          ],
        }),

        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [
            toggleCell('balanceEnabled', !!pet.balanceEnabled, busy, (v) => props.onChange({ balanceEnabled: v })),
            toggleCell('whisperEnabled', !!pet.whisperEnabled, busy, (v) => props.onChange({ whisperEnabled: v })),
            toggleCell('workStatusEnabled', !!pet.workStatusEnabled, busy, (v) =>
              props.onChange({ workStatusEnabled: v }),
            ),
            toggleCell('fixedEnabled', !!pet.fixedEnabled, busy, (v) => props.onChange({ fixedEnabled: v })),
          ],
        }),

        // 人设（可选，实例级）：写在这只宠物上的 whisperPrompt，空 = 跟随所属条目的人设。
        // 只存储与回显，不在这里拼 system；拼装（名字声明 + 时间背景）在宿主半侧。
        // 占位符直接用条目人设正文，让「跟随的是什么」可见；人设没有长度上限，右下角只显示字数。
        field(
          t('personaLabel'),
          h('div', {
            className: 'dsh-pet-cfg__persona',
            children: [
              h('textarea', {
                className: INPUT_CLASS + ' dsh-pet-cfg__area',
                rows: 3,
                value: String(pet.whisperPrompt ?? ''),
                disabled: busy,
                placeholder: props.entryPrompt,
                onChange: (e: ChangeEvent<HTMLTextAreaElement>) => props.onChange({ whisperPrompt: e.target.value }),
              }),
              h('span', {
                className: 'dsh-pet-cfg__count',
                children: t('personaCount').replace('{n}', String(String(pet.whisperPrompt ?? '').length)),
              }),
            ],
          }),
          t('personaHint'),
        ),
      ],
    });
  };
}
