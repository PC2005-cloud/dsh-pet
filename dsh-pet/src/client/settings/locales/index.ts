/**
 * 设置页字典的唯一出口：命名空间、键类型与全部语言的汇总。
 * zh 是键集真源，每种语言都声明成 `Record<Key, string>`，漏翻一个键在类型检查期就报错。
 * 宿主 0.2.2 起内置 zh / en / ja / es / fr / de / ru / pt 八种语言，其余语言按 `en` 逐键回退。
 * @module dsh-pet/src/client/settings/locales
 */
import { de } from './de.ts';
import { en } from './en.ts';
import { es } from './es.ts';
import { fr } from './fr.ts';
import { ja } from './ja.ts';
import { pt } from './pt.ts';
import { ru } from './ru.ts';
import { zh } from './zh.ts';

/** 字典命名空间。 */
export const NS = 'pet.config';

/** 按宿主语言 id 汇总的字典，整包交给 `ctx.locale.register`。 */
export const dicts = { zh, en, ja, es, fr, de, ru, pt };

export { zh } from './zh.ts';
export type { Key } from './zh.ts';
