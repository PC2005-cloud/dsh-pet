/**
 * 快捷键卡：把键分成两组——宠物自己的悬停键，与 DSH 分发的全局快捷键。
 *
 * 悬停键是插件自己的监听，直接读各模块常量；全局快捷键的键位可以被用户改绑，
 * 必须问 DSH 要当前值——否则改完绑，这张卡还在念默认组合。
 * 分组不是排版偏好：两组键由不同代码派发、生效条件也不同（悬停 vs 页面任意位置），
 * 混在一张表里读者分不清按了没反应是哪种原因。
 * 与页尾其它参考卡一样默认收起；纯展示，开合态只活在组件里。
 * @module dsh-pet/src/client/settings/shortcuts-card
 */
import type { FunctionComponent } from 'react';
import { HEAR_HOTKEY_HINT } from '../../shared/chat/hear-hold.ts';
import { CAPTURE_HOTKEY_HINT, CHAT_HOTKEY_HINT } from '../../shared/chat/hotkey.ts';
import { DISPLAY_HOTKEY_HINTS } from '../../shared/display-hotkey.ts';
import { SLEEP_HOTKEY_HINT } from '../../shared/sleep-hotkey.ts';
import { TODO_HOTKEY_HINT } from '../../shared/todo/hotkey.ts';
import { keycapOf, subscribeShortcutKeycaps, type ShortcutHost } from '../app-shortcut.ts';
import { petChatShortcutKeycap } from '../chat/shortcut.ts';
import { petShortcutKeycap } from '../pet/card/shortcut.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

/** 折叠正文的 id：与标题按钮的 `aria-controls` 成对。 */
const BODY_ID = 'pet-cfg-shortcuts';

/** 粘贴不是我们注册的命令，键帽按平台推导（macOS 是 ⌘V），不写死字符串。 */
const PASTE_KEYCAP = keycapOf({ code: 'KeyV', modifiers: ['primary'] });

/** 三条可改绑命令的当前键帽；悬停键不在这里——它们不能改绑。 */
interface GlobalKeycaps {
  /** 开关浮动对话。 */
  readonly open: string;
  /** 开关录音。 */
  readonly hear: string;
  /** 截图。 */
  readonly capture: string;
  /** 打开右侧栏对话面板。 */
  readonly sidebar: string;
}

/** 现读一遍三条全局命令的键帽。 */
function readKeycaps(ctx: ShortcutHost): GlobalKeycaps {
  return {
    open: petShortcutKeycap(ctx, 'chat'),
    hear: petShortcutKeycap(ctx, 'hear'),
    capture: petShortcutKeycap(ctx, 'capture'),
    sidebar: petChatShortcutKeycap(ctx),
  };
}

/**
 * 造快捷键卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @param ctx - 客户端上下文：读改绑后的键位。
 * @returns 卡片组件。
 */
export function makeShortcutsCard(rt: SettingsRuntime, ctx: ShortcutHost): FunctionComponent {
  const { h, t, useState, useEffect } = rt;
  const { foldCard } = makeUiKit({ h, t });

  return function ShortcutsCard() {
    const [open, setOpen] = useState(false);
    // 每次渲染现读一遍：目录只是几十行数组，读它比维护一份缓存更省事。
    const [keycaps, setKeycaps] = useState<GlobalKeycaps>(readKeycaps(ctx));
    // 改绑发生在「设置 → 快捷键」那一页，切回来时必须重新读一次。
    useEffect(() => subscribeShortcutKeycaps(ctx, () => setKeycaps(readKeycaps(ctx))), []);
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
        h('p', { key: 'petTitle', className: 'dsh-pet-cfg__cardTitle', children: t('shortcutGroupPet') }),
        h('p', { key: 'petHint', className: 'dsh-pet-cfg__note', children: t('shortcutGroupPetHint') }),
        h('div', {
          key: 'petRows',
          className: 'dsh-pet-cfg__grid2',
          children: [
            row('shortcutRowChat', CHAT_HOTKEY_HINT),
            row('shortcutRowHold', HEAR_HOTKEY_HINT),
            row('shortcutRowCapture', CAPTURE_HOTKEY_HINT),
            row('shortcutRowPaste', PASTE_KEYCAP),
            row('shortcutRowTodo', TODO_HOTKEY_HINT),
            row('shortcutRowSleep', SLEEP_HOTKEY_HINT),
            row('shortcutRowDisplay', DISPLAY_HOTKEY_HINTS.join(' · ')),
          ],
        }),
        h('p', { key: 'globalTitle', className: 'dsh-pet-cfg__cardTitle', children: t('shortcutGroupGlobal') }),
        h('p', { key: 'globalHint', className: 'dsh-pet-cfg__note', children: t('shortcutGroupGlobalHint') }),
        h('div', {
          key: 'globalRows',
          className: 'dsh-pet-cfg__grid2',
          children: [
            row('shortcutRowChat', keycaps.open),
            row('shortcutRowHear', keycaps.hear),
            row('shortcutRowCapture', keycaps.capture),
            row('shortcutRowSidebar', keycaps.sidebar),
          ],
        }),
      ],
      open,
      onToggle: () => setOpen(!open),
    });
  };
}
