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

/** 统一说话要求：贴吧网友风 + 一句话 + ≤20 字 + 无 emoji + 无 Markdown。加到每条 system 末尾，压掉小模型的长篇大论。 */
const CHAT_STYLE_LINE =
  '【说话要求】回话要像贴吧网友聊天：就一句话、口语、接地气、可以吐槽；最多二十个字。禁止输出思考过程、禁止用 Markdown 或 HTML 标签（标题/列表/表格/代码块/<xxx>）、禁止重复、禁止长篇大论、禁止分析用户、禁止加颜文字/表情符号/emoji/图片。';

/** 安全边界：可以有黑色幽默和犀利吐槽，但必须用中文、文明用语；禁止色情/性描写/脏话/血腥暴力/侮辱用户。 */
const CHAT_SAFE_LINE =
  '【边界】可以有黑色幽默和犀利吐槽，但必须用中文、文明用语；禁止色情、禁止性描写、禁止脏话、禁止血腥暴力、禁止侮辱攻击用户。';

/**
 * 回复收尾清理：剥离 emoji / 颜文字，并硬截断到 20 字（优先在标点处断句）。
 * 保证“每句 ≤20 字、无表情包”不依赖小模型自觉。
 */
export function tidyReplyText(s: string): string {
  let t = String(s ?? '');
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}]/gu,
    '',
  );
  t = t.replace(/[（(][＾^▽ω∀｡◕‿◕｀´︿•́₃•̀ㅂㅅ￣﹏＞＜~☆★]+[^（()）]{0,6}[）)]/gu, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 20) {
    const cut = t.slice(0, 20);
    const m = cut.match(/^.*[。！？!?，、～~；;]/);
    t = m ? m[0] : cut.replace(/[\u4e00-\u9fa5A-Za-z0-9]$/, '');
  }
  return t;
}

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
}

/**
 * 拼出最终 system 提示词：人设正文 + 名字声明 + 时间背景 +（对话时）历史时间说明。
 *
 * 边界：prompt 为空时不留前导换行；name 与 id 都取不到时整段名字声明省略；
 * now 非法（NaN）时 timeContextOf 返回空串，时间背景与【历史】整行不加
 * （宁缺，也不把 NaN 拼进提示词；没有时间背景时【历史】的“现在”无从对照，留着只会自相矛盾）。
 */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  const name = String(parts.name || parts.id);
  const nameLine = name ? '你的名字是“' + name + '”。' : '';
  const lines = [parts.prompt, nameLine].filter((line) => line !== '');
  lines.push(CHAT_STYLE_LINE);
  lines.push(CHAT_SAFE_LINE);
  const time = timeContextOf(parts.now);
  if (time) {
    lines.push(time);
    // 【历史】跟着时间背景走：它整句都在引用“现在”，没有时间背景时不成立
    if (parts.historyTimes === true) lines.push(HISTORY_TIMES_LINE);
  }
  return lines.join('\n');
}
