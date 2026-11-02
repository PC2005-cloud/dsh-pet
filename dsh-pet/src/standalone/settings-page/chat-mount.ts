/**
 * 独立模式「对话」分区的浏览器入口：把 DSH 右侧栏那套面板挂到设置页上。
 *
 * 组件、状态与渲染树全部来自 client/chat，这里只补宿主那一侧：react 运行时由本包自己
 * 打包（独立环境没有 DSH 注入），样式走外链 CSS（页面 CSP 是 style-src 'self'，内联
 * style 会被拦掉）。平台 UI 原语在独立模式没有，面板按既有分支自行降级。
 * @module dsh-pet/src/standalone/settings-page/chat-mount
 */
import { createElement, useEffect, useRef, useState, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { makePetChatPanel } from '../../client/chat/panel.ts';
import type { ChatPanelRuntime } from '../../client/chat/runtime.ts';

/** 设置页里对话面板的挂载点 id，与 chrome.ts 的容器一致。 */
const HOST_ID = 'pet-chat-root';

/** 注入给面板的 react 能力；独立模式没有宿主可注入，用本包打进来的那份 react。 */
const runtime = { h: jsx, useState, useEffect, useRef } as unknown as ChatPanelRuntime;

const host = document.getElementById(HOST_ID);
if (host !== null) {
  const Panel = makePetChatPanel(runtime) as unknown as FC;
  createRoot(host).render(createElement(Panel));
}
