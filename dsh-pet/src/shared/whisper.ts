// 碎碎念的展示视图（src/shared 纯逻辑，浏览器 bundle 与桌面 shared-core 共用）：
// 文本 → 气泡行数据。**取数不在本模块**：改造后碎碎念由 host 定时器生成并写进 /state 的
// pets.<id>.say（与命令气泡、对话回复同一个叶子），两端只从 S 读——原先的
// fetchWhisperState / fetchWhisperTrigger 与 /whisper 的读端点一起删掉了。
// 不依赖 React/DOM。

/** 已解析的碎碎念结果：成功（一句话 + 可选配图）/ 失败（显式原因，不伪造文本）。
 *  仍保留这个形状：气泡行渲染按它分支，host 侧失败时也会用它表达原因。 */
export type WhisperState =
  | { ok: true; text: string; image?: string; ts: number }
  | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 碎碎念气泡行数据：一句话（role:'label' 单行，复用余额气泡的通用行渲染） */
export type WhisperBubbleRow = { role: 'label'; text: string };

/** 碎碎念文本 → 气泡行（两端共用同一份行数据；纯函数，不碰 DOM/React） */
export function whisperBubbleView(state: WhisperState): WhisperBubbleRow[] {
  if (state.ok) return [{ role: 'label', text: state.text }];
  const msg =
    state.reason === 'provider-missing'
      ? '当前对话未配置模型，碎碎念不可用'
      : '碎碎念生成失败' + (state.message ? '：' + state.message : '');
  return [{ role: 'label', text: msg }];
}

/**
 * 表情包图片 URL —— 与视频（/thumb）**同一套拼法**：
 * `<base>/pic/memes/<素材根>/<名称>.png`，素材根与名称都需编码（名称常含中文）。
 *
 * 为什么要带素材根：图片的归属与动画一致——`pet/<素材根>-memes/` 存在时该种类**只认自己**的
 * 表情包目录，否则才走「用户目录 → 包内 assets/memes」。不带素材根就无法表达"这张图属于哪只宠物"，
 * 宿主只能猜（同一张图名在两个种类的独占目录里都存在时更无从分辨）。
 * assetRoot 缺省/空白 → 退回旧的两段形式 `<base>/pic/memes/<名称>.png`（= 素材根 main 的目录链），
 * 未打标的宠物与老宿主仍能取到包内表情包，不至于图裂。
 *
 * base 语义 = 各端的「已含 /dsh-pet-7340 前缀的宿主基址」（**与视频的 assetBase 一致**）：
 *   - 浏览器：缺省 `/dsh-pet-7340`（页面就在宿主 origin 上，相对路径即可）；
 *   - 桌面：传 `BASE`（`http://127.0.0.1:<port>/dsh-pet-7340` 或 bridge 的
 *     `dsh-pet-bridge://dsh-pet/dsh-pet-7340`）——桌面页面是 file:// 加载的，
 *     相对路径会被解析成 file:///… 而必然失败；且 bridge 模式必须走自定义 scheme。
 *
 * 注意：base 已含 `/dsh-pet-7340`，函数内**不得**再拼一次（否则出现
 * `…/dsh-pet-7340/dsh-pet-7340/…` 而 404——桌面端图裂的成因）。
 */
export function memeImageUrl(name: string, base = '/dsh-pet-7340', assetRoot = ''): string {
  const root = String(assetRoot ?? '').trim();
  const prefix = root ? '/pic/memes/' + encodeURIComponent(root) : '/pic/memes';
  return base + prefix + '/' + encodeURIComponent(name) + '.png';
}

/** 气泡配图 class（两端共用，样式见 MEME_BUBBLE_CSS） */
export const MEME_IMG_CLASS = 'pet-bub-img';
/** 带图气泡 class：取消 min-width，让气泡贴合图片宽度（否则图旁留大片空白） */
export const MEME_BUBBLE_CLASS = 'has-img';

/** 气泡配图样式 —— 两端注入同一份（与 SCORE_POPUP_CSS / MENU_CSS 同理，避免两处各写一遍）。
 * 尺寸锚在**字号**上：基准 `--m` = 气泡正文最终字号 `--f`（各壳注入，见 shared/fonts.ts 的 resolveFontPx），
 * 于是字号调大图同步变大，图文比例不会一边涨一边不动；`--f` 未注入时回退到原表达式
 * （宠物宽 × 0.0455），与改造前一致，调用方无需传尺寸。
 * 系数 = 原系数 ÷ 0.0455，故默认 462px 宠物 / 21px 字号下与改造前逐像素一致（0.34 → 7.4725）。
 * `max-width:100%` 是兜底：气泡宽度上限随字号收口，图再宽也只缩到泡内，绝不顶出白底
 * （改造前图是固定 0.34×宠物宽且无上限：关掉 followPet 把字号调到 14 以下时，图会戳出气泡约 25px）。 */
export const MEME_BUBBLE_CSS = [
  '.pet-bub-img{--m:var(--f,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.0455));display:block;' +
    'width:calc(var(--m)*7.4725);max-width:100%;height:auto;border-radius:calc(var(--m)*0.5714);' +
    'margin:0 auto calc(var(--m)*0.3736);object-fit:cover;pointer-events:none;user-select:none}',
  '.pet-bubble.has-img,.dsh-pet-bubble.has-img{min-width:0}',
].join('');

/** 只注入一次（两端共用；页面已有同一标记则跳过） */
let memeCssInjected = false;
export function injectMemeBubbleCss(): void {
  if (memeCssInjected || typeof document === 'undefined') return;
  memeCssInjected = true;
  if (document.querySelector('style[data-plugin-css="dsh-pet/meme-bubble"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/meme-bubble';
  tag.textContent = MEME_BUBBLE_CSS;
  document.head.appendChild(tag);
}

/**
 * 生成气泡配图节点（两端共用同一份渲染：浏览器 React 壳与桌面 DOM 壳都调它）。
 * 返回 null 表示「本次不配图」——调用方据此走纯文本路径（老行为不变）。
 * @param name 配图名称（配置 memes 的键）；缺省/空白 → null
 * @param base 已含 /dsh-pet-7340 的宿主基址（与视频同规则）：浏览器缺省，桌面传 BASE
 * @param assetRoot 素材根（= 该宠物的条目 key）：决定图片去哪个表情包目录链取，见 memeImageUrl
 */
export function createMemeImage(name?: string, base = '/dsh-pet-7340', assetRoot = ''): HTMLImageElement | null {
  const key = String(name ?? '').trim();
  if (!key) return null;
  injectMemeBubbleCss();
  const img = document.createElement('img');
  img.className = MEME_IMG_CLASS;
  img.src = memeImageUrl(key, base, assetRoot);
  img.alt = key;
  return img;
}

/**
 * 生成「外部地址配图」节点 —— 配图的另一种形态（issue #122 第 1 条的 url 参数：素材由第三方
 * 自己托管，只给地址）。
 *
 * 与 createMemeImage 共用同一份 class 与样式（MEME_BUBBLE_CSS），区别只在 `src`：这里**直接用
 * 给定的完整地址**，不拼 `<base>/pic/memes/<素材根>/<名>.png`（地址与本页 origin 无关，所以
 * 连 `base` 都不需要——桌面端页面是 file://，正因如此名称形态才必须传 BASE）。
 *
 * 两种形态**二选一**，由宿主判定层保证；消费端按字段名区分，不做 `startsWith('http')` 嗅探。
 * 地址为空 → null（调用方走纯文本路径，与名称形态同一契约）。
 */
export function createMemeImageFromUrl(url?: string): HTMLImageElement | null {
  const href = String(url ?? '').trim();
  if (!href) return null;
  injectMemeBubbleCss();
  const img = document.createElement('img');
  img.className = MEME_IMG_CLASS;
  img.src = href;
  img.alt = '';
  return img;
}
