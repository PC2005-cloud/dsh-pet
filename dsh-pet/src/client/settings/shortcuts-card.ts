/**
 * 快捷键卡：把所有悬停键与全局快捷键列成一张表。
 *
 * 键位一律从各自模块的常量取，本模块不写第二份——改键只改那一处，卡片自动跟着变。
 * 与页尾其它参考卡一样默认收起：这页不是来看快捷键的，展开一次就够了。
 * 纯展示：不带配置状态，开合态只活在组件里。
 * @module dsh-pet/src/client/settings/shortcuts-card
 */
import type { FunctionComponent } from 'react';
import { HEAR_HOTKEY_HINT } from '../../shared/chat/hear-hold.ts';
import { CHAT_HOTKEY_HINT } from '../../shared/chat/hotkey.ts';
import { SLEEP_HOTKEY_HINT } from '../../shared/sleep-hotkey.ts';
import { TODO_HOTKEY_HINT } from '../../shared/todo/hotkey.ts';
import { PET_CHAT_SHORTCUT_HINT } from '../chat/shortcut.ts';
import { PET_FLOAT_SHORTCUT_HINT, PET_HEAR_SHORTCUT_HINT } from '../pet/card/shortcut.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

/** 折叠正文的 id：与标题按钮的 `aria-controls` 成对。 */
const BODY_ID = 'pet-cfg-shortcuts';

/**
 * 造快捷键卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeShortcutsCard(rt: SettingsRuntime): FunctionComponent {
  const { h, t, useState } = rt;
  const { foldCard } = makeUiKit({ h, t });

  return function ShortcutsCard() {
    const [open, setOpen] = useState(false);
    /** 一行：左边动作名，右边键帽。 */
    const row = (label: string, keys: string) =>
      h('div', {
        className: 'dsh-pet-cfg__field',
        children: [
          h('span', { key: 'l', className: 'dsh-pet-cfg__flabel', children: t(label) }),
          h('span', { key: 'v', className: 'dsh-pet-cfg__note', children: keys }),
        ],
      });

    return foldCard({
      id: BODY_ID,
      title: t('shortcutCardTitle'),
      hint: t('shortcutCardHint'),
      body: [
        h('div', {
          key: 'rows',
          className: 'dsh-pet-cfg__grid2',
          children: [
            row('shortcutRowChat', CHAT_HOTKEY_HINT + ' · ' + PET_FLOAT_SHORTCUT_HINT),
            row('shortcutRowHear', HEAR_HOTKEY_HINT + ' · ' + PET_HEAR_SHORTCUT_HINT),
            row('shortcutRowTodo', TODO_HOTKEY_HINT),
            row('shortcutRowSleep', SLEEP_HOTKEY_HINT),
            row('shortcutRowSidebar', PET_CHAT_SHORTCUT_HINT),
          ],
        }),
        h('p', { key: 'note', className: 'dsh-pet-cfg__note', children: t('shortcutNoteDesktop') }),
      ],
      open,
      onToggle: () => setOpen(!open),
    });
  };
}
