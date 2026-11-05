/**
 * 把宿主语言 id 告诉宿主：启动时一次，之后 id 变了再送。
 * 不写宠物配置。id 来自 locale 服务的读取器；类型里没有时，读设置字典里的 localeId。
 */
import { ROUTE_PATH } from '../shared/constants.ts';

/** 设置页字典的命名空间，与 settings/locales 的 NS 是同一个。 */
const SETTINGS_NS = 'pet.config';

/** 八个设置字典里的服务键，值等于该字典的语言 id。 */
const LOCALE_KEY = 'localeId';

/** 宿主 locale 服务里本模块会试的形状。 */
export interface LocaleService {
  readonly id?: string | (() => string);
  readonly language?: string | (() => string);
  readonly current?: string | (() => string);
  bind?: (namespace: string) => (key: string) => string;
  subscribe?: (listener: () => void) => () => void;
  on?: (event: string, listener: () => void) => (() => void) | void;
}

function readField(value: string | (() => string) | undefined): string | undefined {
  if (typeof value === 'function') {
    const id = value();
    return typeof id === 'string' ? id : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * 读当前语言 id。优先服务自己的读取器，没有再走设置字典的 localeId。
 *
 * @param locale - 宿主注入的 locale 服务。
 * @returns id；还读不到时是空串。
 */
export function readLocaleServiceId(locale: LocaleService): string {
  const direct = readField(locale.id) ?? readField(locale.language) ?? readField(locale.current);
  if (direct !== undefined && direct.trim() !== '') return direct.trim();
  if (typeof locale.bind !== 'function') return '';
  const bound = locale.bind(SETTINGS_NS)(LOCALE_KEY);
  if (typeof bound !== 'string') return '';
  const id = bound.trim();
  if (id === '' || id === LOCALE_KEY) return '';
  return id;
}

/**
 * 启动时上报一次，之后 id 变化再上报。
 *
 * @param locale - 宿主 locale 服务。
 * @param report - 把 id 交给宿主；不要在这里写配置。
 * @returns 退订。
 */
export function watchHostLocale(locale: LocaleService, report: (id: string) => void): () => void {
  let last: string | undefined;
  const sync = (): void => {
    const id = readLocaleServiceId(locale);
    if (id === last) return;
    last = id;
    report(id);
  };
  sync();
  const offs: Array<() => void> = [];
  if (typeof locale.subscribe === 'function') offs.push(locale.subscribe(sync));
  if (typeof locale.on === 'function') {
    const off = locale.on('change', sync);
    if (typeof off === 'function') offs.push(off);
  }
  return () => {
    for (const off of offs) off();
  };
}

/**
 * 把 id 交给宿主的 locale 叶子。空 id 不发。
 *
 * @param id - 宿主语言 id。
 * @param fetchImpl - 可替换的 fetch，测试注入。
 */
export async function postHostLocale(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (id.trim() === '') return;
  await fetchImpl(ROUTE_PATH + '/locale', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}
