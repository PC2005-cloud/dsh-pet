/**
 * 对话动作联动的纯逻辑：可表演的动作名单、注入提示词的指令、回复里动作标记的解析。
 *
 * 不做生成与落盘（归 ./chat 与 ./plugin/chat-memory），也不写 S；名单与 animations.categories 同源。
 * 与 ./anim 分开：那边回答「/anim 该不该播、播哪个」，这边只服务对话这一条触发路径。
 * @module dsh-pet/src/host/chat-action
 */

/**
 * 对话联动可用的动作：`animations.categories` 下全部动作（去重，保持配置顺序）。
 *
 * 与 animationNames 分开：待机 / 转向 / 拖拽 / 点击 / 移动 / 事件动画不参与对话联动。
 *
 * @param animations - 成品配置的 animations 段（形状非法 → 空名单）。
 * @returns 按配置顺序排列的动作名；没配 categories 时是空数组。
 */
export function chatActionNames(animations: unknown): string[] {
  const a = (animations && typeof animations === 'object' ? animations : {}) as Record<string, unknown>;
  if (!Array.isArray(a.categories)) return [];
  const out: string[] = [];
  for (const category of a.categories) {
    if (!category || typeof category !== 'object') continue;
    const actions = (category as { actions?: unknown }).actions;
    if (!Array.isArray(actions)) continue;
    for (const name of actions) {
      // 与 animationNames 同一口径：非字符串与空串一律丢弃
      if (typeof name !== 'string' || name === '') continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * 动作指令：与配图指令并列附在 user 正文之后。
 *
 * 句式照配图那句写（省略主语、说「做」而不是「让宠物表演」）：模型自己就是宠物，旁白口吻它不会照做。
 *
 * @param names - 可表演的动作名（{@link chatActionNames} 的结果）；空名单由调用方直接跳过。
 * @param localeId - 宿主语言；只有 `ru` 时说明用俄语。标记 `[动作:名称]` 保持原样，解析靠它。
 */
export function actionInstruction(names: readonly string[], localeId?: string | null): string {
  const list = names.map((name) => '- ' + name).join('\n');
  if (localeId === 'ru') {
    return (
      '\n\n[动作] В конце ответа можно показать одно действие. Выбери самое подходящее и скопируй имя как есть:\n' +
      list +
      '\nЕсли выбрала, последней строкой напиши [动作:имя] — имя из списка, без перевода. Если ничего не подходит, маркер не пиши.'
    );
  }
  return (
    '\n\n[动作] 回复结尾可选做一个动作给用户看，从下列清单里挑最贴合当前语境的：\n' +
    list +
    '\n挑中就在回复最后另起一行写 [动作:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。'
  );
}

/**
 * 从模型回复里取动作（对话联动的解析半侧）。
 *
 * 所有动作标记都会被剥掉（无效名称也剥——标记不属于用户可见文本），只在命中白名单时采纳第一个。
 * 剥完没有正文时返回空串，由调用方决定不弹气泡。
 *
 * @param text - 模型回复原文。
 * @param names - 白名单（{@link chatActionNames}）；空名单 = 开关关闭，标记照剥但不采纳。
 * @returns 剥掉标记后的正文，以及命中白名单的第一个动作名。
 */
export function extractChatAction(text: string, names: readonly string[]): { text: string; action?: string } {
  // 全局正则带 lastIndex，复用会漏匹配：每次新建一个。
  const tag = /\[动作[:：]\s*([^\]\n]+?)\s*\]/g;
  let action: string | undefined;
  let tagged = false;
  const cleaned = text.replace(tag, (_tag, raw: string) => {
    tagged = true;
    const name = raw.trim();
    if (action === undefined && names.includes(name)) action = name;
    return '';
  });
  if (!tagged) return { text };
  // 标记通常独占一行：剥完会留下空行，压掉它，否则气泡顶部多一截空白。
  const body = cleaned
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return action === undefined ? { text: body } : { text: body, action };
}
