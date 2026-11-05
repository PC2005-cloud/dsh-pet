/**
 * 宿主语言 id 的叶子解析：没有叶子、id 空或不是字符串都按「不是 ru」。
 */

/** 从 `sections.locale` 的 data 读出 id；形状不对时返回空串。 */
export function readLocaleId(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' ? id.trim() : '';
}

/** 只有精确的 `ru` 才走俄语表面。 */
export function isRussianHost(id: string | undefined | null): boolean {
  return id === 'ru';
}
