/**
 * 独立模式「对话」分区的浏览器入口：把 DSH 右侧栏那套面板挂到设置页上。
 *
 * 组件、状态与渲染树全部来自 client/chat，这里只补宿主那一侧：react 运行时由本包自己
 * 打包（独立环境没有 DSH 注入），文案走包内 zh 字典（无 locale 服务），样式走外链
 * CSS（页面 CSP 是 style-src 'self'，内联 style 会被拦掉）。平台 UI 原语在独立模式
 * 没有，面板按既有分支自行降级。
 * @module dsh-pet/src/standalone/settings-page/chat-mount
 */
import { createElement, useEffect, useRef, useState, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { zh } from '../../client/chat/locales/index.ts';
import { makePetChatPanel } from '../../client/chat/panel.ts';
import type { ChatPanelRuntime } from '../../client/chat/runtime.ts';
import { createTranslator } from './translate.ts';

/** 设置页里对话面板的挂载点 id，与 chrome.ts 的容器一致。 */
const HOST_ID = 'pet-chat-root';

/**
 * 注入给面板的 react 能力与文案；独立模式没有宿主可注入，用本包打进来的那份 react。
 *
 * 只对 `h` 做断言：jsx 的参数类型是 `ElementType`，与运行时契约的 `unknown` 不兼容，
 * 但两者在运行时是同一个函数。其余字段保持类型检查，缺字段会在编译期直接报错。
 */
const runtime: ChatPanelRuntime = {
  h: jsx as ChatPanelRuntime['h'],
  useState,
  useEffect,
  useRef,
  t: createTranslator(zh),
};

const host = document.getElementById(HOST_ID);
if (host !== null) {
  const Panel = makePetChatPanel(runtime) as unknown as FC;
  createRoot(host).render(createElement(Panel));
}
