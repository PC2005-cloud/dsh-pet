/**
 * 语音缓存：按「限定音色 + 语速 + 文本」算键，落盘为音频文件，并按总量与条数淘汰最旧的。
 *
 * 命中即免合成——同一句话不管是自动播报还是手动点播都只合成一次。扩展名与 MIME 由
 * {@link FORMAT_INFO} 统一给出：两处各写一份就会出现「存成 .mp3、应答说 wav」。
 * 不负责合成与队列；删除任意文件都不影响正确性，下一次请求会重新合成。
 * @module dsh-pet/src/host/voice/cache
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { VoiceFormat } from './types.ts';

/** 缓存总量上限（字节）：超过后从最旧的开始删。 */
export const CACHE_MAX_BYTES = 20 * 1024 * 1024;
/** 缓存文件条数上限。 */
export const CACHE_MAX_FILES = 200;

/** 各格式的落盘扩展名与应答 MIME；缓存路径、淘汰白名单与路由应答都读这一份。 */
export const FORMAT_INFO: Record<VoiceFormat, { readonly ext: string; readonly mime: string }> = {
  mp3: { ext: '.mp3', mime: 'audio/mpeg' },
  wav: { ext: '.wav', mime: 'audio/wav' },
};

/** 淘汰时要统计的扩展名；漏掉一种，那种文件就永远删不掉。 */
const CACHED_EXTENSIONS: readonly string[] = Object.values(FORMAT_INFO).map((info) => info.ext);

/**
 * 缓存文件的完整路径：`<userRoot>/voice-cache/<key><ext>`。
 * @param userRoot - 用户数据根。
 * @param key - {@link cacheKey} 的结果。
 * @param format - 音频格式；决定扩展名。
 */
export function cachePath(userRoot: string, key: string, format: VoiceFormat): string {
  return join(userRoot, 'voice-cache', key + FORMAT_INFO[format].ext);
}

/**
 * 计算缓存键。
 *
 * 三个输入都影响音频内容。`voiceId` 是限定 id（含 provider 前缀），所以换实现、换音色、
 * 换语速、换文本里的任何一项都不会命中旧音频；`text` 不做归一化——同一句话多一个空格
 * 就是另一份音频，宁可多存也不冒「听起来不对」的风险。
 *
 * @param voiceId - 限定音色 id，如 `edge/zh-CN-XiaoyiNeural`。
 * @param rate - 语速偏移百分比，由入口解析成数字后传入。
 * @param text - 待合成文本。
 * @returns 十六进制 sha1。
 */
export function cacheKey(voiceId: string, rate: number, text: string): string {
  return createHash('sha1').update(`${voiceId}\n${rate}\n${text}`).digest('hex');
}

/**
 * 确保缓存目录存在。
 * @param userRoot - 用户数据根。
 * @returns 缓存目录绝对路径。
 */
export async function ensureCacheDir(userRoot: string): Promise<string> {
  const dir = join(userRoot, 'voice-cache');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 按「总量 + 条数」淘汰最旧的文件；两个上限都满足时立刻停手。
 * @param dir - 缓存目录。
 * @param limits - 上限，缺省用模块常量。
 * @returns 实际删除的文件数。
 */
export async function pruneCache(dir: string, limits: { maxBytes?: number; maxFiles?: number } = {}): Promise<number> {
  const maxBytes = limits.maxBytes ?? CACHE_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? CACHE_MAX_FILES;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // 目录还不存在：没有可淘汰的
  }
  const entries: { file: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!CACHED_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      entries.push({ file, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      /* 这条正被别的请求删掉，跳过 */
    }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let totalFiles = entries.length;
  let removed = 0;
  for (const entry of entries) {
    if (totalBytes <= maxBytes && totalFiles <= maxFiles) break;
    try {
      await rm(entry.file, { force: true });
      removed += 1;
      totalBytes -= entry.size;
      totalFiles -= 1;
    } catch {
      /* 删不掉就留着，不影响本次请求 */
    }
  }
  return removed;
}
