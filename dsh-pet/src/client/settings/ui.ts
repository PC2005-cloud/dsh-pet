/**
 * 设置页共用的小件：字段、问号说明、卡片头、开关格，以及输入框与等宽字体的共享常量。
 * 全部只是造节点，不含状态也不读翻译以外的全局——样式规则在 `css.ts`，文案键在 `locales.ts`。
 * 说明统一走 `data-tip` 属性（气泡由 `./tip-layer` 挂到 body 上摆位），不额外包一层 DOM，避免打乱外层 flex 的间距与对齐。
 * @module dsh-pet/src/client/settings/ui
 */
import type { ChangeEvent, KeyboardEvent } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import type { SettingsRuntime } from './runtime.ts';

/** 输入框与下拉框共用的类名。 */
export const INPUT_CLASS = 'dsh-pet-cfg__inp';

/**
 * 数字输入的统一属性：非受控 + 失焦提交。
 *
 * 受控写法（`value={String(n)}` + `Number(e.target.value)`）在删空时必然把空串变成 0，
 * 用户想「删干净再输」时会被打断；这里让空框是合法中间态，失焦才解析并提交。
 * `key` 跟随值变化：外部改了配置就重挂载刷新，编辑期间 state 不动，所以不会打断输入。
 *
 * @param value - 当前生效值。
 * @param onCommit - 提交新值；只有真的变化时才回调。
 * @param extra - 该输入自己的属性（step / min / max / disabled 等）。
 * @returns 可直接摊给 `<input>` 的属性。
 */
export function numberInputProps(
  value: number,
  onCommit: (value: number) => void,
  extra: ReactNS.JSX.IntrinsicElements['input'] = {},
): ReactNS.JSX.IntrinsicElements['input'] {
  return {
    ...extra,
    type: 'number',
    className: INPUT_CLASS,
    defaultValue: String(value),
    key: String(value),
    onBlur: (e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value.trim();
      const parsed = Number(text);
      // 空串/脏值 = 放弃这次编辑，把显示回退到生效值。
      const next = text !== '' && Number.isFinite(parsed) ? parsed : value;
      e.target.value = String(next);
      if (next !== value) onCommit(next);
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') e.currentTarget.blur();
    },
  };
}

/** 等宽字体栈（路径与命令展示用），走系统栈以免多拉一份资源。 */
export const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

/** 折叠卡的输入：标题行常驻，正文收进裁剪层。 */
export interface FoldCardOptions {
  /** 正文 id，同时是标题按钮的 `aria-controls` 目标。 */
  readonly id: string;
  readonly title: string;
  /** 问号气泡里的说明。 */
  readonly hint: string;
  /** 展开后的若干行；`null` 表示该条不存在，整项跳过。 */
  readonly body: ReadonlyArray<ReturnType<typeof jsx> | null>;
  /** 当前是否展开；开合状态由调用方用 `useState` 持有，钩子顺序才稳定。 */
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** 设置页的共用小件；由 {@link makeUiKit} 一次造好，各卡片共享同一套翻译与节点工厂。 */
export interface SettingsUiKit {
  /** 悬浮说明的展开属性：带 `data-tip` 即悬浮出气泡。 */
  tip: (text: string) => Record<string, string>;
  /** 问号说明入口：气泡的圆形触发元素。 */
  q: (text: string) => ReturnType<typeof jsx>;
  /** 卡片头：标题与问号说明；右侧动作由调用方自行追加。 */
  cardHead: (title: string, hint?: string) => ReturnType<typeof jsx>;
  /** 一个字段：标签（可带问号）在上、控件在下。 */
  field: (label: string, control: ReturnType<typeof jsx>, hint?: string) => ReturnType<typeof jsx>;
  /** 开关的一格：勾选框、标题与问号；说明挂在问号上，点标题只切开关。 */
  toggleCell: (
    label: string,
    value: boolean,
    disabled: boolean,
    onToggle: (value: boolean) => void,
  ) => ReturnType<typeof jsx>;
  /**
   * 折叠卡骨架：标题行常驻且整行可点，正文收进裁剪层。
   *
   * 高度过渡走 `grid-template-rows` 的 0fr→1fr，不猜 max-height——正文多长都能收干净。
   */
  foldCard: (options: FoldCardOptions) => ReturnType<typeof jsx>;
}

/**
 * 造设置页的共用小件。
 *
 * @param rt - 只用到节点工厂 `h` 与翻译 `t`。
 * @returns 各卡片共享的小件集合。
 */
export function makeUiKit(rt: Pick<SettingsRuntime, 'h' | 't'>): SettingsUiKit {
  const { h, t } = rt;

  /**
   * 悬浮说明的展开属性。
   *
   * @param text - 说明正文（已翻译）。
   */
  const tip = (text: string): Record<string, string> => ({ 'data-tip': text });

  /** 问号：气泡的圆形触发元素。用 `<i>` 而不是 `<button>`——它只展示说明，点了不该有行为，也不该进 Tab 顺序。 */
  const q = (text: string): ReturnType<typeof jsx> =>
    h('i', { className: 'dsh-pet-cfg__q', ...tip(text), 'aria-label': text, role: 'img', children: '?' });

  return {
    tip,
    q,
    cardHead: (title, hint) =>
      h('div', {
        className: 'dsh-pet-cfg__cardHead',
        children: [
          h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: title }),
          hint ? q(hint) : null,
        ],
      }),
    field: (label, control, hint) =>
      h('div', {
        className: 'dsh-pet-cfg__field',
        children: [
          h('span', {
            key: 'l',
            className: 'dsh-pet-cfg__flabel',
            children: hint ? [label, q(hint)] : label,
          }),
          control,
        ],
      }),
    toggleCell: (label, value, disabled, onToggle) =>
      h('div', {
        className: 'dsh-pet-cfg__toggle',
        children: [
          h('label', {
            key: 'l',
            children: [
              h('input', {
                key: 'i',
                type: 'checkbox',
                checked: value,
                disabled,
                onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
              }),
              h('span', { key: 't', children: t(label) }),
            ],
          }),
          q(t(label + 'Hint')),
        ],
      }),
    foldCard: (options) =>
      h('div', {
        className: 'dsh-pet-cfg__card is-fold' + (options.open ? ' is-open' : ''),
        children: [
          // 整行可点：标题、问号与箭头都在按钮里。问号自己拦掉冒泡，点它只出气泡、不开合。
          h('button', {
            key: 'head',
            type: 'button',
            className: 'dsh-pet-cfg__foldToggle',
            'aria-expanded': options.open,
            'aria-controls': options.id,
            onClick: options.onToggle,
            children: [
              h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: options.title }),
              h('span', {
                key: 'q',
                className: 'dsh-pet-cfg__qWrap',
                onClick: (e: ReactNS.MouseEvent<HTMLSpanElement>) => e.stopPropagation(),
                children: q(options.hint),
              }),
              // 箭头：展开时转 180°，与模型选择器的展开指示一致。
              h('i', {
                key: 'c',
                className: 'dsh-pet-cfg__chevron' + (options.open ? ' is-open' : ''),
                'aria-hidden': 'true',
              }),
            ],
          }),
          // 裁剪层承担 overflow，正文内层出高度：收起时 0fr 把 padding 一起裁掉，卡片底不留空缝。
          h('div', {
            key: 'body',
            id: options.id,
            className: 'dsh-pet-cfg__fold',
            'aria-hidden': options.open ? undefined : 'true',
            children: h('div', {
              className: 'dsh-pet-cfg__foldClip',
              children: h('div', { className: 'dsh-pet-cfg__foldBody', children: options.body }),
            }),
          }),
        ],
      }),
  };
}
