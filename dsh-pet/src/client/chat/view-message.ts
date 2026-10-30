/**
 * 一条消息与一轮对话的节点：头像、气泡（文字 + 图片）、轮（问 + 答 + 时间）。
 *
 * 纯映射，不做取数与状态；时间的位置是唯一的约定：贴着这一轮最后一条消息。
 * @module dsh-pet/src/client/chat/view-message
 */
import { attachmentUrl, LOGO_URL, memeUrl, type ChatMessageView } from './api.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import { formatStamp } from './stamp.ts';
import { tipAttrs } from './tooltip.ts';
import type { ChatPanelState } from './types.ts';

/** 语音播报按钮：贴在时间右边，四种状态一眼可分——可播 / 生成中转圈 / 播放中高亮 / 失败可重试。 */
function speakNode(h: ChatPanelRuntime['h'], text: string, ts: number, state: ChatPanelState): unknown {
  const phase = state.speaking?.ts === ts ? state.speaking.phase : 'idle';
  const label =
    phase === 'loading'
      ? '正在生成语音…'
      : phase === 'playing'
        ? '正在播放'
        : phase === 'failed'
          ? '播放失败，点击重试'
          : '播放这句';
  return h('button', {
    type: 'button',
    className: 'pet-chat-speak is-' + phase,
    'aria-label': label,
    ...tipAttrs(label),
    onClick: (event: { stopPropagation: () => void }) => {
      // 多选模式下整轮可点：这里必须拦一下，否则点喇叭会顺手切换选中
      event.stopPropagation();
      // 失败也允许再点一次：合成偶发失败时不必刷新面板
      if (phase === 'idle' || phase === 'failed') state.speakRound(ts, text);
    },
    // 生成中由 CSS 的 ::before 画转圈，按钮本身不放字符；失败换成静音喇叭
    children: phase === 'loading' ? null : phase === 'failed' ? '🔇' : '🔊',
  });
}

/**
 * 头像：宠物用插件 logo，我是一只 Q 版小脸（圆脸 + 呆毛 + 腮红 + 星星）。
 *
 * 画成内联 SVG 而不是图片：能直接用主题 token（深浅色自动跟随），也不用多一个资源请求。
 * 造型对齐桌宠的二次元调性，不与插件 logo 抢风格。
 */
export function avatarNode(h: ChatPanelRuntime['h'], isMe: boolean): unknown {
  if (!isMe) return h('img', { className: 'pet-chat-avatar', src: LOGO_URL, alt: '', loading: 'lazy' });
  return h('svg', {
    className: 'pet-chat-avatar',
    viewBox: '0 0 32 32',
    'aria-hidden': 'true',
    children: [
      h('circle', { cx: 16, cy: 16, r: 16, fill: 'var(--dsw-specific-bubble)' }),
      h('circle', { cx: 16, cy: 17.5, r: 9.5, fill: 'var(--dsw-alias-bg-layer-1)' }),
      // 刘海：盖住脸的上沿，留出呆毛
      h('path', {
        d: 'M6.8 15.5a9.2 9.2 0 0 1 18.4 0q-4.6-4.2-9.2-4.2t-9.2 4.2z',
        fill: 'var(--dsw-alias-label-tertiary)',
        opacity: 0.75,
      }),
      h('path', {
        d: 'M16 9.2q1.1-2.6 3.4-1.7',
        fill: 'none',
        stroke: 'var(--dsw-alias-label-tertiary)',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        opacity: 0.75,
      }),
      // 眼睛 + 高光
      h('ellipse', { cx: 12.4, cy: 17.6, rx: 1.5, ry: 2, fill: 'var(--dsw-alias-label-primary)' }),
      h('ellipse', { cx: 19.6, cy: 17.6, rx: 1.5, ry: 2, fill: 'var(--dsw-alias-label-primary)' }),
      h('circle', { cx: 12.9, cy: 16.8, r: 0.5, fill: 'var(--dsw-alias-bg-layer-1)' }),
      h('circle', { cx: 20.1, cy: 16.8, r: 0.5, fill: 'var(--dsw-alias-bg-layer-1)' }),
      // 腮红
      h('ellipse', {
        cx: 9.6,
        cy: 21,
        rx: 1.7,
        ry: 1.1,
        fill: 'var(--dsw-alias-state-error-secondary)',
        opacity: 0.45,
      }),
      h('ellipse', {
        cx: 22.4,
        cy: 21,
        rx: 1.7,
        ry: 1.1,
        fill: 'var(--dsw-alias-state-error-secondary)',
        opacity: 0.45,
      }),
      // 嘴
      h('path', {
        d: 'M14.6 21.6q1.4 1.5 2.8 0',
        fill: 'none',
        stroke: 'var(--dsw-alias-label-secondary)',
        strokeWidth: 1,
        strokeLinecap: 'round',
      }),
      // 星星：点一下「我在」的感觉
      h('path', {
        d: 'M25.5 5.5v4M23.5 7.5h4',
        fill: 'none',
        stroke: 'var(--dsw-alias-state-business-primary)',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        opacity: 0.9,
      }),
    ],
  });
}

/**
 * 一条消息：头像 + 气泡；图片排在文字之后，点一下放大。
 *
 * `onOpenImage` 由轮节点传入，本模块不直接碰面板状态。
 */
export function messageNode(
  h: ChatPanelRuntime['h'],
  message: ChatMessageView,
  isMe: boolean,
  assetRoot: string,
  onOpenImage: (url: string) => void,
): unknown {
  const image =
    message.image !== undefined
      ? attachmentUrl(message.image)
      : message.meme !== undefined
        ? memeUrl(message.meme, assetRoot)
        : undefined;
  return h('div', {
    className: 'pet-chat-msg ' + (isMe ? 'is-me' : 'is-pet'),
    children: [
      avatarNode(h, isMe),
      h('div', {
        className: 'pet-chat-bubble',
        children: [
          h('div', { className: 'pet-chat-text', children: message.text }),
          image === undefined
            ? null
            : h('button', {
                type: 'button',
                className: 'pet-chat-img-btn',
                'aria-label': '点开看大图',
                ...tipAttrs('点开看大图'),
                onClick: () => onOpenImage(image),
                children: h('img', { className: 'pet-chat-img', src: image, alt: '对话图片', loading: 'lazy' }),
              }),
        ],
      }),
    ],
  });
}

/** 一轮：问 + 答 + 时间；勾选框只在多选模式下出现。 */
export function roundNode(
  rt: ChatPanelRuntime,
  state: ChatPanelState,
  round: ChatPanelState['rounds'][number],
): unknown {
  const { h } = rt;
  const selected = state.selected.includes(round.ts);
  // 多选模式下整轮是一张可点的卡片：选中给浅底，未选中透明（与豆包一致）
  const className = 'pet-chat-round' + (state.selecting ? ' is-selecting' : '') + (selected ? ' is-selected' : '');
  return h('div', {
    key: String(round.ts),
    className,
    // 多选模式下整行可点；点勾选框、图片按钮或链接时交给它们自己处理，避免切换两次
    onClick: state.selecting
      ? (event: { target: unknown }) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (target.closest('.pet-chat-pick, button, a, [role="button"]') !== null) return;
          state.toggleRound(round.ts);
        }
      : undefined,
    children: [
      state.selecting
        ? h('label', {
            className: 'pet-chat-pick',
            title: '选中这一轮（问 + 答一起删）',
            children: [
              h('input', {
                type: 'checkbox',
                checked: selected,
                onChange: () => state.toggleRound(round.ts),
                'aria-label': '选中这一轮',
              }),
            ],
          })
        : null,
      h('div', {
        className: 'pet-chat-round-body',
        children: [
          round.user === undefined ? null : messageNode(h, round.user, true, state.assetRoot, state.showImage),
          round.assistant === undefined
            ? null
            : messageNode(h, round.assistant, false, state.assetRoot, state.showImage),
          // 时间跟着这一轮的最后一条消息走：有回答就贴在回答下方，否则贴在我的问题下方
          round.ts > 0
            ? h('div', {
                className: 'pet-chat-time ' + (round.assistant === undefined ? 'is-me' : 'is-pet'),
                children: [
                  formatStamp(round.ts, Date.now()),
                  // 只有回答那句能点播：用户自己的话没有语音
                  round.assistant === undefined ? null : speakNode(h, round.assistant.text, round.ts, state),
                ],
              })
            : null,
        ],
      }),
    ],
  });
}
