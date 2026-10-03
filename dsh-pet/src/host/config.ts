/**
 * host 侧配置模块 —— 全项目唯一的配置读取入口与写盘出口。
 *
 * 角色：
 *   - readAllConfig()：读取 内置默认（assets/config.jsonc，绝对正确）+ 用户主配置
 *     （main-config.jsonc）+ 文件宠物（pet/<名>-config.json，一个文件一个条目），
 *     逐字段合并后返回 **绝对正确** 的完成品聚合：
 *       { main: {...}, test1: {...}, ... }
 *     每个条目都是对应配置文件的原文结构（字段名/位置/嵌套一律不动），且所有字段已填满。
 *   - saveUserConfig()：设置页写盘（PUT /config），白名单重建用户层 main-config.jsonc；
 *     与读取分离——写的是「可编辑层」，文件宠物永不回写、不进此模式。
 *   - syncUserConfigFromDefault()：设置页「同步」写盘（POST /config），把内置默认
 *     （assets/config.jsonc 原文，含注释）整份写入用户层——既是「恢复默认」，又直接给出
 *     一份可编辑的完整配置（不必再自己从包内复制）。合并结果与「没有用户层」等价。
 *
 * 合并规则（唯一规则）：
 *   - 内置默认配置是唯一默认值来源（「代码里的配置绝对正确」）；
 *   - 覆盖文件写了 → 用自己的值；**没写 → 静默填内置默认值**（结构性常态，不告警——
 *     设置页写的用户层本就只含 pets + notificationsEnabled；文件宠物也可以写得很短）；
 *   - **对象字段也是整段替换**（`physics` / `eventsRefreshSec` / `whisperModel` … 都适用）：
 *     写了就整段用自己的，缺的子键**不会**从内置默认补回来——消费端各自兜底
 *     （如余额周期读不到就按 1800、碎碎念按 300）；
 *   - **显式写了但非法**（类型/结构/白名单外）→ 告警 + 填内置默认值
 *     （同一 文件+字段 进程内只告警一次，避免每请求刷屏；保证返回绝不出现残缺/非法值）；
 *   - **例外：全局默认**（GLOBAL_DEFAULT_KEYS 那 9 个「用户级成本/偏好/环境/节奏」字段）——
 *     文件宠物条目的基座取**用户层**（main-config.jsonc）而不是内置默认，即"设置页改一次，
 *     所有宠物都生效"；种类文件仍可在自己顶层覆盖（写了就用自己那份）；
 *   - 身份字段例外（无默认可填）：id 必须存在、全局唯一（缺失/重复/非法/冲突 →
 *     跳过该实例并告警）；name 缺失/空 → 按该宠物 id 处理并告警（既定规则，不继承默认名字）。
 *
 * 消费端契约：其他代码（路由/命令/碎碎念/对话/桌面）只消费 readAllConfig 的返回值，
 * 不做任何校验/兜底；浏览器与桌面通过 GET /dsh-pet-7340/config 拿到同一份成品。
 *
 * 本模块是 host 自包含实现（不 import src/shared —— DSH 单文件加载约束）；
 * 浏览器/桌面侧的对应纯逻辑（把成品拍平成渲染列表）在 src/shared/config.ts。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 位置角落白名单 */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const CORNER_SET: ReadonlySet<string> = new Set(CORNERS);

/** display 白名单 */
const PET_DISPLAYS = ['web', 'desktop', 'both', 'none'] as const;
const PET_DISPLAY_SET: ReadonlySet<string> = new Set(PET_DISPLAYS);

/** id 禁用的字符（Windows 文件名保留符 + 控制字符，防配置值逃逸文件路径）。
 *  同时被 thumb 路由的 petId 校验复用：那里同样是"标识符不得当路径片段"。 */
// eslint-disable-next-line no-control-regex
export const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;

/**
 * 「全局默认 + 种类可覆盖」的顶层字段白名单 —— 用户层（main-config.jsonc）里写下的值会成为
 * **所有条目**的默认值；种类文件 `pet/<名>-config.json` 仍可在自己顶层覆盖（写了就用自己那份）。
 *
 * 判据：这几个是**用户级「成本 / 偏好 / 环境 / 节奏」参数**，不是「这个种类长什么样」——
 *   - `chatMemoryRounds`：带多少历史进上下文 = token 成本
 *   - `whisperModel` / `chatModel`：碎碎念 / 对话用哪个模型 = 成本与能力偏好
 *   - `whisperImageEnabled` / `chatImageEnabled`：要不要把表情包清单附进请求 = token 成本
 *   - `chatImageLimit`：对话那张清单**最多几张**——同属 token 成本（清单每条消息都附）
 *   - `eventsRefreshSec`：多久调一次模型 / 拉一次余额 = 成本与节奏。注意它内部两个键的**消费端**
 *     不同：`.whisper` 按宠物所属条目读（种类可覆盖）；`.balance` 只读 main 条目
 *     （余额数据一份 + host 只有一个定时器，架构上给不了每种类一个周期）
 *   - `physics`：拖拽抛掷手感；`petCollision` 更是**跨宠物**行为（相撞按动量守恒弹开），
 *     按种类分在语义上站不住：两只不同种类的宠物相撞时用谁的系数？
 *   - `confineToScreen`：多屏是用户环境 / 使用习惯，不是宠物属性
 *
 * 不在名单里的顶层字段基座仍是**内置默认**：`whisperPrompt`（人设）、`memes`（表情包）、
 * `animations` / `animationWeights`（与素材根绑定）、`workStatusTexts`（文案）——一个种类一份
 * 动画池 / 一份人设 / 一个表情包目录，各写一份才是 pet pack 的意义。
 */
const GLOBAL_DEFAULT_KEYS = [
  'physics',
  'confineToScreen',
  'whisperImageEnabled',
  'chatImageEnabled',
  'chatImageLimit',
  'chatMemoryRounds',
  'whisperModel',
  'chatModel',
  'eventsRefreshSec',
] as const;

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

/**
 * 读磁盘上的用户层原对象（JSONC 容忍——与读取路径 readAllConfig 共用同一份解析器）。
 *
 * 写路径必须用它：`PUT /config` 的「透传保留」要把用户手改的高级字段（physics /
 * whisperPrompt / animations / memes / ...）原样带回，而用户层可能是「同步」写入的
 * **带 // 注释的 config.jsonc 原文**。那里若用严格 `JSON.parse`，解析必然抛错、又被
 * catch 静默吞掉，existing 就成了 undefined —— 保存时白名单重建，高级字段全部丢失
 * （这正是「保存把用户精调配置抹掉」那次老 bug 的复发路径）。
 *
 * 文件不存在 / 损坏 → undefined（调用方按「无既有字段」处理，不阻塞保存）。
 */
export function readUserConfig(paths: ConfigPaths): Record<string, unknown> | undefined {
  const file = effectiveUserFile(paths);
  return file ? readJsonc(file) : undefined;
}

/**
 * 用户层**存在但解析不了**（真损坏：语法错误，连 JSONC 剥注释都救不回来）。
 *
 * 用途：`PUT /config`（保存）的损坏预检。保存是「白名单重建」，一旦 existing 读不出来，
 * 文件里原有的内容（用户手写的 animations / physics / memes / ...）就会被整份丢掉——
 * 而且全程静默。所以宿主这里**先不写盘**，回 409 让设置页弹窗（取消 = 不动文件；
 * 确认 = 强行重建），绝不静默丢配置。
 *
 * 文件不存在 → false（没有东西可丢，正常首次保存）。
 */
export function userConfigUnparsable(paths: ConfigPaths): boolean {
  const file = effectiveUserFile(paths);
  return file !== undefined && readJsonc(file) === undefined;
}

/** 配置路径集（宿主组装好后传入，单一事实来源） */
export interface ConfigPaths {
  /** 包内 assets/config.jsonc（内置默认，绝对正确） */
  defaultFile: string;
  /** ~/.dsh/dsh-pet/main-config.jsonc（用户主配置，可编辑层；JSONC——允许注释） */
  userFile: string;
  /** 旧版路径 ~/.dsh/dsh-pet/main-config.json：读取回落 + 启动时迁移（见 migrateUserConfig） */
  legacyUserFile?: string;
  /** ~/.dsh/dsh-pet/pet（文件宠物目录） */
  petDir: string;
}

/** 实际生效的用户层文件：优先 .jsonc；不存在则回落到旧的 .json（迁移前的老用户）；
 *  两者都不存在 → undefined（首次使用，无用户层）。 */
function effectiveUserFile(paths: ConfigPaths): string | undefined {
  if (existsSync(paths.userFile)) return paths.userFile;
  if (paths.legacyUserFile && existsSync(paths.legacyUserFile)) return paths.legacyUserFile;
  return undefined;
}

/**
 * 老用户一次性迁移：`main-config.json` → `main-config.jsonc`（**重命名**，内容一字不动）。
 *
 * 为什么改扩展名：用户层从「同步」起就是带 `//` 注释的 JSONC 原文，挂在 `.json` 名下名不副实
 * （编辑器会当严格 JSON 报错）。改成 `.jsonc` 后与包内默认 `config.jsonc` 同名同格式。
 *
 * 语义：新文件已存在 → 什么都不做（绝不用旧文件覆盖新文件）；旧文件不存在 → 什么都不做；
 * 重命名失败（占用/权限）→ 静默放过，读取侧对旧路径有回落，功能不受影响。
 */
export function migrateUserConfig(paths: ConfigPaths, log?: (message: string) => void): boolean {
  const legacy = paths.legacyUserFile;
  if (!legacy || !existsSync(legacy) || existsSync(paths.userFile)) return false;
  try {
    renameSync(legacy, paths.userFile);
  } catch {
    return false; // 迁移失败：读取侧回落旧路径，不影响使用
  }
  log?.(`用户配置已迁移到 JSONC：${legacy} → ${paths.userFile}`);
  return true;
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
    for (const slot of pool) {
      // 档位槽位：单个动画名（原行为）或候选数组（档内随机抽 1，见 shared/pickers pickSlot）；
      // 空字符串 / 空数组 / 成员为空串的数组均非法
      if (typeof slot === 'string') {
        if (slot.length === 0) return false;
      } else if (Array.isArray(slot)) {
        if (slot.length === 0) return false;
        for (const name of slot) {
          if (typeof name !== 'string' || name.length === 0) return false;
        }
      } else {
        return false;
      }
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

/** whisperModel / chatModel 段校验：{ provider, model } 两个字符串，
 *  **要么都留空（= 跟随当前对话的模型）要么都非空**——只填一半（选了服务商没选模型，或反之）
 *  会拼出"用 A 家的模型名去问 B 家"这种必然失败的组合，按非法处理（告警 + 取默认）。 */
function modelSelectionValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.provider !== 'string' || typeof m.model !== 'string') return false;
  return (m.provider.trim() === '') === (m.model.trim() === '');
}

/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const group of value) {
    if (!Array.isArray(group) || group.length === 0) return false;
    for (const text of group) {
      if (typeof text !== 'string' || text.length === 0) return false;
    }
  }
  return true;
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
    case 'chatImageLimit': {
      // 对话配图张数上限：非负数字（0 = 不限制）；小数按消费者 Math.floor 取整
      const n = Number(value);
      return Number.isFinite(n) && n >= 0;
    }
    case 'notificationsEnabled':
      return typeof value === 'boolean';
    case 'whisperImageEnabled':
      return typeof value === 'boolean';
    case 'chatImageEnabled':
      return typeof value === 'boolean';
    case 'confineToScreen':
      return typeof value === 'boolean';
    case 'animations':
      return animationsValid(value);
    case 'animationWeights':
      return weightsValid(value);
    case 'eventsRefreshSec':
      return eventsRefreshSecValid(value);
    case 'physics':
      return physicsValid(value);
    case 'whisperModel':
    case 'chatModel':
      return modelSelectionValid(value);
    case 'workStatusTexts':
      return workStatusTextsValid(value);
    default:
      return true;
  }
}

/**
 * eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
 *
 * 只校验「写下的每个值都合法」，**不**要求键集合与内置默认一致——这个字段和别的顶层字段
 * 一样是**整段替换**：缺的键就是缺（消费端各自兜底 1800 / 300），多写的键原样保留
 * （不再像旧的逐键深合并那样静默丢弃不认识的键）。空对象合法（等于全走消费端兜底）。
 */
function eventsRefreshSecValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return false;
  }
  return true;
}

/**
 * 文件宠物条目的合并基座：内置默认 + 白名单字段改用**用户层**的值。
 *
 * 为什么：那 9 个字段是用户级成本/偏好/环境/节奏参数，不是种类属性——用户在设置页改一次，
 * 期望所有宠物（含 pet pack）都生效。没有这一步，文件宠物只能拿到内置默认值，
 * 于是"设置页写着全局、实际只影响主宠物"（见 GLOBAL_DEFAULT_KEYS 的判据）。
 *
 * 语义仍是「种类可覆盖」：种类文件顶层写了自己的值 → 走 overlay 覆盖（mergeEntry 负责）。
 * 用户层写了但非法的值直接跳过（main 条目那边合并时已告警过一次，这里不再重复刷屏）。
 */
function packBase(
  base: Record<string, unknown>,
  mainOverlay: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!mainOverlay) return base;
  let out: Record<string, unknown> | undefined;
  for (const key of GLOBAL_DEFAULT_KEYS) {
    const own = mainOverlay[key];
    if (own === undefined || !topFieldValid(key, own)) continue;
    out ??= { ...base };
    out[key] = own;
  }
  return out ?? base;
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
    workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, 'workStatusEnabled', id),
    fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, 'fixedEnabled', id),
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

  // main 条目：内置默认 ← main-config.jsonc（可编辑层；迁移前的老用户回落到 main-config.json）
  const userFile = effectiveUserFile(paths);
  const mainOverlay = userFile ? readJsonc(userFile) : undefined;
  if (userFile && !mainOverlay) {
    warnOnce('file:' + userFile, '用户主配置解析失败，已按无用户配置处理：' + userFile);
  }
  out.main = mergeEntry(base, mainOverlay, 'main-config.jsonc', basePets, seenIds);

  // 文件宠物条目：pet/<名>-config.json，一个文件一个条目（key = 文件名前缀 = 素材根）。
  // 基座 = 内置默认，但白名单字段（用户级成本/偏好/环境）取**用户层**——「全局默认 + 种类可覆盖」。
  const filePetBase = packBase(base, mainOverlay);
  for (const file of scanPetFiles(paths.petDir)) {
    const parsed = readJsonc(file.path);
    if (!parsed) {
      warnOnce('file:' + file.path, '文件宠物配置解析失败，已跳过：' + file.path);
      continue;
    }
    out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + '-config.json', basePets, seenIds);
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
 * 保存用户层（PUT /config）：更新 main-config.jsonc，接受可编辑字段（pets + 全局开关：
 * notificationsEnabled / whisperImageEnabled / chatImageEnabled / confineToScreen + physics
 * + whisperModel / chatModel + chatMemoryRounds + chatImageLimit）。
 * 编辑语义：**非白名单顶层字段（whisperPrompt / eventsRefreshSec / memes 等）从
 * `existing`（当前磁盘上的用户文件原对象）原样透传保留**——
 * 用户手动编辑的精调配置不会被设置页保存抹掉（旧实现是纯白名单重建，会整体覆盖丢失）。
 * 白名单字段同理只在请求体**真的传了**时才算白名单：没传就走透传，不会被抹成默认值。
 * 非法 → 返回 null（宿主回 400）。与读取分离——文件宠物永不回写、不在本模式内。
 */
export function saveUserConfig(
  raw: unknown,
  existing?: Record<string, unknown>,
): { pets: unknown[]; [key: string]: unknown } | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(o.pets) ? o.pets : null;
  if (!arr || !arr.length) return null;
  const out: unknown[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null;
    const pp = p as Record<string, unknown>;
    const id = String(pp.id ?? '');
    // 有意过滤文件名非法字符（Windows 保留符 + 控制字符），防止配置值逃逸 main-config.jsonc 路径
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
    const workStatusEnabled = pp.workStatusEnabled;
    if (workStatusEnabled !== undefined && typeof workStatusEnabled !== 'boolean') return null;
    // 宠物固定（随机链不再抽「转向 / 移动」两档）：与上面两个开关同语义——可选，
    // 传了必须是布尔，没传则走下面的读取侧默认值（内置默认 false = 保持原行为）。
    const fixedEnabled = pp.fixedEnabled;
    if (fixedEnabled !== undefined && typeof fixedEnabled !== 'boolean') return null;
    const display = String(pp.display ?? '');
    if (!PET_DISPLAY_SET.has(display)) return null;
    const pos = pp.position && typeof pp.position === 'object' ? (pp.position as Record<string, unknown>) : {};
    const corner = String(pos.corner ?? '');
    if (!CORNER_SET.has(corner)) return null;
    const marginX = Number(pos.marginX);
    const marginY = Number(pos.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    out.push({
      id,
      name,
      size,
      balanceEnabled,
      whisperEnabled,
      workStatusEnabled,
      fixedEnabled,
      display,
      position: { corner, marginX, marginY },
    });
  }
  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;
  const wie = o.whisperImageEnabled;
  if (wie !== undefined && typeof wie !== 'boolean') return null;
  const cie = o.chatImageEnabled;
  if (cie !== undefined && typeof cie !== 'boolean') return null;
  const cts = o.confineToScreen;
  if (cts !== undefined && typeof cts !== 'boolean') return null;
  // physics（拖拽抛掷手感，设置页「物理」区可图形化编辑）：整段校验——physicsValid 与读取侧
  // 是同一份规则（gravity/groundFriction ≥ 0、restitution ∈ [0,1]、throwPower > 0、两个布尔）。
  // 传了就按白名单写入；没传则走下面的透传保留（用户手改的值原样不动）。
  const ph = o.physics;
  if (ph !== undefined && !physicsValid(ph)) return null;
  // whisperModel / chatModel（碎碎念 / 对话各自的服务商 + 模型；设置页两个下拉框写的就是它们）：
  // 与 physics 同一套语义——传了就整段校验后进白名单，没传则走下面的透传保留。
  // 落盘时归一化成 { provider, model } 两个 trim 过的字符串（请求体多带的键不写进用户层）。
  const wm = o.whisperModel;
  if (wm !== undefined && !modelSelectionValid(wm)) return null;
  const cm = o.chatModel;
  if (cm !== undefined && !modelSelectionValid(cm)) return null;
  // chatMemoryRounds（对话历史条数；设置页「AI 模型与对话上下文」区的数字输入框写的就是它）：
  // 与 physics / 模型同语义——传了就校验后进白名单，没传则走下面的透传保留。
  // 校验直接复用读取侧的 topFieldValid（有限且 ≥ 0），读写同一份规则，不另写一套。
  const cmr = o.chatMemoryRounds;
  if (cmr !== undefined && !topFieldValid('chatMemoryRounds', cmr)) return null;
  // chatImageLimit（对话配图张数上限；设置页「AI 模型与对话上下文」区的数字输入框写的就是它）：
  // 与 chatMemoryRounds 同一套语义——传了就校验后进白名单，没传则走下面的透传保留。
  const cil = o.chatImageLimit;
  if (cil !== undefined && !topFieldValid('chatImageLimit', cil)) return null;
  const cleanModel = (v: Record<string, unknown>): { provider: string; model: string } => ({
    provider: String(v.provider).trim(),
    model: String(v.model).trim(),
  });
  // 白名单可编辑字段：pets 来自请求体，其余（四个全局开关 / physics / 两个模型 /
  // 对话历史条数）同样只在请求体**真的传了**时才写（未传则走下面的透传保留，不凭空造值）
  const outConfig: { pets: unknown[]; [key: string]: unknown } = { pets: out };
  if (ne !== undefined) outConfig.notificationsEnabled = ne;
  if (wie !== undefined) outConfig.whisperImageEnabled = wie;
  if (cie !== undefined) outConfig.chatImageEnabled = cie;
  if (cts !== undefined) outConfig.confineToScreen = cts;
  if (ph !== undefined) outConfig.physics = ph;
  if (wm !== undefined) outConfig.whisperModel = cleanModel(wm as Record<string, unknown>);
  if (cm !== undefined) outConfig.chatModel = cleanModel(cm as Record<string, unknown>);
  // 数值归一化落盘：请求体传 "9" 也存成 9（与读取侧 topFieldValid 的 Number() 口径一致）
  if (cmr !== undefined) outConfig.chatMemoryRounds = Number(cmr);
  if (cil !== undefined) outConfig.chatImageLimit = Number(cil);
  // 透传保留：请求体未携带的顶层字段，从 existing（磁盘现有用户文件）原样带回——
  // 设置页只提交 pets(+全局开关+physics+模型+对话历史条数)，手改的 whisperPrompt/memes/... 借此保住。
  // 白名单字段只在「请求体传了」时才算白名单（已由上方写入）；未传时走这里透传磁盘旧值——
  // 否则整包调用的调用方漏传一个字段，就会把用户既有设置悄悄抹成默认。
  const bodyOwned = new Set(['pets']);
  if (ne !== undefined) bodyOwned.add('notificationsEnabled');
  if (wie !== undefined) bodyOwned.add('whisperImageEnabled');
  if (cie !== undefined) bodyOwned.add('chatImageEnabled');
  if (cts !== undefined) bodyOwned.add('confineToScreen');
  if (ph !== undefined) bodyOwned.add('physics');
  if (wm !== undefined) bodyOwned.add('whisperModel');
  if (cm !== undefined) bodyOwned.add('chatModel');
  if (cmr !== undefined) bodyOwned.add('chatMemoryRounds');
  if (cil !== undefined) bodyOwned.add('chatImageLimit');
  if (existing && typeof existing === 'object') {
    for (const key of Object.keys(existing)) {
      if (bodyOwned.has(key)) continue; // 白名单字段由请求体决定
      // 只透传可精调的顶层字段，其余（如 memes/unknown/占位）一并保留，不丢弃用户内容
      outConfig[key] = existing[key];
    }
  }
  return outConfig;
}

/**
 * 同步用户层（POST /config，设置页「同步」）：把内置默认配置**原文**写入用户主配置文件。
 *
 * 为什么是"复制原文"而不是"删除用户层"（旧实现）：删掉之后用户手上没有配置文件，
 * 想手改高级字段（physics / whisperPrompt / animations / memes / ...）就得自己从包内
 * assets/config.jsonc 复制一份——这一步是死的、每次都要做。这里直接把那份文件（含全部
 * 中文注释、全部字段）落到用户配置路径上：既等价于恢复默认（合并结果 = 内置默认），
 * 又让用户拿到一份开箱可编辑的完整配置。
 *
 * 注释无害：读取侧统一走 readJsonc（stripJsonc 剥注释），带注释写入照样能读。
 *
 * 注意（调用方要在 UI 上讲清楚）：文件一旦生成即成为**显式覆盖层**——用户层写了什么就
 * 覆盖内置默认的对应字段，所以插件升级改了内置默认后，这个文件里的旧值仍会继续生效。
 *
 * 默认文件缺失/目录不可写 → 直接抛（宿主回 500）：绝不静默留下半个配置文件。
 */
export function syncUserConfigFromDefault(paths: ConfigPaths): void {
  const raw = readFileSync(paths.defaultFile, 'utf8');
  mkdirSync(dirname(paths.userFile), { recursive: true });
  writeFileSync(paths.userFile, raw, 'utf8');
}

/**
 * 对话记忆截取：从消息列表里取尾部 `rounds` 轮（1 轮 = 1 问 1 答 → 2 条）。
 *
 * 为什么单独抽一个函数：`rounds = 0` 表示「不带历史」。若直接写 `messages.slice(-rounds * 2)`，
 * 会踩 JS 的 `-0` 陷阱——`-0 === 0`，`slice(-0)` 返回**整个数组**而不是空数组，
 * 于是「关掉历史」反而变成「带全部历史」（用户实测：设 0 后问生日，10 秒后仍答得出）。
 * 这里显式分支：0 → 空列表；> 0 → 截尾部。`rounds` 由合并器保证为非负有限数，
 * 负数/NaN 兜底按 0 处理（不产出荒谬的 slice 行为）。
 */
export function sliceMemoryRounds<T>(messages: T[], rounds: number): T[] {
  return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}
