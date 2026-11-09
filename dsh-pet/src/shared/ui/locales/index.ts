/**
 * 宠物 UI 字典的唯一出口：命名空间、键类型与全部语言的汇总。
 * zh 是键集真源，每种语言都声明成 `Record<Key, string>`，漏翻一个键在类型检查期就报错。
 * 这里只放 zh / en / ru：其余语言的宿主会按 `en` 逐键回退，不再出现中文。
 * @module dsh-pet/src/shared/ui/locales
 */
import { en } from './en.ts';
import { ru } from './ru.ts';
import { zh } from './zh.ts';

/** 字典命名空间。 */
export const NS = 'pet.ui';

/** 按宿主语言 id 汇总的字典，整包交给 `ctx.locale.register`。 */
export const dicts = { zh, en, ru };

export { zh } from './zh.ts';
export type { Key } from './zh.ts';
