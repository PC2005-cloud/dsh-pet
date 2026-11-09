/**
 * 独立模式设置页的文案翻译：按与宿主相同的 `{name}` 规则替换占位符。
 *
 * 宿主侧由 `ctx.locale.bind(NS)` 提供翻译，独立环境没有 locale 服务，
 * 这里用包内字典自建；页面固定中文（见 chrome.ts 的 `lang="zh-CN"`），字典取 `zh`。
 * @module dsh-pet/src/standalone/settings-page/translate
 */

/**
 * 造翻译函数。
 *
 * @param dict - 键到文案的字典；键集由传入字典决定，调用方传 `zh` 时即为面板的完整键集。
 * @returns 按键取文案的翻译函数；缺省参数时原样返回，缺失的参数替换为空串。
 */
export function createTranslator<K extends string>(
  dict: Readonly<Record<K, string>>,
): (key: K, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const text = dict[key] ?? key;
    if (params === undefined) return text;
    return text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''));
  };
}
