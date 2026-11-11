// 桌宠控制面板服务器：提供控制页面 + 代理 engine 的 /chat、/pet-display、/config
// 用法: node pet-panel-server.js [端口]
// 打开: http://127.0.0.1:3090/
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = parseInt(process.argv[2] || '3090', 10);
const PANEL = path.join(__dirname, 'pet-panel.html');
const USER = path.join(process.env.USERPROFILE, '.dsh', 'dsh-pet');
const MAIN = path.join(USER, 'main-config.jsonc');
const PET_DIR = path.join(USER, 'pet');
const RUNTIME = path.join(USER, 'standalone-runtime.json');
const ENGINE_BASE = 'http://127.0.0.1:3080/dsh-pet-7340';

function tokenOf() {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME, 'utf8')).token;
  } catch {
    return '';
  }
}

// 读取 main-config.jsonc（去掉注释）+ 各 pet/*-config.json，聚合出宠物条目
function readPets() {
  const out = [];
  function stripJsonc(src) {
    // 去掉 // 与 /* */ 注释（简单处理，足够本面板用）
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  function addFrom(obj, source) {
    if (!obj || !Array.isArray(obj.pets)) return;
    for (const p of obj.pets) {
      if (!p || typeof p.id !== 'string' || p.id === '') continue;
      out.push({
        id: p.id,
        name: p.name || p.id,
        size: typeof p.size === 'number' ? p.size : 200,
        display: p.display || 'desktop',
        source,
        chatModel: obj.chatModel || null,
        voiceEnabled: obj.voiceEnabled !== false,
        memesCount: obj.memes ? Object.keys(obj.memes).length : 0,
      });
    }
  }
  try {
    addFrom(JSON.parse(stripJsonc(fs.readFileSync(MAIN, 'utf8'))), 'main');
  } catch (e) { /* main 配置不可读 */ }
  try {
    for (const f of fs.readdirSync(PET_DIR)) {
      if (!f.endsWith('-config.json')) continue;
      try {
        addFrom(JSON.parse(fs.readFileSync(path.join(PET_DIR, f), 'utf8')), f);
      } catch (e) { /* 单个宠配置损坏跳过 */ }
    }
  } catch (e) { /* pet 目录不可读 */ }
  // 去重（以 id 为准，后读的覆盖）
  const map = new Map();
  for (const p of out) map.set(p.id, p);
  return [...map.values()];
}

// 触发桌宠重生成：/pet-display 同值调用会 requestRestart，重生成所有桌宠窗口。
// （/desktop/reload 在该 engine 版本被路由到 thumb 而失效，故统一用 /pet-display。）
function triggerRespawn() {
  const pets = readPets();
  const target = pets.find((p) => p.display !== 'none');
  if (target) proxyEngine('/pet-display', 'POST', { id: target.id, display: target.display }).catch(() => {});
}

// 取某只宠的第一张 AI娘配图路径（pet/<id>-memes/ 下）
function firstPetImage(id) {
  let cfg = null;
  try {
    if (id === 'main') {
      cfg = JSON.parse(fs.readFileSync(MAIN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    } else {
      cfg = JSON.parse(fs.readFileSync(path.join(PET_DIR, id + '-config.json'), 'utf8'));
    }
  } catch (e) { return null; }
  const memes = cfg && cfg.memes;
  if (!memes) return null;
  const keys = Object.keys(memes);
  if (keys.length === 0) return null;
  const dir = path.join(PET_DIR, id + '-memes');
  for (const ext of ['.png', '.webp', '.gif', '.jpg']) {
    const f = path.join(dir, keys[0] + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// 自定义图标路径：pet/<id>-icon.<ext>（存在则优先于默认首图）
function customIconPath(id) {
  for (const ext of ['.png', '.webp', '.gif', '.jpg', '.jpeg']) {
    const f = path.join(PET_DIR, id + '-icon' + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function iconImage(id) { return customIconPath(id) || firstPetImage(id); }
function hasCustomIcon(id) { return Boolean(customIconPath(id)); }

// 修改宠物大小：main 宠直接改 main-config.jsonc（保注释），其他宠改 pet/<id>-config.json
function setPetSize(id, size) {
  size = Math.max(50, Math.min(600, parseInt(size, 10)));
  if (id === 'main') {
    try {
      let src = fs.readFileSync(MAIN, 'utf8');
      const re = new RegExp('("pets"\\s*:\\s*\\[\\s*\\{[^}]*?"id"\\s*:\\s*"main"[^}]*?)("size"\\s*:\\s*)\\d+');
      if (!re.test(src)) return { ok: false, message: 'main 宠物条目未找到' };
      src = src.replace(re, '$1$2' + size);
      fs.writeFileSync(MAIN, src, 'utf8');
      return { ok: true, message: id + ' 大小已设为 ' + size };
    } catch (e) { return { ok: false, message: '写 main-config 失败: ' + e.message }; }
  }
  const f = path.join(PET_DIR, id + '-config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    const pet = Array.isArray(cfg.pets) ? cfg.pets.find((p) => p && p.id === id) : null;
    if (!pet) return { ok: false, message: id + ' 配置无该宠物条目' };
    pet.size = size;
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8');
    return { ok: true, message: id + ' 大小已设为 ' + size };
  } catch (e) { return { ok: false, message: '写 ' + id + ' 配置失败: ' + e.message }; }
}

// 代理到 engine（自动带上 token）
async function proxyEngine(pathname, method, body) {
  const token = tokenOf();
  const headers = { 'x-dsh-pet-token': token };
  let payload = body;
  if (body && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(ENGINE_BASE + pathname, { method, headers, body: payload });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text }; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 关键：禁止浏览器缓存，保证面板永远拿到最新页面/数据
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (p === '/' || p === '/index.html') {
    fs.readFile(PANEL, (err, data) => {
      if (err) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('面板文件缺失: ' + PANEL); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // API: 宠物预览图——优先自定义图标，其次第一张 AI娘配图；?meme=<名> 可显示指定配图
  if (p.startsWith('/api/preview/')) {
    const petId = decodeURIComponent(p.slice('/api/preview/'.length));
    let img = null;
    const meme = url.searchParams.get('meme');
    if (meme) {
      const f = path.join(PET_DIR, petId + '-memes', path.basename(meme));
      if (fs.existsSync(f)) img = f;
    }
    if (!img) img = iconImage(petId);
    if (!img) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no preview'); return; }
    const ext = path.extname(img).toLowerCase();
    const type = ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    fs.readFile(img, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('read fail'); return; }
      res.writeHead(200, { 'content-type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // API: 宠物列表（直接读配置文件）
  if (p === '/api/pets') {
    const pets = readPets().map((x) => ({ ...x, hasCustomIcon: hasCustomIcon(x.id) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pets }));
    return;
  }

  // API: 自定义图标——上传/选图/删除
  //   GET  /api/icon-memes/<id>         列出该宠可选配图（文件名列表）
  //   POST /api/icon/<id>               body { data: base64, ext: 'png' } 保存自定义图标
  //   POST /api/icon/<id>/meme          body { name: 'xxx.png' } 用配图作图标（复制到 <id>-icon）
  //   DELETE /api/icon/<id>             删除自定义图标（恢复默认首图）
  if (p.startsWith('/api/icon-memes/')) {
    const id = decodeURIComponent(p.slice('/api/icon-memes/'.length));
    const dir = path.join(PET_DIR, id + '-memes');
    let list = [];
    try { list = fs.readdirSync(dir).filter((f) => /\.(png|webp|gif|jpg|jpeg)$/i.test(f)).sort(); } catch (e) { /* 无图 */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memes: list }));
    return;
  }
  if (p.startsWith('/api/icon/')) {
    const rest = p.slice('/api/icon/'.length);
    const slash = rest.indexOf('/');
    const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const sub = slash === -1 ? '' : rest.slice(slash + 1);
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const parsed = JSON.parse(body || '{}');
    const safeId = /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
    if (!safeId) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'id 非法' })); return; }
    const writeIcon = (buf, ext) => {
      try {
        for (const e of ['.png', '.webp', '.gif', '.jpg', '.jpeg']) { const old = path.join(PET_DIR, safeId + '-icon' + e); if (fs.existsSync(old)) fs.unlinkSync(old); }
        fs.writeFileSync(path.join(PET_DIR, safeId + '-icon' + (ext || '.png')), buf);
        return { ok: true };
      } catch (e) { return { ok: false, message: '写图标失败: ' + e.message }; }
    };
    if (req.method === 'DELETE' && sub === '') {
      let removed = false;
      for (const e of ['.png', '.webp', '.gif', '.jpg', '.jpeg']) { const f = path.join(PET_DIR, safeId + '-icon' + e); if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; } }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }
    if (req.method === 'POST' && sub === 'meme') {
      const name = String(parsed.name || '');
      const src = path.join(PET_DIR, safeId + '-memes', name);
      if (!fs.existsSync(src) || !/\.(png|webp|gif|jpg|jpeg)$/i.test(name)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '配图不存在' })); return; }
      const ext = path.extname(name).toLowerCase();
      const out = writeIcon(fs.readFileSync(src), ext);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === 'POST' && sub === '') {
      const data = String(parsed.data || '');
      const b64 = data.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '图片数据为空' })); return; }
      const ext = /\.(webp|gif|jpg|jpeg)$/i.test(String(parsed.ext || '')) ? String(parsed.ext).toLowerCase() : '.png';
      const out = writeIcon(buf, ext);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: '未知图标操作' }));
    return;
  }

  // API: 聊天
  if (p === '/api/chat') {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const parsed = JSON.parse(body || '{}');
    if (!parsed.pet || !parsed.text) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'pet 与 text 必填' })); return; }
    const result = await proxyEngine('/chat?pet=' + encodeURIComponent(parsed.pet) + '&surface=desktop', 'POST', { text: parsed.text });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.json));
    return;
  }

  // API: 宠物显示开关
  if (p === '/api/pet-display') {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const parsed = JSON.parse(body || '{}');
    if (!parsed.id || !parsed.display) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'id 与 display 必填' })); return; }
    const result = await proxyEngine('/pet-display', 'POST', { id: parsed.id, display: parsed.display });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.json));
    return;
  }

  // API: 保存配置——若是仅 size 变更（{pets:[{id,size}]}），直接改配置文件更可靠；
  // 否则代理到 engine 的 /config (PUT)。
  if (p === '/api/config') {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const parsed = JSON.parse(body || '{}');
    const sizeOnly = parsed && Array.isArray(parsed.pets) && parsed.pets.every((x) => x && typeof x.id === 'string' && typeof x.size === 'number' && Object.keys(x).every((k) => k === 'id' || k === 'size'));
    if (sizeOnly) {
      const out = [];
      for (const x of parsed.pets) {
        const changed = setPetSize(x.id, x.size);
        out.push({ id: x.id, ok: changed.ok, message: changed.message });
      }
      // 触发重生成：/pet-display 同值调用会 requestRestart，重生成含新 size 的桌宠窗口
      // （/desktop/reload 在该 engine 版本被路由到 thumb 而失效，故不用它）
      if (out.some((x) => x.ok)) triggerRespawn();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: out.every((x) => x.ok), results: out }));
      return;
    }
    const result = await proxyEngine('/config', 'PUT', parsed);
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.json));
    return;
  }

  // API: 新增宠物——创建 pet/<id>-config.json + 重载
  if (p === '/api/add-pet') {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const parsed = JSON.parse(body || '{}');
    const id = String(parsed.id || '').trim();
    if (!id || !/^[a-zA-Z0-9_-]{1,40}$/.test(id)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'id 只能用字母/数字/-/_，1-40位' })); return; }
    const file = path.join(PET_DIR, id + '-config.json');
    if (fs.existsSync(file)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '宠物 ' + id + ' 已存在' })); return; }
    const cfg = {
      pets: [{
        id,
        name: String(parsed.name || id),
        whisperPrompt: String(parsed.prompt || ''),
        size: 200,
        balanceEnabled: true,
        whisperEnabled: true,
        workStatusEnabled: true,
        fixedEnabled: false,
        display: 'desktop',
        position: { corner: 'bottom-left', marginX: 100, marginY: 100 }
      }],
      chatModel: { provider: 'ollama', model: String(parsed.model || '') },
      voiceEnabled: false,
    };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    triggerRespawn();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id }));
    return;
  }

  // API: 全局开关（表情包/动作）——读或改 main-config.jsonc 顶层布尔
  if (p === '/api/flags') {
    if (req.method === 'GET') {
      try {
        let src = fs.readFileSync(MAIN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const cfg = JSON.parse(src);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ chatImageEnabled: cfg.chatImageEnabled === true, chatAnimationEnabled: cfg.chatAnimationEnabled === true, whisperImageEnabled: cfg.whisperImageEnabled !== false }));
        return;
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: e.message })); return; }
    }
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const parsed = JSON.parse(body || '{}');
    try {
      let src = fs.readFileSync(MAIN, 'utf8');
      for (const key of ['chatImageEnabled', 'chatAnimationEnabled', 'whisperImageEnabled']) {
        if (typeof parsed[key] === 'boolean') {
          const re = new RegExp('("' + key + '"\\s*:\\s*)(true|false)');
          if (re.test(src)) src = src.replace(re, '$1' + parsed[key]);
          else src = src.replace(/^\s*}/m, '  "' + key + '": ' + parsed[key] + ',\n}');
        }
      }
      fs.writeFileSync(MAIN, src, 'utf8');
      triggerRespawn();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '改 flags 失败: ' + e.message }));
      return;
    }
  }

  // API: 重载桌宠
  if (p === '/api/reload') {
    triggerRespawn();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reloading: true }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404: ' + p);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[pet-panel] 控制面板已启动: http://127.0.0.1:' + PORT);
});
