/**
 * 设置页 HTML 外壳：左侧分区导航 + 两个面板，AI 表单是静态标记，桌宠配置由脚本渲染。
 *
 * 页面只在本机回环上由 ./server 提供；CSP 是 `style-src 'self'`，所以这里不许出现内联样式，
 * 也不许内联脚本。桌宠配置面板的内容依赖 GET /config，初始只有一句占位文案。
 * 图标走设置页自己的公开资源路径（/standalone-ai/icon.png），内容读自包内 assets/logo.png，
 * 不复制第二份图；不能用插件路由 /logo——浏览器取 favicon 不带 Origin 也不带令牌，会被判成文件来源而 403。
 * @module dsh-pet/src/standalone/settings-page/chrome
 */

/** 设置页 HTML。 */
export const settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="icon" type="image/png" href="/standalone-ai/icon.png"><link rel="stylesheet" href="/standalone-ai/settings.css">
<script src="/standalone-ai/settings.js" defer></script></head><body>
<main class="shell">
<div class="navTitle">桌宠设置</div>
<div class="topbar"><span class="dirty" id="dirty" hidden>有未保存的改动</span></div>
<nav class="nav" aria-label="设置分区"><div class="navList" role="tablist">
<button type="button" class="navCell" role="tab" id="tab-pets" data-tab="pets" aria-controls="panel-pets" aria-selected="true"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="6" r="1.6"/><circle cx="11" cy="6" r="1.6"/><circle cx="2.9" cy="9.4" r="1.25"/><circle cx="13.1" cy="9.4" r="1.25"/><path d="M8 8.3c1.9 0 3.5 1.4 3.5 3S9.9 13.7 8 13.7 4.5 12.9 4.5 11.3 6.1 8.3 8 8.3Z"/></g></svg><span class="navLabel">桌宠配置</span></button>
<button type="button" class="navCell" role="tab" id="tab-ai" data-tab="ai" aria-controls="panel-ai" aria-selected="false"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4l1.25 3.95 3.95 1.25-3.95 1.25L8 12.8 6.75 8.85 2.8 7.6l3.95-1.25z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="navLabel">AI 服务商</span></button>
</div></nav>
<div class="options">
<section class="panel" id="panel-pets" role="tabpanel" aria-labelledby="tab-pets">
<div class="scroll" id="pet-cards"><p class="empty">正在读取本机配置…</p></div>
<div class="footer"><p class="status" id="pet-status" role="status" aria-live="polite"></p><button class="btn primary" id="pet-save" type="button" disabled>保存</button></div>
</section>
<section class="panel" id="panel-ai" role="tabpanel" aria-labelledby="tab-ai" hidden>
<form id="settings" aria-describedby="privacy">
<div class="scroll">
<div class="card"><div class="cardHead"><h2 class="cardTitle">模型连接</h2></div>
<p class="cardHint">独立模式自己连服务商，不经过 DSH；所有配置只保存在当前机器。</p>
<div class="field"><span class="fieldLabel" id="protocol-label">接口协议</span><div id="protocol-host"></div></div>
<div class="field"><label for="baseUrl">接口地址（Base URL）</label><input id="baseUrl" name="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false" aria-describedby="endpoint-note"><p class="fieldHint" id="endpoint-note">服务商提供的基础接口地址，支持 HTTP 与 HTTPS，通常以 /v1 结尾。不要把密钥放进地址。</p></div>
<div class="field"><label for="model">模型名称</label><div class="combo" id="model-combo"><input id="model" name="model" type="text" maxlength="200" placeholder="填写或拉取服务商的模型 ID，例如 deepseek-chat" spellcheck="false" aria-describedby="model-note"><button id="model-toggle" class="comboToggle" type="button" aria-label="拉取并选择模型" aria-haspopup="listbox" aria-expanded="false"></button></div><p class="fieldHint" id="model-note">可以直接手填；点右侧箭头向端点拉取可用列表后选择。拉取只用本次填写的地址与密钥，不会保存。</p><p class="status" id="model-result" role="status" aria-live="polite"></p></div>
<div class="field"><label for="apiKey">API 密钥 <span class="hintInline" id="key-state">尚未读取</span></label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥" aria-describedby="key-note"><div class="keyActions" id="key-actions" hidden><button id="key-delete" class="btn ghost" type="button">删除已保存的密钥</button></div><p id="key-note" class="fieldHint">密钥只写入本机配置，不会回显。留空会保留旧密钥，要彻底删除请点上面的按钮。</p></div>
<div class="testRow"><button id="test-btn" class="btn" type="button">测试连接</button><span id="test-result" class="status" role="status" aria-live="polite"></span></div>
</div>
<p id="privacy" class="fineprint">所有配置与密钥仅保存在当前机器。</p>
</div>
<div class="footer"><p class="status" id="status" role="status" aria-live="polite">正在读取本机设置…</p><button id="save" class="btn primary" type="submit" disabled>保存</button></div>
</form>
</section>
</div>
</main>
<noscript>需要启用 JavaScript 才能保存设置。请从桌宠右键菜单打开本页。</noscript>
</body></html>`;
