import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { toChatMessages } from '../../src/client/chat/api.ts';
import { messageNode } from '../../src/client/chat/view-message.ts';
import { wowRecommendationsNode } from '../../src/client/chat/wow-recommendations.ts';
import { PANEL_CSS } from '../../src/client/chat/panel-css.ts';

const style = document.createElement('style');
style.textContent = PANEL_CSS;
document.head.append(style);
const rt = { h: jsx, useEffect, useRef, useState };
const message = toChatMessages({
  messages: [{ role: 'assistant', content: '可选插件如下', ts: 1, wowRecommendations: window.report }],
})[0];
const App = () =>
  messageNode(rt.h, {
    message,
    isMe: false,
    assetRoot: '',
    avatarVersion: 0,
    onOpenImage: () => {},
    recommendations: message.wowRecommendations ? wowRecommendationsNode(rt, message.wowRecommendations) : undefined,
  });
const root = createRoot(document.getElementById('root'));
root.render(jsx(App, {}));
window.disposeWowChat = () => root.unmount();
