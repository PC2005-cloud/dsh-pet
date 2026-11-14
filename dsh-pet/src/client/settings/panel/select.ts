/**
 * 设置页的通用单选下拉：触发器 + fixed 浮层，替代原生 `<select>`。
 * 原生下拉的展开面板由操作系统绘制，字号、圆角与 hover 都不受 `--dsw-*` token 控制，与同排的输入框不同源；
 * 这里自绘一份：触发器复用 `INPUT_CLASS` 的外观，定位复用 `./placement`。
 * 不做搜索框与分组：选项数都在十以内，滚轮够用。本文件只管状态、键盘与装配。
 * @module dsh-pet/src/client/settings/panel/select
 */
import type * as ReactNS from 'react';
import type { FunctionComponent } from 'react';
import { INPUT_CLASS } from '../ui.ts';
import type { SettingsRuntime } from '../runtime.ts';
import { computePanelPlacement, type PanelPosition } from './placement.ts';

/** 一项候选；`id` 回传给 `onChange`，`label` 是已翻译的展示文案。 */
export interface SelectOption {
  id: string;
  label: string;
  /** 分组标题；相邻且同组时合并，渲染时在组前插一行标题。不参与键盘索引。 */
  group?: string;
}

/** 下拉的对外契约：一个字段一个实例。 */
export interface SelectProps {
  /** 字段标签（已翻译），作触发器的无障碍名。 */
  label: string;
  /** 当前值；不在 `options` 里时触发器留空，绝不显示成别的选项。 */
  value: string;
  options: readonly SelectOption[];
  disabled: boolean;
  /** 选定回调；只在值真正变化时触发，与原生 `<select>` 的 `change` 同语义。 */
  onChange: (id: string) => void;
}

/**
 * 造单选下拉。
 * 依赖只在调用时注入一次：组件类型必须跨渲染稳定，否则浮层状态（打开 / 高亮）每次渲染都会丢。
 *
 * @param rt - 注入的 react 能力；不需要翻译，文案由调用方传入。
 * @returns 下拉组件。
 */
export function makeSelect(
  rt: Pick<SettingsRuntime, 'h' | 'useState' | 'useEffect' | 'useRef'>,
): FunctionComponent<SelectProps> {
  const { h, useState, useEffect, useRef } = rt;

  return function Select(props: SelectProps) {
    const [open, setOpen] = useState(false);
    // 高亮行：键盘 ↑↓ 走的就是它
    const [active, setActive] = useState(0);
    // 浮层位置：打开时按触发器实测一次，空间不够就翻到上方
    const [pos, setPos] = useState<PanelPosition | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);

    const selectedAt = props.options.findIndex((option) => option.id === props.value);
    const currentLabel = selectedAt >= 0 ? props.options[selectedAt].label : '';

    /** 打开并把高亮停到当前选中项上。 */
    const openAt = (index: number): void => {
      setActive(index >= 0 ? index : 0);
      setOpen(true);
    };
    const commit = (index: number): void => {
      const option = props.options[index];
      setOpen(false);
      if (option !== undefined && option.id !== props.value) props.onChange(option.id);
    };
    const step = (dir: number): void => {
      const count = props.options.length;
      if (count === 0) return;
      const next = (Math.max(active, 0) + dir + count) % count;
      setActive(next);
      panelRef.current?.querySelector('[data-row="' + next + '"]')?.scrollIntoView({ block: 'nearest' });
    };

    useEffect(() => {
      if (!open) return;
      const root = rootRef.current;
      // 定位 + 关闭时机：浮层脱离文档流实测定位，滚动/缩放跟着走，点外面或 Esc 关。
      const place = (): void => {
        if (!root) return;
        setPos(
          computePanelPlacement(
            root.getBoundingClientRect(),
            { width: window.innerWidth, height: window.innerHeight },
            // 与触发器等宽：240 的下限是给「服务商 + 模型」两段文字留的，单行下拉不该继承。
            { minWidthPx: 0 },
          ),
        );
      };
      place();
      const onDown = (e: MouseEvent): void => {
        const target = e.target as Node | null;
        if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) {
          return;
        }
        setOpen(false);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      };
    }, [open]);

    // 保存中会被禁用：浮层还开着就点得到不该改的值，直接收起。
    useEffect(() => {
      if (props.disabled) setOpen(false);
    }, [props.disabled]);

    const toggle = (): void => {
      if (props.disabled) return;
      if (open) setOpen(false);
      else openAt(selectedAt);
    };

    const onTriggerKey = (e: ReactNS.KeyboardEvent<HTMLButtonElement>): void => {
      const count = props.options.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (open) step(e.key === 'ArrowDown' ? 1 : -1);
        else openAt(selectedAt);
        return;
      }
      if (open && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault();
        setActive(e.key === 'Home' || count === 0 ? 0 : count - 1);
        return;
      }
      // 按钮的 Enter/Space 会合成一次 click：浮层开着时改成「选定高亮行」，否则会先关再开。
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (open) commit(active);
        else openAt(selectedAt);
      }
    };

    const panel =
      open && pos
        ? h('div', {
            ref: panelRef,
            className: 'dsh-pet-sel__panel',
            role: 'listbox',
            'aria-label': props.label,
            style: {
              left: pos.left + 'px',
              top: pos.top === undefined ? undefined : pos.top + 'px',
              bottom: pos.bottom === undefined ? undefined : pos.bottom + 'px',
              width: pos.width + 'px',
              maxHeight: pos.maxHeight + 'px',
            },
            children: h('div', {
              className: 'dsh-pet-sel__list',
              children: props.options.flatMap((option, index) => {
                // 分组标题只是分隔行：不占 index、不参与 step/commit，所以键盘逻辑一行都不用改
                const isGroupStart = option.group !== undefined && option.group !== props.options[index - 1]?.group;
                const groupRow = isGroupStart
                  ? [
                      h('div', {
                        key: 'group-' + index,
                        className: 'dsh-pet-sel__group',
                        role: 'presentation',
                        children: option.group,
                      }),
                    ]
                  : [];
                return [
                  ...groupRow,
                  h('button', {
                    key: option.id,
                    type: 'button',
                    role: 'option',
                    'aria-selected': option.id === props.value,
                    'data-row': index,
                    className: 'dsh-pet-sel__item' + (index === active ? ' is-active' : ''),
                    onMouseMove: () => setActive(index),
                    onClick: () => commit(index),
                    children: [
                      h('span', { key: 'n', className: 'dsh-pet-sel__name', children: option.label }),
                      h('span', {
                        key: 'c',
                        className: 'dsh-pet-sel__check',
                        children: option.id === props.value ? '✓' : '',
                      }),
                    ],
                  }),
                ];
              }),
            }),
          })
        : null;

    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-sel',
      children: [
        h('button', {
          key: 'trigger',
          type: 'button',
          className: INPUT_CLASS + ' dsh-pet-sel__trigger',
          disabled: props.disabled,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': props.label,
          onClick: toggle,
          onKeyDown: onTriggerKey,
          children: [
            h('span', { key: 'l', className: 'dsh-pet-sel__label', children: currentLabel }),
            h('span', { key: 'c', className: 'dsh-pet-sel__chevron' + (open ? ' is-open' : '') }),
          ],
        }),
        panel,
      ],
    });
  };
}
