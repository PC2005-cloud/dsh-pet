/**
 * 两张「落盘位置」展示卡：高级配置（配置文件、表情包、日志路径）与卸载与存储（清单 + 卸载命令）。
 * 数据同源于 `GET /config/meta`，读不到时两张卡都整块不出现——缺路径提示比给错路径更安全。
 * 只读展示，没有可编辑控件，因此不需要 busy。
 * 两张卡都是「标题行 + 折叠正文」，默认收起：页尾这两块不是每次都要看，收起后整页少滚一屏。
 * 开合状态只活在组件里，关掉设置页再打开还是收起——不写盘，也不与配置里的任何字段相关。
 * @module dsh-pet/src/client/settings/paths-cards
 */
import type { FunctionComponent } from 'react';
import type { ConfigMeta } from './config/index.ts';
import type { SettingsRuntime } from './runtime.ts';
import { MONO_STACK, makeUiKit } from './ui.ts';

/** 两张卡的共同输入。 */
export interface PathsCardProps {
  /** 宿主给出的路径与存储清单。 */
  paths: ConfigMeta;
}

/** 一对落盘位置卡。 */
export interface PathsCards {
  /** 高级配置：默认配置、用户配置、动画目录、表情包目录与日志文件路径。 */
  ConfigMetaCard: FunctionComponent<PathsCardProps>;
  /** 卸载与存储：插件落盘的全部位置 + 卸载步骤与命令。 */
  StorageCard: FunctionComponent<PathsCardProps>;
}

/** 折叠正文的 id：与按钮的 `aria-controls` 成对，两张卡各一份。 */
const BODY_ID = {
  meta: 'pet-cfg-paths-meta',
  storage: 'pet-cfg-paths-storage',
} as const;

/**
 * 造两张落盘位置卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 两个卡片组件。
 */
export function makePathsCards(rt: SettingsRuntime): PathsCards {
  const { h, t, useState } = rt;
  const { foldCard } = makeUiKit({ h, t });

  function ConfigMetaCard(props: PathsCardProps) {
    const { paths } = props;
    const [open, setOpen] = useState(false);
    const line = (key: string, value: string | undefined, suffix = '') =>
      value === undefined
        ? null
        : h('div', { key, className: 'dsh-pet-cfg__path', children: t(key) + '：' + value + suffix });
    const body = [
      line('defaultConfig', paths.default),
      line('userConfig', paths.user),
      line('todosFile', paths.todos),
      line('animationDir', paths.animations),
      line('memesDir', paths.memes),
      // 日志文件路径 + 一句说明；其余位置的用途都在问号里，唯独这条写在明面上——反馈问题时要先找它。
      line('logFile', paths.logs),
      paths.logs ? h('div', { key: 'logNote', className: 'dsh-pet-cfg__note', children: t('logFileNote') }) : null,
    ];
    return foldCard({
      id: BODY_ID.meta,
      title: t('configMeta'),
      hint: t('configMetaHint'),
      body,
      open,
      onToggle: () => setOpen(!open),
    });
  }

  function StorageCard(props: PathsCardProps) {
    const { paths } = props;
    // hook 必须在早退之前：storage 为空时整卡不渲染，但那时也走同一条 hook 路径。
    const [open, setOpen] = useState(false);
    const storage = paths.storage ?? [];
    if (storage.length === 0) return null;
    const body = [
      // 存储位置清单：每条都是「路径（等宽、可选中复制）到作用」。
      ...storage.map((entry) =>
        h('div', {
          key: entry.key,
          className: 'dsh-pet-cfg__path',
          children: [
            h('b', { key: 'p', style: { fontFamily: MONO_STACK }, children: entry.path }),
            // 尚未产生的目录标一下，避免用户去找不存在的文件夹。
            h('span', {
              key: 'd',
              children: ' — ' + t('storage.' + entry.key) + (entry.exists === false ? t('storageMissing') : ''),
            }),
          ],
        }),
      ),
      h('div', {
        key: 'ut',
        className: 'dsh-pet-cfg__cardTitle',
        style: { marginTop: '4px' },
        children: t('uninstallTitle'),
      }),
      h('div', { key: 'u1', className: 'dsh-pet-cfg__note', children: t('uninstallStep1') }),
      h('div', { key: 'u2', className: 'dsh-pet-cfg__note', children: t('uninstallStep2') }),
      h('div', {
        key: 'cmd',
        className: 'dsh-pet-cfg__cmd',
        children: t('uninstallCmd').replace('{profile}', paths.profile || '<profile>'),
      }),
      h('div', { key: 'u3', className: 'dsh-pet-cfg__note', children: t('uninstallStep3') }),
    ];
    return foldCard({
      id: BODY_ID.storage,
      title: t('storageTitle'),
      hint: t('storageHint'),
      body,
      open,
      onToggle: () => setOpen(!open),
    });
  }

  return { ConfigMetaCard, StorageCard };
}
