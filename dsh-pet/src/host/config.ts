/**
 * host 侧配置模块 —— 全项目唯一的配置读取入口与写盘出口。
 *
 * 角色：
 *   - readAllConfig()：读取 内置默认（assets/config.jsonc，绝对正确）+ 用户主配置
 *     （main-config.json）+ 文件宠物（pet/<名>-config.json，一个文件一个条目），
 *     逐字段合并后返回 **绝对正确** 的完成品聚合：
 *       { main: {...}, test1: {...}, ... }
 *     每个条目都是对应配置文件的原文结构（字段名/位置/嵌套一律不动），且所有字段已填满。
 *   - saveUserConfig()：设置页写盘（PUT /config），白名单重建用户层 main-config.json；
 *     与读取分离——写的是「可编辑层」，文件宠物永不回写、不进此模式。
 *
 * 合并规则（唯一规则）：
 *   - 内置默认配置是唯一默认值来源（「代码里的配置绝对正确」）；
 *   - 覆盖文件写了 → 用自己的值；**没写 → 静默填内置默认值**（结构性常态，不告警——
 *     设置页写的用户层本就只含 pets + notificationsEnabled；文件宠物也可以写得很短）；
 *   - **显式写了但非法**（类型/结构/白名单外）→ 告警 + 填内置默认值
 *     （同一 文件+字段 进程内只告警一次，避免每请求刷屏；保证返回绝不出现残缺/非法值）；
 *   - 身份字段例外（无默认可填）：id 必须存在、全局唯一（缺失/重复/非法/冲突 →
 *     跳过该实例并告警）；name 缺失/空 → 按该宠物 id 处理并告警（既定规则，不继承默认名字）。
 *
 * 消费端契约：其他代码（路由/命令/碎碎念/对话/桌面）只消费 readAllConfig 的返回值，
 * 不做任何校验/兜底；浏览器与桌面通过 GET /dsh-pet-7340/config 拿到同一份成品。
 *
 * 本模块是 host 自包含实现（不 import src/shared —— DSH 单文件加载约束）；
 * 浏览器/桌面侧的对应纯逻辑（把成品拍平成渲染列表）在 src/shared/config.ts。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 位置角落白名单 */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const CORNER_SET: ReadonlySet<string> = new Set(CORNERS);

/** display 白名单 */
const PET_DISPLAYS = ['web', 'desktop', 'both', 'none'] as const;
const PET_DISPLAY_SET: ReadonlySet<string> = new Set(PET_DISPLAYS);

/** id 禁用的字符（Windows 文件名保留符 + 控制字符，防配置值逃逸文件路径） */
// eslint-disable-next-line no-control-regex
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;

/** 已告警过的 文件:字段（进程内去重：同一问题只告警一次，避免每请求刷屏；重启重置） */
const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn('dsh-pet: ' + message);
}

/** 剥除 JSONC 注释（行注释 // 与块注释）得到纯 JSON */
function stripJsonc(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();
}

/** 读取并解析 JSONC 文件；不存在/解析失败 → undefined（调用方决定处理） */
function readJsonc(path: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(stripJsonc(readFileSync(path, 'utf8'))) as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 配置路径集（宿主组装好后传入，单一事实来源） */
export interface ConfigPaths {
  /** 包内 assets/config.jsonc（内置默认，绝对正确） */
  defaultFile: string;
  /** ~/.dsh/dsh-pet/main-config.json（用户主配置，可编辑层） */
  userFile: string;
  /** ~/.dsh/dsh-pet/pet（文件宠物目录） */
  petDir: string;
}

interface PetFileEntry {
  /** 文件名前缀 = 条目 key = 素材根 */
  prefix: string;
  path: string;
}

/** 扫描 pet/ 目录：<名>-config.(json|jsonc) → 条目（按文件名排序） */
function scanPetFiles(petDir: string): PetFileEntry[] {
  let entries;
  try {
    entries = readdirSync(petDir, { withFileTypes: true });
  } catch {
    return []; // pet/ 目录不存在 = 无文件宠物
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /^.+?-config\.(json|jsonc)$/.test(name))
    .sort()
    .map((name) => ({ prefix: name.replace(/-config\.(json|jsonc)$/, ''), path: join(petDir, name) }));
}

/** animations 段完整性校验（与旧 assertAnimationsHost 同一套规则；不 throw，非法返回 false） */
function animationsValid(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const anims = a as Record<string, unknown>;
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    if (!Array.isArray(anims[key])) return false;
  }
  const moves = anims.moves;
  if (
    !moves ||
    typeof moves !== 'object' ||
    typeof (moves as Record<string, unknown>).default !== 'object' ||
    (moves as Record<string, unknown>).default === null ||
    !Array.isArray((moves as Record<string, unknown>).actions)
  ) {
    return false;
  }
  if (!Array.isArray(anims.categories)) return false;
  const ev = anims.events;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
  const evEntries = ev as Record<string, unknown>;
  for (const pool of Object.values(evEntries)) {
    if (!Array.isArray(pool) || pool.length === 0) return false;
    for (const name of pool) {
      if (typeof name !== 'string' || name.length === 0) return false;
    }
  }
  const balance = evEntries.balance;
  return Array.isArray(balance) && balance.length > 0;
}

/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w: unknown): boolean {
  if (!w || typeof w !== 'object') return false;
  const weights = w as Record<string, unknown>;
  for (const key of ['idle', 'turn', 'move']) {
    const v = Number(weights[key]);
    if (!Number.isFinite(v) || v < 0) return false;
  }
  return true;
}

/** physics 段校验：gravity ≥ 0（0 = 无重力，合法）、restitution ∈ [0,1]、groundFriction ≥ 0（均为有限数字）、
 *  ceilingBounce 为布尔、throwPower > 0（有限数字）、petCollision 为布尔 */
function physicsValid(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  const g = Number(p.gravity);
  const r = Number(p.restitution);
  const f = Number(p.groundFriction);
  const tp = Number(p.throwPower);
  return (
    Number.isFinite(g) &&
    g >= 0 &&
    Number.isFinite(r) &&
    r >= 0 &&
    r <= 1 &&
    Number.isFinite(f) &&
    f >= 0 &&
    typeof p.ceilingBounce === 'boolean' &&
    Number.isFinite(tp) &&
    tp > 0 &&
    typeof p.petCollision === 'boolean'
  );
}

/** 顶层标量字段的合法性（非法与缺失同处理：取默认值 + 告警） */
function topFieldValid(key: string, value: unknown): boolean {
  switch (key) {
    case 'whisperPrompt':
      return typeof value === 'string' && value.length > 0;
    case 'chatMemoryRounds': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0;
    }
    case 'notificationsEnabled':
      return typeof value === 'boolean';
    case 'animations':
      return animationsValid(value);
    case 'animationWeights':
      return weightsValid(value);
    case 'physics':
      return physicsValid(value);
    default:
      return true;
  }
}

/** eventsRefreshSec 段：深度合并——每个事件键都要有正数秒值；缺子键 → 静默取默认，显式写但非法 → 告警 + 默认 */
function mergeEventsRefreshSec(base: unknown, overlay: unknown, label: string): Record<string, number> {
  const baseErs = base && typeof base === 'object' ? (base as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [eventName, baseSec] of Object.entries(baseErs)) {
    const own = overlay && typeof overlay === 'object' ? (overlay as Record<string, unknown>)[eventName] : undefined;
    // 结构性常态：只写部分事件键（如只写 balance）→ 缺的键静默取默认
    if (own === undefined) {
      out[eventName] = Number(baseSec);
      continue;
    }
    const n = Number(own);
    if (!Number.isFinite(n) || n <= 0) {
      warnOnce(
        `${label}:eventsRefreshSec.${eventName}`,
        `「${label}」的 eventsRefreshSec.${eventName} 非法，已取默认值`,
      );
      out[eventName] = Number(baseSec);
      continue;
    }
    out[eventName] = n;
  }
  return out;
}

/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
function mergeEntry(
  base: Record<string, unknown>,
  overlay: Record<string, unknown> | undefined,
  label: string,
  basePets: Record<string, unknown>[],
  seenIds: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    if (key === 'pets') {
      out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
      continue;
    }
    if (key === 'eventsRefreshSec') {
      out[key] = mergeEventsRefreshSec(base[key], overlay?.[key], label);
      continue;
    }
    const own = overlay ? overlay[key] : undefined;
    // 结构性常态：覆盖层（尤其是设置页写的用户层）本来就不写顶层字段 → 缺失静默取默认，不告警；
    // 只有「显式写了但非法」才告警（真异常，默认值兜底）
    if (own === undefined) {
      out[key] = base[key];
      continue;
    }
    if (!topFieldValid(key, own)) {
      warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
      out[key] = base[key];
      continue;
    }
    out[key] = own;
  }
  return out;
}

/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(
  basePets: Record<string, unknown>[],
  raw: unknown,
  label: string,
  seenIds: Set<string>,
): Record<string, unknown>[] {
  const basePet: Record<string, unknown> = basePets[0] ?? {};
  if (!Array.isArray(raw) || raw.length === 0) {
    warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
    return basePets;
  }
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    const pet = mergePet(basePet, item, label, seenIds);
    if (pet) out.push(pet);
  }
  if (out.length === 0) {
    warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
    return basePets;
  }
  return out;
}

/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own: unknown, def: unknown, min: number, label: string, field: string, id: string): number {
  const n = Number(own);
  if (own !== undefined && own !== null && Number.isFinite(n) && n >= min) return n;
  // 缺失 = 常态（文件宠物可只写 id/name 等少量字段），静默取默认；显式写了但非法才是真异常
  if (own !== undefined && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
  }
  return Number(def);
}

/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own: unknown, def: unknown, label: string, field: string, id: string): boolean {
  if (typeof own === 'boolean') return own;
  if (own !== undefined && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
  }
  return Boolean(def);
}

/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(
  own: unknown,
  set: ReadonlySet<string>,
  def: unknown,
  label: string,
  field: string,
  id: string,
): string {
  if (typeof own === 'string' && set.has(own)) return own;
  if (own !== undefined && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
  }
  return typeof def === 'string' ? def : '';
}

/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(
  base: Record<string, unknown>,
  raw: unknown,
  label: string,
  seenIds: Set<string>,
): Record<string, unknown> | null {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) {
    warnOnce(`${label}:id:${id || '(空)'}`, `「${label}」的宠物 id「${id || '(空)'}」非法、重复或已存在，已跳过该实例`);
    return null;
  }
  seenIds.add(id);
  // name：缺失/空 → 按该宠物 id 处理（既定规则：可重复，不继承默认名字）
  const rawName = typeof p.name === 'string' ? p.name.trim() : '';
  const name = rawName || id;
  if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);

  // position：逐子字段合并（缺失 → 静默取默认；显式写但非法 → 告警 + 默认）
  const basePos = base.position && typeof base.position === 'object' ? (base.position as Record<string, unknown>) : {};
  const ownPos = p.position && typeof p.position === 'object' ? (p.position as Record<string, unknown>) : {};

  return {
    id,
    name,
    size: petNumber(p.size, base.size, 1, label, 'size', id),
    balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, 'balanceEnabled', id),
    whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, 'whisperEnabled', id),
    display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, 'display', id),
    position: {
      corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, 'position.corner', id),
      marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, 'position.marginX', id),
      marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, 'position.marginY', id),
    },
  };
}

/**
 * 唯一读取函数：内置默认 + 用户主配置 + 文件宠物逐字段合并后的完成品聚合。
 * 返回 { main: {...}, test1: {...}, ... } —— 每个条目都是原文件结构且所有字段已填满，
 * 消费端直接读，不做任何校验/兜底。每次调用重新读文件：修改配置刷新/重启即生效。
 */
export function readAllConfig(paths: ConfigPaths): Record<string, Record<string, unknown>> {
  const base = readJsonc(paths.defaultFile);
  if (!base) throw new Error('dsh-pet: 内置默认配置缺失或解析失败（安装损坏）：' + paths.defaultFile);
  const basePets = Array.isArray(base.pets) ? (base.pets as Record<string, unknown>[]) : [];
  const seenIds = new Set<string>();
  const out: Record<string, Record<string, unknown>> = {};

  // main 条目：内置默认 ← main-config.json（可编辑层）
  const mainOverlay = readJsonc(paths.userFile);
  if (existsSync(paths.userFile) && !mainOverlay) {
    warnOnce('file:' + paths.userFile, '用户主配置解析失败，已按无用户配置处理：' + paths.userFile);
  }
  out.main = mergeEntry(base, mainOverlay, 'main-config.json', basePets, seenIds);

  // 文件宠物条目：pet/<名>-config.json，一个文件一个条目（key = 文件名前缀 = 素材根）
  for (const file of scanPetFiles(paths.petDir)) {
    const parsed = readJsonc(file.path);
    if (!parsed) {
      warnOnce('file:' + file.path, '文件宠物配置解析失败，已跳过：' + file.path);
      continue;
    }
    out[file.prefix] = mergeEntry(base, parsed, file.prefix + '-config.json', basePets, seenIds);
  }
  return out;
}

/** 拍平全部条目的 pets 为单列表（host 消费端用：桌面宠物列表 / 命令 / 当前桌宠解析） */
export function flattenPetList(merged: Record<string, Record<string, unknown>>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const conf of Object.values(merged)) {
    if (Array.isArray(conf?.pets)) out.push(...(conf.pets as Record<string, unknown>[]));
  }
  return out;
}

/** 在完成品聚合里按实例 id 定位宠物及其所属条目（host 内部消费索引）：
 *  条目 key 即素材根（assetRoot）；条目级字段（whisperPrompt/chatMemoryRounds/animations）随条目取。 */
export function findPetInstance(
  merged: Record<string, Record<string, unknown>>,
  petId: string,
): { entry: string; conf: Record<string, unknown>; pet: Record<string, unknown> } | undefined {
  for (const [entry, conf] of Object.entries(merged)) {
    const pets = Array.isArray(conf?.pets) ? (conf.pets as Record<string, unknown>[]) : [];
    const found = pets.find((p) => String(p.id) === petId);
    if (found) return { entry, conf, pet: found };
  }
  return undefined;
}

/**
 * 保存用户层（PUT /config）：更新 main-config.json，接受可编辑字段（pets + notificationsEnabled）。
 * 编辑语义：**非白名单顶层字段（physics / whisperPrompt / chatMemoryRounds / eventsRefreshSec 等）
 * 从 `existing`（当前磁盘上的用户文件原对象）原样透传保留**——
 * 用户手动编辑的精调配置不会被设置页保存抹掉（旧实现是纯白名单重建，会整体覆盖丢失）。
 * 非法 → 返回 null（宿主回 400）。与读取分离——文件宠物永不回写、不在本模式内。
 */
export function saveUserConfig(
  raw: unknown,
  existing?: Record<string, unknown>,
): { pets: unknown[]; notificationsEnabled?: boolean; [key: string]: unknown } | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(o.pets) ? o.pets : null;
  if (!arr || !arr.length) return null;
  const out: unknown[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null;
    const pp = p as Record<string, unknown>;
    const id = String(pp.id ?? '');
    // 有意过滤文件名非法字符（Windows 保留符 + 控制字符），防止配置值逃逸 main-config.json 路径
    if (!id || id.length > 64 || ID_FORBIDDEN.test(id)) return null;
    const size = Number(pp.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    // 显示名：可重复不校验唯一；缺失/留空/非字符串 → 按该宠物 id 处理（兼容旧配置）并告警
    let name = typeof pp.name === 'string' ? pp.name.trim() : '';
    if (!name) {
      console.warn(`dsh-pet: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
      name = id;
    }
    const balanceEnabled = pp.balanceEnabled;
    if (typeof balanceEnabled !== 'boolean') return null;
    const whisperEnabled = pp.whisperEnabled;
    if (whisperEnabled !== undefined && typeof whisperEnabled !== 'boolean') return null;
    const display = String(pp.display ?? '');
    if (!PET_DISPLAY_SET.has(display)) return null;
    const pos = pp.position && typeof pp.position === 'object' ? (pp.position as Record<string, unknown>) : {};
    const corner = String(pos.corner ?? '');
    if (!CORNER_SET.has(corner)) return null;
    const marginX = Number(pos.marginX);
    const marginY = Number(pos.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    out.push({ id, name, size, balanceEnabled, whisperEnabled, display, position: { corner, marginX, marginY } });
  }
  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;
  // 白名单可编辑字段：pets 来自请求体、notificationsEnabled 来自请求体（未传则不写）
  const outConfig: { pets: unknown[]; notificationsEnabled?: boolean; [key: string]: unknown } = { pets: out };
  if (ne !== undefined) outConfig.notificationsEnabled = ne;
  // 透传保留：请求体未携带的顶层字段，从 existing（磁盘现有用户文件）原样带回——
  // 设置页只提交 pets(+notificationsEnabled)，手改的 physics/whisperPrompt/... 借此保住
  if (existing && typeof existing === 'object') {
    for (const key of Object.keys(existing)) {
      if (key === 'pets' || key === 'notificationsEnabled') continue; // 白名单字段由上方请求体决定
      // 只透传可精调的顶层字段，其余（如 unknown/占位）一并保留，不丢弃用户内容
      outConfig[key] = existing[key];
    }
  }
  return outConfig;
}
