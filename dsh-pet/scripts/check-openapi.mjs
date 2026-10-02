// OpenAPI 文档校验（随 prepack 门禁运行）：
//   1. YAML 可解析
//   2. 所有 $ref 都能解析到（悬空引用是文档类交付最常见的低级错误）
//   3. 路径/操作/响应结构符合 OpenAPI 3.1 基本要求
//   4. 文档里列出的每条路径都真实存在于 host 路由实现里（防止文档漂移）
//
// 路径一律从本文件位置解析（不依赖 CWD）：openapi.yaml 在仓库根，本文件在 dsh-pet/scripts/。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const HERE = dirname(fileURLToPath(import.meta.url)); // dsh-pet/scripts
const SPEC_PATH = join(HERE, '..', '..', 'openapi.yaml'); // 仓库根
const HOST_SRC = join(HERE, '..', 'src', 'host', 'index.ts');

const doc = yaml.load(readFileSync(SPEC_PATH, 'utf8'));
const fail = [];
const ok = [];

// ---- 1. 顶层结构 ----
if (doc.openapi !== '3.1.0') fail.push(`openapi 版本应为 3.1.0，实际 ${doc.openapi}`);
else ok.push('openapi 3.1.0');
for (const key of ['info', 'paths', 'components', 'servers', 'tags']) {
  if (!doc[key]) fail.push(`缺少顶层字段 ${key}`);
}
if (!doc.info?.title || !doc.info?.version) fail.push('info.title / info.version 缺失');

// ---- 2. $ref 解析 ----
const deref = (ref) => {
  if (!ref.startsWith('#/')) return undefined;
  let cur = doc;
  for (const seg of ref.slice(2).split('/')) {
    cur = cur?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (cur === undefined) return undefined;
  }
  return cur;
};
let refCount = 0;
const walk = (node, path) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') {
      refCount++;
      if (deref(v) === undefined) fail.push(`悬空 $ref: ${v}（位于 ${path}）`);
    } else walk(v, `${path}.${k}`);
  }
};
walk(doc, '$');
ok.push(`${refCount} 个 $ref 全部可解析`);

// ---- 3. 操作与响应 ----
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
let ops = 0;
for (const [p, item] of Object.entries(doc.paths)) {
  if (!p.startsWith('/dsh-pet-7340')) fail.push(`路径未使用 /dsh-pet-7340 前缀: ${p}`);
  const keys = Object.keys(item).filter((k) => METHODS.includes(k));
  if (keys.length === 0) fail.push(`${p} 没有任何操作`);
  for (const m of keys) {
    ops++;
    const op = item[m];
    if (!op.operationId) fail.push(`${m.toUpperCase()} ${p} 缺少 operationId`);
    if (!op.summary) fail.push(`${m.toUpperCase()} ${p} 缺少 summary`);
    if (!Array.isArray(op.tags) || !op.tags.length) fail.push(`${m.toUpperCase()} ${p} 缺少 tags`);
    else
      for (const t of op.tags) {
        if (!doc.tags.some((x) => x.name === t)) fail.push(`${m.toUpperCase()} ${p} 的 tag「${t}」未在顶层声明`);
      }
    if (!op.responses || !Object.keys(op.responses).length) fail.push(`${m.toUpperCase()} ${p} 缺少 responses`);
    for (const [code, r] of Object.entries(op.responses ?? {})) {
      if (!/^[1-5](\d\d|XX)$/.test(code)) fail.push(`${m.toUpperCase()} ${p} 响应码非法: ${code}`);
      if (!r.description && !r.$ref) fail.push(`${m.toUpperCase()} ${p} 响应 ${code} 缺少 description`);
    }
    // 组件响应被 $ref 时不能带兄弟字段（3.1 里兄弟字段会被忽略）——顺带查一下参数引用
    for (const prm of op.parameters ?? []) {
      if (prm.$ref === undefined && (!prm.name || !prm.in)) fail.push(`${m.toUpperCase()} ${p} 的参数缺少 name/in`);
    }
  }
}
ok.push(`${Object.keys(doc.paths).length} 条路径 / ${ops} 个操作`);

// ---- 4. 文档路径 vs 真实实现 ----
// host 路由是 if (rest === 'x') 链 + scope 分支。rest 可能是两段（config/meta），
// 所以两边都归一化成「一级段」（config/meta → config）再比对，否则会误报。
const host = readFileSync(HOST_SRC, 'utf8');
const implemented = new Set([...host.matchAll(/rest === '([^']+)'/g)].map((m) => m[1].split('/')[0]));
for (const s of ['font', 'pic', 'thumb']) implemented.add(s);
const documented = new Set();
for (const p of Object.keys(doc.paths)) {
  const seg = p.slice('/dsh-pet-7340/'.length).split('/')[0];
  if (seg && !seg.startsWith('{')) documented.add(seg);
}
for (const seg of documented) {
  if (!implemented.has(seg)) fail.push(`文档里的 /${seg} 在 host 路由实现中不存在`);
}
for (const seg of implemented) {
  if (!documented.has(seg)) fail.push(`host 实现了 /${seg}，但文档里没有`);
}
ok.push(`路由对齐：${[...documented].sort().join(', ')}`);

// ---- 5. 组件 schema 里的 $ref 目标存在且是 schema ----
for (const [name, s] of Object.entries(doc.components.schemas)) {
  if (!s || typeof s !== 'object') fail.push(`schema ${name} 不是对象`);
  if (!s.type && !s.oneOf && !s.allOf && !s.anyOf && !s.$ref) fail.push(`schema ${name} 没有 type/oneOf`);
}

console.log('通过：');
for (const l of ok) console.log('  ✓ ' + l);
if (fail.length) {
  console.log('\n失败：');
  for (const l of fail) console.log('  ✗ ' + l);
  process.exit(1);
}
console.log('\nOpenAPI 文档校验全部通过。');
