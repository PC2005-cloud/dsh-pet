/**
 * 画面上有可读字的角色与表情包。俄语地址只为这个集合、且只在宿主语言是 ru 时拼出来。
 * 名单按发行成片核对过：气泡、标题和纸上的字算有字；纯 Zzz、问号和看不清的代码不算。
 */

/** 有可读文字的动画名与表情包键。 */
export const TEXT_FRAME_IDS: ReadonlySet<string> = new Set([
  '是啊，吃什么',
  '深度思考碎碎念',
  '写福字',
  '收红包',
  '大烧货',
  '先养着吧',
  '哦鲸鲸',
  '除了调情没啥用',
  '我不更新你们用什么',
  '哪来的电脑病毒',
  '大师这个区是什么意思',
  '就骚了怎么滴吧',
  '完蛋了把黄油删了',
  '就一碗',
  '鱼片有资源吗',
  '假如给我三天多模态',
  'Ciallo',
  '吃白饭的大肥鱼',
  '大的要来啦',
  '大的药来了',
  '要不直接骂他',
  '死掉了',
  '深度睡眠',
  '吃饱饱摸肚子',
  '誓死践行开源精神',
  '电死你',
  'token给妈妈保管',
  '厉害了我的鲸',
  '压力一只大肥鱼',
  '黎曼猜想没证明喵',
]);

/**
 * 素材相对名：ru 且 id 在名单里时是 `ru/<名>`，否则就是原名。
 * 斜杠留给调用方按段编码，不能整段 encode。
 */
export function textFrameRel(localeId: string | undefined | null, name: string): string {
  if (localeId === 'ru' && TEXT_FRAME_IDS.has(name)) return 'ru/' + name;
  return name;
}

/** 把相对名编成 URL 路径段，保留 `ru/` 这一层。 */
export function encodeFrameRel(rel: string): string {
  return rel
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/**
 * 请求已经带了 `ru/` 且主文件名在名单里时，缺俄语文件就回落到去掉这层前缀的原名。
 * 没带 `ru/`、或不在名单里，返回 undefined：调用方只查请求本身的路径。
 */
export function textFrameOriginal(rel: string): string | undefined {
  if (!rel.startsWith('ru/')) return undefined;
  const rest = rel.slice('ru/'.length);
  const stem = rest.replace(/\.(webm|mov|png)$/i, '');
  if (stem === '' || stem.includes('/') || !TEXT_FRAME_IDS.has(stem)) return undefined;
  return rest;
}
