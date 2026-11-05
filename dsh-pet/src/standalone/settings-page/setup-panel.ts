/** Guided setup keeps existing credentials private and advanced model settings optional. */
export const setupPanel = `
<section class="panel" id="panel-setup" role="tabpanel" aria-labelledby="tab-setup" hidden><div class="scroll">
<form id="quick-setup"><div class="card"><div class="cardHead"><h2 class="cardTitle">让她先陪你聊起来</h2></div>
<p class="cardHint">选好服务商，填入密钥，再决定是否开启长期记忆。已有聊天配置可以直接沿用。</p>
<fieldset id="setup-fields" class="setupFields">
<div class="field" id="setup-reuse-row" hidden><label><input id="setup-reuse" type="checkbox"> 沿用当前聊天配置</label><p id="setup-saved-chat" class="fieldHint"></p></div>
<div class="field"><label for="setup-provider">模型预设</label><select id="setup-provider"><option value="qwen">通义千问</option><option value="openai">OpenAI</option><option value="custom">其他 OpenAI 兼容服务</option></select></div>
<div class="field" id="setup-region-row"><label for="setup-region">Key 所属地域</label><select id="setup-region"><option value="beijing">北京</option><option value="singapore">新加坡</option></select><p class="fieldHint">地址随地域填写。请使用该地域的 Key；也可在下方填写业务空间专属地址。</p></div>
<div class="field"><label for="setup-url">接口地址</label><input id="setup-url" type="url" required maxlength="2048" value="https://dashscope.aliyuncs.com/compatible-mode/v1" spellcheck="false"></div>
<div class="field"><label for="setup-key">API 密钥</label><input id="setup-key" type="password" required maxlength="4096" autocomplete="new-password" placeholder="填写服务商提供的密钥"><p id="setup-key-hint" class="fieldHint">密钥只保存在本机。</p></div>
<div class="field"><label><input id="setup-memory" type="checkbox"> 开启本机长期记忆</label><p class="fieldHint">首次自动准备 PowerContext 1.5.0，以后随桌宠启停。聊天、模型检查、记忆整理和检索可能产生模型费用。</p></div>
<details id="setup-model-details"><summary>高级选项：模型与 Embedding</summary>
<div class="field"><label for="setup-model">聊天与记忆整理模型</label><input id="setup-model" type="text" required maxlength="200" value="qwen3.7-plus"></div>
<div id="setup-embedding-fields" hidden>
<div class="field"><label for="setup-embedding-model">Embedding 模型</label><input id="setup-embedding-model" type="text" maxlength="200" value="qwen3.7-text-embedding"></div>
<div class="field"><label for="setup-dimension">向量维度</label><input id="setup-dimension" type="number" min="1" max="65536" value="1024"></div>
<div class="field"><label for="setup-embedding-url">Embedding 接口地址（可选）</label><input id="setup-embedding-url" type="url" maxlength="2048" placeholder="留空使用聊天服务地址"></div>
<div class="field"><label for="setup-embedding-key">Embedding 密钥（可选）</label><input id="setup-embedding-key" type="password" maxlength="4096" autocomplete="new-password" placeholder="原地址沿用已保存密钥；同址新服务可复用聊天密钥"></div>
<p class="fieldHint" id="setup-embedding-hint">使用预设时通常无需修改。模型须在账户和地域中可用；不提供 Embedding 的服务商可在这里填写另一家服务。</p>
</div></details>
</fieldset>
<p class="fieldHint">首次安装需要联网和系统 curl、tar。Windows 自动记忆服务仍属实验性支持；Anthropic 或已有远程服务请到「配置」。</p>
<div class="footer"><button class="btn primary" id="setup-start" type="submit">开始养鱼</button><button class="btn" id="setup-chat" type="button" hidden>去聊天</button></div>
</div></form>
<div class="card"><div class="cardHead"><h2 class="cardTitle">准备进度</h2></div>
<p class="status" id="setup-status" role="status" aria-live="polite">正在读取状态…</p><p id="setup-checks" class="cardHint"></p>
<ol class="setupSteps" id="setup-steps" hidden><li>检查模型连接</li><li>准备本机环境</li><li>启动并连接记忆</li></ol>
<p id="setup-elapsed" class="fieldHint" hidden></p>
<p class="fieldHint">服务就绪后，新产生的成功文本问答会同步。旧聊天不会自动导入；已同步还需等待后台整理，才可能召回。</p>
<div class="footer"><button class="btn" id="setup-retry" type="button" hidden>重试</button><button class="btn" id="setup-cancel" type="button" hidden>取消准备</button><button class="btn" id="setup-stop" type="button" hidden>暂停记忆</button></div>
</div></div></section>`;
