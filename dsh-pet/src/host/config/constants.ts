/**
 * 配置领域常量与共享类型：取值域（角落、显示档、字号）与配置路径集。
 *
 * 不负责读写与校验；校验函数从这里取枚举集合，避免各写一份。
 * 必须始终成立：取值域与 shared/types 的联合类型一一对应，改一处必须同步另一处。
 * @module dsh-pet/src/host/config/constants
 */
import { FONT_PRESETS } from '../../shared/fonts.ts';
import { PET_DISPLAYS } from '../../shared/config.ts';
import { defaultLog } from '../log-file.ts';

/** 位置角落白名单 */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

export const CORNER_SET: ReadonlySet<string> = new Set(CORNERS);

/** display 白名单（导出：宿主路由 POST /pet-display 写单只宠物的显示位置时复用同一份枚举）。
 *  唯一来源是 shared/config 的 PET_DISPLAYS，读写两侧必须同一份规则，不在路由里另写一个 Set。 */
export const PET_DISPLAY_SET: ReadonlySet<string> = new Set(PET_DISPLAYS);

/** font.family 白名单：唯一来源是 shared/fonts 的 FONT_PRESETS，宿主只取 id 做校验。 */
export const FONT_FAMILY_SET: ReadonlySet<string> = new Set(FONT_PRESETS.map((preset) => preset.id));

/** id 禁用的字符（Windows 文件名保留符 + 控制字符，防配置值逃逸文件路径）。
 *  同时被 thumb 路由的 petId 校验复用：那里同样是「标识符不得当路径片段」。 */
// eslint-disable-next-line no-control-regex -- 正则的用途就是拦 \x00-\x1f 控制字符（防配置值逃逸路径），去掉匹配等于放行
export const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;

/** 标识符的最大长度：id 与素材根都会落成目录名，超长在部分文件系统上直接建不出来。 */
export const MAX_PET_ID_LENGTH = 64;

/**
 * 标识符能不能当路径片段用：非空、≤{@link MAX_PET_ID_LENGTH} 字符、不含分隔符与保留字符。
 *
 * 宠物 id、表情包素材根、thumb 的 petId 共用这一条——三者最后都拼进文件路径，
 * 分开各写一份就会出现「一处拦、另一处放行」。合法名含中文照常（用非法字符类而非 ASCII 白名单）。
 */
export function isValidPetId(value: string): boolean {
  // '.' 与 '..' 没有禁用字符，但作为目录名会把素材根顶到上一层：单列出来拦掉。
  if (value === '.' || value === '..') return false;
  return value !== '' && value.length <= MAX_PET_ID_LENGTH && !ID_FORBIDDEN.test(value);
}

/**
 * 「全局默认 + 种类可覆盖」的顶层字段白名单：这些是用户级成本 / 偏好 / 环境 / 节奏参数
 * （chatMemoryRounds、两个模型、两个配图开关与张数上限、eventsRefreshSec、physics、confineToScreen、font），
 * 不是「这个种类长什么样」，所以用户层写一次应对所有条目生效；种类文件仍可在自己顶层覆盖。
 * 人设是例外：实例级 pets[].whisperPrompt 优先，回落由消费端做（./persona 的 petPersona）。
 */
export const GLOBAL_DEFAULT_KEYS = [
  'physics',
  'font',
  'confineToScreen',
  'voiceEnabled',
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

export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  defaultLog('warn', 'dsh-pet: ' + message);
}

/** 配置路径集（宿主组装好后传入，单一事实来源） */
export interface ConfigPaths {
  /** 包内 assets/config.jsonc（内置默认，绝对正确） */
  defaultFile: string;
  /** ~/.dsh/dsh-pet/main-config.jsonc（用户主配置，可编辑层；JSONC——允许注释） */
  userFile: string;
  /** 旧路径 ~/.dsh/dsh-pet/main-config.json：读取回落 + 启动时迁移（见 migrateUserConfig） */
  legacyUserFile?: string;
  /** ~/.dsh/dsh-pet/pet（文件宠物目录） */
  petDir: string;
}
