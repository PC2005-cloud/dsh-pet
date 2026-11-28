/**
 * 系统通知：DSH 事件帧 → toast 文案的映射，只随浏览器半侧走。
 * 帧由宿主半侧监听 DSH 宿主事件生成（见 host/notify-events.ts），浏览器轮询 /notify 的增量队列消费本映射。
 * 桌面模式是宠物本体，不重复实现通知（宠物不等于通知，「两端一致」只约束宠物行为）。
 * 文案规则：标题只留会话名（超 30 字截断），正文去 Markdown、压成一行、最多 80 字；
 * 完成通知只留第一句（太短就顺延），审批写工具名和理由。
 * 纯函数无副作用：帧形状不匹配或不认识的类型一律返回 null，不弹也不报错。
 * @module dsh-pet/src/shared/notify
 */
/** 通知图标文件名（不含扩展名）；浏览器半侧拼完整 URL：/dsh-pet-7340/pic/<name>.png。 */
export const NOTIFY_ICONS = {
  done: 'notify-done',
  error: 'notify-error',
  truncated: 'notify-truncated',
  approval: 'notify-approval',
  question: 'notify-question',
  test: 'notify-test',
} as const;

/** 正文长度上限（码点，含省略号）；系统横幅只给一行注意力。 */
export const MAX_BODY = 80;

/** 会话标题取不到时的回落：用应用名，界面上本来就叫这个。 */
const APP_NAME = 'DeepSeek Harness';

/** 压平空白：native 通知只渲染一行，换行与连续空格都要收掉。 */
function collapse(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 英文单词被截断时，最多回退这么多字符找断点——再远就不值当，硬切。 */
const WORD_BREAK_LOOKBACK = 20;

/** 切点落在英文单词中间时，回退到最近的分隔符；找不到返回 -1。 */
function wordBreakIn(chars: string[]): number {
  const last = chars[chars.length - 1] ?? '';
  if (!/[A-Za-z0-9]/u.test(last)) return -1;
  for (let i = chars.length - 1; i >= 0 && i >= chars.length - WORD_BREAK_LOOKBACK; i -= 1) {
    if (/[\s,.;:!?，。、；：！？]/u.test(chars[i])) return i;
  }
  return -1;
}

/** 压平后按码点截到 {@link MAX_BODY}；省略号占最后一个字符，英文不劈单词。 */
export function clip(text: string): string {
  const flat = Array.from(collapse(text));
  if (flat.length <= MAX_BODY) return flat.join('');
  const head = flat.slice(0, MAX_BODY - 1);
  const boundary = /[A-Za-z0-9]/u.test(flat[MAX_BODY - 1]) ? wordBreakIn(head) : -1;
  const cut = boundary < 0 ? head.join('') : head.slice(0, boundary + 1).join('');
  return cut.trimEnd() + '…';
}

/** 会话名长度上限；沿用原来的截断规则，超出取前 30 字加省略号。 */
const MAX_SESSION_NAME = 30;

/** 标题里的会话名：去空白后截断；去完为空返回 undefined，交给调用方回落。 */
function sessionNameOf(sessionTitle: string | undefined): string | undefined {
  const name = sessionTitle?.trim();
  if (!name) return undefined;
  return name.length > MAX_SESSION_NAME ? `${name.slice(0, MAX_SESSION_NAME)}…` : name;
}

/** 标题：会话名本身；取不到名字时回落应用名。不再缀事件类型。 */
function titleOf(sessionTitle: string | undefined): string {
  return sessionNameOf(sessionTitle) ?? APP_NAME;
}

/** 行内 Markdown 标记 → 纯文本；顺序有依赖：图片先于链接，粗体先于斜体。 */
const INLINE_MARKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/!\[([^\]]*)\]\([^)]*\)/gu, '$1'],
  [/\[([^\]]+)\]\([^)]*\)/gu, '$1'],
  [/^#{1,6}\s+/u, ''],
  [/^>\s?/u, ''],
  [/^(?:[-*+]|\d+[.)])\s+/u, ''],
  [/\*\*([^*]+)\*\*/gu, '$1'],
  [/(^|[^*])\*([^*\n]+)\*(?!\*)/gu, '$1$2'],
  [/(^|[^_])__([^_]+)__(?!_)/gu, '$1$2'],
  [/(^|[^\w\u3400-\u9fff])_([^_]+)_(?=[^\w]|$)/gu, '$1$2'],
  [/~~([^~]+)~~/gu, '$1'],
];

/**
 * 行内代码保持原样（`a*b*c`、`__init__.py` 不能被强调规则吃掉）：
 * 先用占位符换出每个代码段，标记处理完再还原。
 */
function stripMarks(line: string): string {
  const code: string[] = [];
  let value = line.replace(/`+([^`]*)`+/gu, (_full: string, inner: string) => {
    code.push(inner);
    return `\uE000${code.length - 1}\uE000`;
  });
  // 两遍：粗体里可能套斜体，第一遍去掉粗体后才露出来。
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [pattern, replacement] of INLINE_MARKS) value = value.replace(pattern, replacement);
  }
  return value.replace(/\uE000(\d+)\uE000/gu, (_full: string, index: string) => code[Number(index)] ?? '');
}

/** 表格的分隔行（`| --- | --- |`）：Markdown 不要求数据行带前导竖线，只能靠它认表格。 */
const DELIMITER_ROW = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u;

/**
 * Markdown → 通知里的纯文本：去代码块、表格、水平线与行首标记，保留文字。
 * 段落之间用空格连接，通知只显示一行。
 */
function plainText(text: unknown): string {
  const lines = String(text ?? '')
    .replace(/```[^\n]*\n[\s\S]*?```/gu, '\n')
    .replace(/~~~[^\n]*\n[\s\S]*?~~~/gu, '\n')
    // 没闭合的代码围栏一直延伸到回复结尾。
    .replace(/(?:^|\n)[ \t]*(?:```|~~~)[\s\S]*$/u, '\n')
    .split('\n')
    .map((line) => line.trim());
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') {
      kept.push('');
      continue;
    }
    if (DELIMITER_ROW.test(line)) {
      // 表头在上一行、数据行在下面；Markdown 不要求前导竖线，只能靠分隔行认表格。
      if (kept[kept.length - 1]?.includes('|')) kept.pop();
      while (index + 1 < lines.length && lines[index + 1].includes('|')) index += 1;
      continue;
    }
    if (line.startsWith('|')) continue;
    if (/^[-*_]{3,}$/u.test(line)) continue;
    kept.push(line);
  }
  return kept
    .map((line) => collapse(stripMarks(line)))
    .filter((line) => line !== '')
    .join(' ');
}

const CJK = /[\u3400-\u9fff]/u;
const ENGLISH_STOP = /^(?:\s+["“（(A-Z]|\s*$)/u;
const CHINESE_STOP = /^\s+[\u3400-\u9fff]/u;
const ALNUM_END = /[A-Za-z0-9]$/u;
// 句点前必须是一整个词：`1st.` 里的 `st` 前面是数字，不能当成缩写。
const WORD_BEFORE_DOT = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z.]*)$/u;

/** 这些缩写后的句点不结束句子；列表故意短，`no.` 这类普通词仍要断句。 */
const ABBREVIATIONS = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'rev',
  'gen',
  'col',
  'sgt',
  'hon',
  'e.g',
  'i.e',
  'etc',
  'vs',
  'cf',
  'al',
  'viz',
  'u.s',
  'u.k',
  'a.m',
  'p.m',
  'fig',
  'eq',
  'ref',
  'inc',
  'ltd',
  'corp',
  'dept',
  'ph.d',
  'approx',
  'bros',
  'esq',
]);

/** 句点前是不是一个缩写。 */
function abbreviationBefore(head: string): boolean {
  const word = head.match(WORD_BEFORE_DOT)?.[1].toLowerCase();
  return word !== undefined && ABBREVIATIONS.has(word);
}

/** 找第一个被 `accepts` 接受、且前面不是缩写的句点；没有就返回 null。 */
function dotEnd(text: string, accepts: (head: string, tail: string) => boolean): string | null {
  for (let dot = text.indexOf('.'); dot !== -1; dot = text.indexOf('.', dot + 1)) {
    const head = text.slice(0, dot);
    if (!accepts(head, text.slice(dot + 1))) continue;
    if (abbreviationBefore(head)) continue;
    return `${head}.`;
  }
  return null;
}

/** 英文句点只在英文语境里断句。 */
const englishDotEnd = (text: string): string | null =>
  dotEnd(text, (head, tail) => !CJK.test(head) && ENGLISH_STOP.test(tail));

/** 中文紧跟的英文句点仍结束英文部分（`Bumped to v1.2. 已发版。`）。 */
const chineseDotEnd = (text: string): string | null =>
  dotEnd(text, (head, tail) => ALNUM_END.test(head) && CHINESE_STOP.test(tail));

/**
 * 第一句：全角句号/问号/叹号总是结束；ASCII 的要在空白、结尾或中文前才算；
 * 英文句点只在英文语境、且不是缩写时结束。取最早结束的那一条。
 */
function firstSentence(text: string): string {
  const endings = [
    text.match(/^[^。！？]*[。！？]/u)?.[0],
    text.match(/^[^。！？!?]*[!?](?=\s|$|[\u3400-\u9fff])/u)?.[0],
    englishDotEnd(text),
    chineseDotEnd(text),
  ].filter((value): value is string => typeof value === 'string');
  return endings.reduce((best, value) => (value.length < best.length ? value : best), text);
}

/** 首句短于这个长度（码点）就顺延到后面：只给「已修复。」这种横幅没有信息量。 */
const MIN_BODY = 12;

/** 开头的客套话：后面必须紧跟标点才算，避免误伤「好的方案是…」。 */
const FILLER_OPENING = /^(?:好的|好|收到|嗯|OK|okay)[，,。.!！、]\s*/iu;

/** 完成通知正文：去空话、取首句；首句太短就顺延到整段的前 80 字。 */
function bodyOfReply(text: string): string {
  const plain = plainText(text);
  const body = plain.replace(FILLER_OPENING, '') || plain;
  const first = firstSentence(body);
  return clip(Array.from(first).length < MIN_BODY ? body : first) || '回合已完成';
}

/** 通知帧：宿主半侧转发过来的一条 DSH 事件。 */
export interface NotifyFrame {
  type: string;
  /** 发出这条通知的会话 id；点击通知时据此跳到那条会话。
   *  没有会话位置的事件（host/agent-error）不带这个字段，消费端把缺失当成「只叫窗口」。 */
  sessionId?: string;
  [key: string]: unknown;
}

/** turn/end 事件在帧里的形状。 */
interface TurnEndEvent {
  type?: string;
  data?: {
    reason?: { kind?: string; error?: { message?: string } };
    /** 宿主带过来的最后一条回复开头；没有就回落空正文。 */
    text?: string;
  };
}

/**
 * 帧 → toast 文案；不认识的类型或 turn/end 的非弹分支（aborted 等）返回 null。
 *
 * @param frame - 宿主半侧转发的通知帧。
 * @param sessionTitle - 这条帧所属会话的显示名；有它时标题就是会话名，用户同时开着多个会话也能认出是哪一条。
 *   取不到就传 undefined，标题回落 DeepSeek Harness，不影响弹窗。
 */
export function frameToToast(
  frame: NotifyFrame,
  sessionTitle?: string,
): { title: string; body: string; icon: string } | null {
  switch (frame.type) {
    case 'session/event': {
      const ev = (frame.event ?? {}) as TurnEndEvent;
      if (ev.type !== 'turn/end') return null;
      const kind = ev.data?.reason?.kind;
      if (kind === 'completed') {
        const text = typeof ev.data?.text === 'string' ? ev.data.text : '';
        return {
          title: titleOf(sessionTitle),
          body: bodyOfReply(text),
          icon: NOTIFY_ICONS.done,
        };
      }
      if (kind === 'error') {
        const message = collapse(ev.data?.reason?.error?.message ?? '');
        return {
          title: titleOf(sessionTitle),
          body: message ? clip(`生成失败：${message}`) : '生成失败',
          icon: NOTIFY_ICONS.error,
        };
      }
      if (kind === 'max-tokens')
        return {
          title: titleOf(sessionTitle),
          body: '已达到输出 token 上限',
          icon: NOTIFY_ICONS.truncated,
        };
      // aborted（用户/父代理取消）、interrupted（崩溃恢复）等：不弹
      return null;
    }
    case 'approval/requested': {
      const toolName = collapse(frame.toolName);
      const reason = collapse(frame.reason);
      const detail = toolName ? `工具「${toolName}」${reason ? `：${reason}` : ''}` : reason;
      return {
        title: titleOf(sessionTitle),
        body: clip(detail) || '需要你批准',
        icon: NOTIFY_ICONS.approval,
      };
    }
    case 'question/requested': {
      const question =
        (Array.isArray(frame.questions) && (frame.questions as Array<{ question?: string }>)[0]?.question) || '';
      return {
        title: titleOf(sessionTitle),
        body: clip(plainText(question)) || '需要你回答',
        icon: NOTIFY_ICONS.question,
      };
    }
    case 'host/agent-error': {
      return {
        title: '生成失败',
        body: clip(typeof frame.message === 'string' ? frame.message : ''),
        icon: NOTIFY_ICONS.error,
      };
    }
    default:
      return null;
  }
}
