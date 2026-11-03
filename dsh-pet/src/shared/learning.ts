// 自定义台词内容源（src/shared 纯数据，浏览器 bundle 与桌面 shared-core 共用）：
// 让宠物按概率冒一句用户自定义的台词气泡。内容解析与抽行逻辑都收在这里，
// 两端共用同一份，避免漂移。不依赖 React/DOM。

/** 台词顺序：乱序随机 / 顺序循环。 */
export type LearningOrder = 'random' | 'cycle';

/** 内置默认内容表（外部 learningTxt.json 缺失/解析失败时的回退）：名称 → 台词行。 */
export const DEFAULT_LEARNING_CONTENTS: Record<string, string[]> = {};

/**
 * 从内容表取指定名称的台词行；表/名称缺失或为空时返回空数组（调用方据此决定是否弹气泡）。
 * 内容表来自 learningTxt.json（`{ 名称: [台词行...] }`，host 经 GET /learningTxt 提供）。
 */
export function learningLines(
  contents: Record<string, string[]> | null | undefined,
  name: string | null | undefined,
): string[] {
  if (contents && name && Array.isArray(contents[name])) {
    return contents[name].filter((x): x is string => typeof x === 'string' && x !== '');
  }
  return [];
}

/** 从台词行里随机抽一行；空数组返回空串。 */
export function randomBubbleLine(lines: string[] = []): string {
  if (!lines || lines.length === 0) return '';
  return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * 顺序循环：取 index 指向的那一行，next 回绕到 0（lines 空/缺省返回空串）。
 * 配合调用方持有的索引推进，实现「一遍遍按顺序播、播完回到开头」。
 */
export function cycleBubbleLine(lines: string[] | undefined, index: number): { line: string; next: number } {
  if (!lines || lines.length === 0) return { line: '', next: 0 };
  const i = ((index % lines.length) + lines.length) % lines.length;
  return { line: lines[i], next: (i + 1) % lines.length };
}

/** 把单个解析出的对象（`{ 名称: 台词行[] }`）并入内容表；同名时**合并台词行**（不覆盖）。 */
function mergeLearningObject(map: Record<string, string[]>, obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    const lines = v.filter((x): x is string => typeof x === 'string' && x !== '');
    map[k] = map[k] ? map[k].concat(lines) : lines;
  }
}

/**
 * 解析台词内容表文本。容忍「单个对象」与「多个顶层对象拼接」两种写法——
 * 用户常直接往文件末尾追加 `{ "名称": [...] }`，严格 JSON.parse 会因多顶层对象报错。
 */
export function parseLearningContents(text: string): Record<string, string[]> | null {
  const map: Record<string, string[]> = {};
  const n = text.length;
  let idx = 0;
  let parsedAny = false;
  while (idx < n) {
    const start = text.indexOf('{', idx);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    let inStr = false;
    for (let i = start; i < n; i++) {
      const ch = text[i];
      if (ch === '"') inStr = !inStr;
      else if (!inStr && ch === '{') depth++;
      else if (!inStr && ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        mergeLearningObject(map, obj as Record<string, unknown>);
        parsedAny = true;
      }
    } catch {
      /* 跳过坏块 */
    }
    idx = end + 1;
  }
  return parsedAny && Object.keys(map).length > 0 ? map : null;
}

/** 弹台词对话的概率（0~1）。0 = 关闭；1 = 每次都弹。随机链/右键/点击三处共用。 */
export const LEARNING_DIALOGUE_CHANCE = 0.7;
