/**
 * 人设拼装（宿主半侧，纯逻辑）：碎碎念与对话共用的 system 提示词只在这一处拼好。
 *
 * 四段，顺序固定：人设正文（实例 whisperPrompt → 条目 whisperPrompt → 空串）、名字声明、
 * 时间背景（timeContextOf 现算，不缓存）、历史时间说明（仅在对话且有历史时追加）。
 * 不碰 IO、不读时钟，Date 由调用方传入；也不负责取字段与
 * 发起生成（index.ts 的 petSystemPrompt 只做「取字段 → 调这里」）。
 * 必须始终成立：拼装点唯一——不给名字与时间开占位符配置，否则等于出现第二个拼装点。
 * @module dsh-pet/src/host/persona
 */
import { timeContextOf } from './time-context.ts';

/**
 * 历史时间说明：历史里 user 消息带 `[月日 时:分]` 前缀时追加，让模型知道那些时刻可以用来算跨度。
 *
 * 措辞把前缀限定为「对话记录里的时间标注」而不是「回复格式」；前缀只标在 user 消息上——
 * 标在 assistant 上时模型会照抄成自己的说话格式（出现过回复以 `[11:54]` 开头）。
 */
const HISTORY_TIMES_LINE =
  '【历史】对话记录里，主人的话前面标着 [月日 时:分]，那是那句话发生的时刻；它只是记录里的时间标注，不是你的说话格式。判断“多久以前”“隔了几天”时按它换算，别把隔了很久的话当成刚说过的。你的回复直接从正文开始，不要写时间、不要加方括号前缀。';

/** 同一段说明的俄文。只在宿主语言是 ru 时替换，不改人设正文。 */
const HISTORY_TIMES_LINE_RU =
  'В истории перед репликами хозяина стоит [дата время] — это момент той фразы, а не формат твоих ответов. По нему считай, как давно это было. Ответ начинай сразу с текста, без времени и без скобок.';

/** 有历史且 язык ru 时追加：旧 assistant 回复可能是中文，不要照抄语言。 */
const HISTORY_PRIOR_LANGUAGE_RU =
  'Старые ответы ассистента в истории могли быть на другом языке — не копируй их язык, отвечай по-русски.';

/** 放在 system 最前，减弱长段中文历史对模型语言的影响。 */
const RU_REPLY_GUARD = 'Отвечай только по-русски. Не используй китайский и другие языки.';

/**
 * 某宠物最终生效的人设正文（不含名字与时间）：实例 whisperPrompt → 条目 whisperPrompt → 空串。
 *
 * 语义是替换而不是拼接：两段人设同时生效会让模型收到两个身份。
 * 实例级的值合并器已过滤过，这里仍 trim 判空——petPersona 也是导出函数，不能假设调用方走了合并器。
 */
export function petPersona(conf: Record<string, unknown>, pet: Record<string, unknown>): string {
  const own = pet.whisperPrompt;
  if (typeof own === 'string' && own.trim() !== '') return own;
  const entry = conf.whisperPrompt;
  return typeof entry === 'string' ? entry : '';
}

/** composeSystemPrompt 的入参 */
export interface SystemPromptParts {
  /** 已回落到生效值的人设正文（petPersona 的结果；空串 = 没有人设，只有名字 + 时间） */
  prompt: string;
  /** 显示名（pets[].name；缺失/空按 id 处理） */
  name: string;
  /** 宠物 id（name 为空时的兜底；两者都空 = 整段名字声明省略） */
  id: string;
  /** 生成这一刻（生产传 new Date()，测试传固定日期） */
  now: Date;
  /** 历史消息是否带时间前缀；缺省 false（碎碎念没有历史，不该出现【历史】段） */
  historyTimes?: boolean;
  /** 宿主语言 id。只有精确的 `ru` 才把名字、时间和历史说明换成俄语，并要求用俄语回答。 */
  localeId?: string;
}

/**
 * 拼出最终 system 提示词：人设正文 + 名字声明 + 时间背景 +（对话时）历史时间说明。
 *
 * 边界：prompt 为空时不留前导换行；name 与 id 都取不到时整段名字声明省略；
 * now 非法（NaN）时 timeContextOf 返回空串，时间背景与【历史】整行不加
 * （宁缺，也不把 NaN 拼进提示词；没有时间背景时【历史】的“现在”无从对照，留着只会自相矛盾）。
 */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  const ru = parts.localeId === 'ru';
  const name = String(parts.name || parts.id);
  const nameLine = name ? (ru ? 'Тебя зовут «' + name + '».' : '你的名字是“' + name + '”。') : '';
  const lines = [parts.prompt, nameLine].filter((line) => line !== '');
  if (ru) lines.unshift(RU_REPLY_GUARD);
  const time = timeContextOf(parts.now, parts.localeId);
  if (time) {
    lines.push(time);
    // 【历史】跟着时间背景走：它整句都在引用“现在”，没有时间背景时不成立
    if (parts.historyTimes === true) {
      if (ru) lines.push(HISTORY_PRIOR_LANGUAGE_RU);
      lines.push(ru ? HISTORY_TIMES_LINE_RU : HISTORY_TIMES_LINE);
    }
  }
  if (ru) lines.push('Отвечай по-русски.');
  return lines.join('\n');
}
