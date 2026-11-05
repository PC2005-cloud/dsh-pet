/**
 * 配置读取：扫描宠物目录、迁移旧文件名、合并出成品配置并拍平。
 *
 * 不负责写盘（归 ./save）；解析失败按内置默认回退，绝不返回半成品。
 * 必须始终成立：所有读取都经 readAllConfig，模块外不得自行拼路径。
 * @module dsh-pet/src/host/config/read
 */
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { warnOnce } from './constants.ts';
import type { ConfigPaths } from './constants.ts';
import { effectiveUserFile, readJsonc } from './jsonc.ts';
import { mergeEntry, packBase } from './merge.ts';
import { DEFAULT_CHAT_MEMORY } from '../../shared/chat-memory-config.ts';

/**
 * 老用户一次性迁移：main-config.json → main-config.jsonc（重命名，内容一字不动）。
 * 为什么改扩展名：用户层从「同步」起就是带 // 注释的 JSONC 原文，挂在 .json 名下名不副实。
 * 新文件已存在 → 什么都不做（绝不用旧文件覆盖新文件）；重命名失败静默放过，读取侧有回落。
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

/**
 * 按条目 key（= 文件名前缀 = 素材根）定位文件宠物的实际文件与磁盘原对象。
 * 写路径（POST /pet-display）改文件宠物的 display 时，既要写回它自己的配置文件，也要拿该文件的
 * existing 做透传保留，否则手改的 whisperPrompt / animations / memes 会被白名单重建抹掉。
 * 扩展名不写死（.json 或 .jsonc），写错就会新建一个空配置；前缀不存在 → undefined。
 */
export function readPetConfigEntry(
  paths: ConfigPaths,
  entry: string,
): { path: string; raw: Record<string, unknown> | undefined } | undefined {
  const hit = scanPetFiles(paths.petDir).find((f) => f.prefix === entry);
  return hit ? { path: hit.path, raw: readJsonc(hit.path) } : undefined;
}

/**
 * 唯一读取函数：内置默认 + 用户主配置 + 文件宠物逐字段合并后的成品聚合。
 * 每个条目都是原文件结构且字段已填满，消费端直接读；每次调用重新读文件，改配置即刻生效。
 */
export function readAllConfig(paths: ConfigPaths): Record<string, Record<string, unknown>> {
  const base = readJsonc(paths.defaultFile);
  if (!base) throw new Error('dsh-pet: 内置默认配置缺失或解析失败（安装损坏）：' + paths.defaultFile);
  // Keep optional memory defaults in code so existing packaged configuration files need no migration.
  base.chatMemory ??= { ...DEFAULT_CHAT_MEMORY };
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
  // 基座 = 内置默认，但白名单字段（用户级成本/偏好/环境）取用户层——「全局默认 + 种类可覆盖」。
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
 *  条目 key 即素材根（assetRoot）；条目级字段（whisperPrompt/chatMemoryRounds/animations）随条目取
 *  （唯一例外：whisperPrompt 可被实例覆盖——调用方要生效值请走 ./persona 的 petPersona，别直接读 conf）。 */
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
