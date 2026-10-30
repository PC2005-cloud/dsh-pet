/**
 * 对话面板的 CSS 文本：只在这里写选择器与 token，不出现字面色值。
 *
 * 尺寸统一走 ./metrics 的 {@link SIZE}（CSS 与输入框自动长高共用一份），
 * 与 styles.ts 分开是因为这里是纯字符串：改样式时 diff 只落在这里。
 * @module dsh-pet/src/client/chat/panel-css
 */
import { px, SIZE } from './metrics.ts';

/** 面板样式（选择器前缀 `pet-chat`，避免与 DSH 或其它插件撞名）。 */
export const PANEL_CSS = `
.pet-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: ${px(SIZE.gapWide)};
  padding: ${px(SIZE.pad)} ${px(SIZE.pad)} ${px(SIZE.padBottom)};
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
}

.pet-chat-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: ${px(SIZE.gapTight)};
  flex: 0 0 auto;
}

.pet-chat-tab {
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: var(--dsw-radius-md);
  padding: ${px(SIZE.tabPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-tab[aria-pressed="true"] {
  background: var(--dsw-alias-bg-multi-select);
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.pet-chat-tools {
  display: flex;
  justify-content: flex-end;
  gap: ${px(SIZE.gapTight)};
  flex: 0 0 auto;
}

/* 人设卷帘：展开时把消息列表顶下去，而不是浮在对话上——人设可以很长，浮层会挡住内容。
   0fr → 1fr 是唯一不用量高度的展开过渡；夹层负责裁剪，正文层才放内边距与边框，
   否则收起时 padding 与 border 仍在，留下一道缝。 */
.pet-chat-persona {
  display: grid;
  grid-template-rows: 0fr;
  flex: 0 0 auto;
  transition: grid-template-rows var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-persona.is-open {
  grid-template-rows: 1fr;
}

.pet-chat-persona-clip {
  min-height: 0;
  overflow: hidden;
}

.pet-chat-persona-body {
  max-height: ${px(SIZE.personaMaxH)};
  overflow-y: auto;
  padding: ${px(SIZE.bubblePadY)} ${px(SIZE.bubblePadX)};
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
  line-height: 1.6;
  /* 人设正文自己带换行与缩进：保留排版，长单词与 URL 也要能断开 */
  white-space: pre-wrap;
  word-break: break-word;
}

.pet-chat-orphans {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  flex: 0 0 auto;
  padding: ${px(SIZE.gapTight)} ${px(SIZE.tabPadX)};
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-multi-select);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-confirm {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  flex: 0 0 auto;
  padding: ${px(SIZE.gapTight)} ${px(SIZE.tabPadX)};
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-danger {
  flex: 0 0 auto;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
  padding: ${px(SIZE.toolPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-danger:hover {
  background: var(--dsw-alias-state-error-secondary);
}

.pet-chat-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: ${px(SIZE.gap)};
}

/* 指南页卡片图标：框架给的槽位只按图标尺寸排版，所以让 logo 铺满它 */
.pet-chat-guide-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: var(--dsw-radius-xs);
  display: block;
}

.pet-chat-tool {
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: var(--dsw-radius-sm);
  padding: ${px(SIZE.toolPadY)} ${px(SIZE.toolPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
}

.pet-chat-tool:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-tool[aria-pressed="true"] {
  background: var(--dsw-alias-bg-multi-select);
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}

.pet-chat-tool:disabled {
  opacity: 0.5;
  cursor: default;
}

.pet-chat-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: ${px(SIZE.listGap)};
  padding-right: ${px(SIZE.hairline)};
}

.pet-chat-older {
  display: flex;
  justify-content: center;
  flex: 0 0 auto;
}

.pet-chat-older-btn {
  border: none;
  border-radius: ${px(SIZE.pill)};
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  padding: ${px(SIZE.pillPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-older-btn:hover {
  background: var(--dsw-alias-interactive-bg-active);
}

.pet-chat-older-note {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  padding: ${px(SIZE.pillPadY)} 0;
}

.pet-chat-memory {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption);
  font: var(--dsw-font-xxxs-11);
}

/* 线本身用伪元素画，文字居中：视觉上是「一条带说明的分隔线」 */
.pet-chat-memory::before,
.pet-chat-memory::after {
  content: '';
  flex: 1 1 auto;
  border-top: 1px dashed var(--dsw-alias-border-l3);
}

.pet-chat-memory-note {
  flex: 0 0 auto;
}

.pet-chat-round {
  display: flex;
  align-items: flex-start;
  gap: ${px(SIZE.gap)};
}

/* 多选模式：整轮是一张可点卡片；选中给浅底，未选中透明（与豆包的选中样式一致） */
.pet-chat-round.is-selecting {
  padding: ${px(SIZE.gapTight)} ${px(SIZE.gapWide)};
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-round.is-selecting:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-round.is-selected {
  background: var(--dsw-alias-bg-multi-select);
}

.pet-chat-pick {
  flex: 0 0 auto;
  padding-top: ${px(SIZE.gapTight)};
  opacity: 0.55;
  cursor: pointer;
}

.pet-chat-pick:hover {
  opacity: 1;
}

.pet-chat-round-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: ${px(SIZE.gap)};
}

.pet-chat-msg {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: ${px(SIZE.gap)};
  max-width: 92%;
}

.pet-chat-msg.is-me {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.pet-chat-msg.is-pet {
  align-self: flex-start;
}

.pet-chat-avatar {
  flex: 0 0 auto;
  width: ${px(SIZE.avatar)};
  height: ${px(SIZE.avatar)};
  border-radius: 50%;
  object-fit: cover;
}

.pet-chat-msg.is-pet .pet-chat-avatar {
  border: 1px solid var(--dsw-alias-border-l2);
}

.pet-chat-bubble {
  padding: ${px(SIZE.bubblePadY)} ${px(SIZE.bubblePadX)};
  border-radius: var(--dsw-radius-md);
  word-break: break-word;
  line-height: 1.6;
}

.pet-chat-text {
  white-space: pre-wrap;
}

.pet-chat-msg.is-me .pet-chat-bubble {
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
}

.pet-chat-msg.is-pet .pet-chat-bubble {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
}

.pet-chat-img-btn {
  display: block;
  margin-top: ${px(SIZE.gapTight)};
  padding: 0;
  border: none;
  background: none;
  cursor: zoom-in;
}

.pet-chat-img {
  display: block;
  max-width: ${px(SIZE.imgMaxW)};
  max-height: ${px(SIZE.imgMaxH)};
  border-radius: var(--dsw-radius-sm);
  object-fit: contain;
}

.pet-chat-time {
  display: inline-flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  margin-top: ${px(SIZE.hairline)};
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-caption);
}

/* 时间右边的播报按钮：与时间同字号，靠透明度与颜色表意，不占额外行高 */
.pet-chat-speak {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${px(SIZE.hairline * 12)};
  height: ${px(SIZE.hairline * 12)};
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  line-height: 1;
  color: inherit;
  cursor: pointer;
  opacity: 0.55;
  transition:
    opacity 0.15s,
    color 0.15s;
}

.pet-chat-speak:hover {
  opacity: 1;
}

/* 生成中：只有上半圈带色的细环，靠旋转表达「在生成」。
   尺寸与时间文字同高；border-box + flex:none 是必须的：默认 content-box 会把描边算在尺寸外，
   而在 flex 行里被压缩时环会变成椭圆，看着就是个「奇怪的圆角方块」。 */
.pet-chat-speak.is-loading {
  opacity: 0.9;
  cursor: default;
}

.pet-chat-speak.is-loading::before {
  content: '';
  box-sizing: border-box;
  flex: none;
  width: ${px(SIZE.spinner)};
  height: ${px(SIZE.spinner)};
  border: 1.5px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-label-secondary);
  border-radius: 50%;
  animation: pet-chat-spin 0.8s linear infinite;
}

/* 播放中：主色 + 满不透明，和「可播放」明显区分 */
.pet-chat-speak.is-playing {
  opacity: 1;
  color: var(--dsw-alias-state-business-primary);
  cursor: default;
}

/* 失败：压暗表示没成，但仍可点（重试），所以指针保持手型 */
.pet-chat-speak.is-failed {
  opacity: 0.5;
}

@keyframes pet-chat-spin {
  to {
    transform: rotate(360deg);
  }
}

.pet-chat-time.is-pet {
  align-self: flex-start;
  /* 与宠物气泡左沿对齐：让时间明显属于这一轮的回答，而不是下一轮提问的开头 */
  margin-left: ${px(SIZE.avatar + SIZE.gap)};
}

.pet-chat-time.is-me {
  align-self: flex-end;
}

.pet-chat-hint {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-error {
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: ${px(SIZE.gapTight)};
  padding: ${px(SIZE.composerPad)} ${px(SIZE.pad)} ${px(SIZE.composerPadBottom)};
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-specific-input-major);
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-composer:focus-within {
  border-color: var(--dsw-alias-state-business-primary);
}

.pet-chat-composer.is-drop-target {
  border-color: var(--dsw-alias-state-business-primary);
}

.pet-chat-preview {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
}

.pet-chat-preview-img {
  width: ${px(SIZE.preview)};
  height: ${px(SIZE.preview)};
  object-fit: cover;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
}

.pet-chat-preview-meta {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}

.pet-chat-input {
  width: 100%;
  resize: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  padding: 0;
  min-height: ${px(SIZE.inputMinH)};
  max-height: ${px(SIZE.inputMaxH)};
  overflow-y: auto;
  font: var(--dsw-font-s-14);
  outline: none;
}

.pet-chat-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

.pet-chat-composer-bar {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
}

.pet-chat-attach {
  display: inline-flex;
  align-items: center;
  gap: ${px(SIZE.hairline)};
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: ${px(SIZE.pill)};
  padding: ${px(SIZE.pillPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-attach:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-file {
  display: none;
}

.pet-chat-composer-spacer {
  flex: 1 1 auto;
}

.pet-chat-send {
  flex: 0 0 auto;
  width: ${px(SIZE.send)};
  height: ${px(SIZE.send)};
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-foreground);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-send:hover:not(:disabled) {
  background: var(--dsw-alias-button-info-hover);
}

.pet-chat-send:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 悬浮提示气泡：挂在 body 上按光标定位（见 ./tooltip），不在 .pet-chat 里，
   所以字体与颜色全部自带——气泡是深色底，两种主题下都靠白字与背景的对比度读。 */
.pet-chat-tip {
  position: fixed;
  z-index: 2147483000;
  max-width: ${px(SIZE.tipMaxW)};
  padding: ${px(SIZE.tipPadY)} ${px(SIZE.tipPadX)};
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-tooltip-bg);
  color: var(--dsw-static-neutral-00);
  font: var(--dsw-font-xxs-12);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-tip.is-on {
  opacity: 1;
}
`;
