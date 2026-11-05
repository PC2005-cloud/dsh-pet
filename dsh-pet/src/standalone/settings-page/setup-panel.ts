/** First-run form. Advanced controls remain available in the existing configuration tab. */
export const setupPanel = `
<section class="panel" id="panel-setup" role="tabpanel" aria-labelledby="tab-setup" hidden><div class="scroll">
<form id="quick-setup"><div class="card"><div class="cardHead"><h2 class="cardTitle">让她先陪你聊起来</h2></div>
<p class="cardHint">选好模型，填入自己的接口地址和密钥，再点「开始养鱼」。配置只保存在本机。</p>
<div class="field"><label for="setup-provider">模型预设</label><select id="setup-provider"><option value="qwen">通义千问（OpenAI 兼容接口）</option><option value="openai">OpenAI</option><option value="custom">其他 OpenAI 兼容服务</option></select></div>
<div class="field"><label for="setup-url">接口地址</label><input id="setup-url" type="url" required maxlength="2048" placeholder="服务商提供的 Base URL，通常以 /v1 结尾" spellcheck="false"></div>
<div class="field"><label for="setup-key">API 密钥</label><input id="setup-key" type="password" required maxlength="4096" autocomplete="new-password" placeholder="填写服务商提供的密钥"></div>
<div class="field"><label><input id="setup-memory" type="checkbox"> 开启本机长期记忆</label><p class="fieldHint">让她有机会记起更早聊过的事。首次会下载 uv、Python 和 PowerContext 1.5.0；后续随桌宠启动和退出。模型检查、聊天、记忆整理和检索会调用所填服务商，可能产生费用。</p></div>
<details id="setup-model-details"><summary>查看或调整模型</summary>
<div class="field"><label for="setup-model">聊天与记忆整理模型</label><input id="setup-model" type="text" required maxlength="200" value="qwen3.7-plus"></div>
<div id="setup-embedding-fields" hidden>
<div class="field"><label for="setup-embedding-model">Embedding 模型</label><input id="setup-embedding-model" type="text" maxlength="200" value="qwen3.7-text-embedding"></div>
<div class="field"><label for="setup-dimension">向量维度</label><input id="setup-dimension" type="number" min="1" max="65536" value="1024"></div>
<div class="field"><label for="setup-embedding-url">Embedding 接口地址（可选）</label><input id="setup-embedding-url" type="url" maxlength="2048" placeholder="留空使用上面的接口地址"></div>
<div class="field"><label for="setup-embedding-key">Embedding 密钥（可选）</label><input id="setup-embedding-key" type="password" maxlength="4096" autocomplete="new-password" placeholder="留空使用上面的密钥"></div>
<p class="fieldHint">预设模型需要在你的账户和地域可用。不提供 embedding 的服务商可在这里填写另一家服务。已有记忆库须保持 embedding 地址、模型和维度不变。</p>
</div></details>
<p class="fieldHint">支持 Linux / macOS；Windows 自动记忆服务随 PowerContext 仍属实验性支持。已有服务或使用 Anthropic 协议，请到「配置」。</p>
<div class="footer"><button class="btn primary" id="setup-start" type="submit">开始养鱼</button><button class="btn" id="setup-chat" type="button" hidden>去聊天</button></div>
</div></form>
<div class="card"><div class="cardHead"><h2 class="cardTitle">准备进度</h2></div>
<p class="status" id="setup-status" role="status" aria-live="polite">正在读取状态…</p><p id="setup-checks" class="cardHint"></p>
<p class="fieldHint">服务就绪后，新产生的成功文本问答才会同步；旧聊天不会自动导入。已同步还需等待后台整理，才有机会召回。</p>
<div class="footer"><button class="btn" id="setup-retry" type="button" hidden>按已保存配置重试</button><button class="btn" id="setup-stop" type="button" hidden>停止本机记忆</button></div>
</div></div></section>`;
