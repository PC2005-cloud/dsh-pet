/**
 * 「显示哪些宠物」勾选卡：一屏按种类列出全部实例，勾选 = 显示、取消 = 隐藏。
 *
 * 只改 `display` 字段（`none` 即不渲染），不删除实例，所以隐藏后配置、头像与人设都还在。
 * 取消时原来的显示位置由外壳记住并在重新勾选时恢复，本卡片不做这层状态。
 * @module dsh-pet/src/client/settings/visibility-card
 */
import type { ChangeEvent, FunctionComponent } from 'react';
import type { Pet } from '../../shared/types.ts';
import { isPetVisible } from '../../shared/config.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';
import { groupPetsByKind } from './use-pet-list.ts';

/** 勾选卡的输入。 */
export interface VisibilityCardProps {
  /** 全条目的实例（按种类分组渲染，顺序即成品里的条目顺序）。 */
  pets: readonly Pet[];
  /** 保存中或配置未就绪时禁用全部勾选框。 */
  busy: boolean;
  /** 勾选状态变化；`visible=false` 即隐藏该宠物。 */
  onChange: (id: string, visible: boolean) => void;
}

/**
 * 造「显示哪些宠物」勾选卡。
 *
 * @param rt - 注入的节点工厂与翻译函数。
 * @returns 卡片组件。
 */
export function makeVisibilityCard(rt: Pick<SettingsRuntime, 'h' | 't'>): FunctionComponent<VisibilityCardProps> {
  const { h, t } = rt;
  const { cardHead } = makeUiKit({ h, t });

  return function VisibilityCard(props: VisibilityCardProps) {
    const total = props.pets.length;
    const shown = props.pets.filter((pet) => isPetVisible(pet.display)).length;
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('visibleTitle'), t('visibleHint')),
        h('p', {
          className: 'dsh-pet-cfg__note',
          children:
            total === 0
              ? t('emptyPets')
              : t('visibleCount').replace('{n}', String(shown)).replace('{m}', String(total)),
        }),
        total === 0
          ? null
          : h('div', {
              className: 'dsh-pet-cfg__picks',
              children: groupPetsByKind(props.pets).map((group) =>
                h('div', {
                  key: group.entry,
                  className: 'dsh-pet-cfg__pickGroup',
                  children: [
                    // 种类名与「种类」条保持同一套说法：内置用 kindMain，角色包直接用目录前缀。
                    h('span', {
                      key: 'kind',
                      className: 'dsh-pet-cfg__pickKind',
                      children: group.kind === 'main' ? t('kindMain') : group.entry,
                    }),
                    ...group.pets.map((pet) =>
                      h('div', {
                        key: pet.id,
                        className: 'dsh-pet-cfg__pickRow',
                        children: [
                          h('label', {
                            key: 'label',
                            children: [
                              h('input', {
                                key: 'box',
                                type: 'checkbox',
                                checked: isPetVisible(pet.display),
                                disabled: props.busy,
                                onChange: (e: ChangeEvent<HTMLInputElement>) =>
                                  props.onChange(pet.id, e.target.checked),
                              }),
                              h('span', {
                                key: 'name',
                                className: 'dsh-pet-cfg__pickName',
                                children: pet.name || pet.id,
                              }),
                            ],
                          }),
                          // 具体在哪儿出现仍以每只宠物自己的「显示位置」为准，这里只做只读提示。
                          h('span', {
                            key: 'meta',
                            className: 'dsh-pet-cfg__pickMeta',
                            children: t('display.' + pet.display),
                          }),
                        ],
                      }),
                    ),
                  ],
                }),
              ),
            }),
      ],
    });
  };
}
