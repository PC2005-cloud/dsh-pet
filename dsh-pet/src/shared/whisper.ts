import { ROUTE_PATH } from './constants.ts';
/**
 * 碎碎念的展示视图：文本 → 气泡行数据，以及配图节点与样式。
 * 不负责取数、生成与失败判定——宿主半侧生成后写进 /state 的 pets.<id>.say，两端只从轮询状态读。
 * 不依赖 React；只有配图节点构造用到 DOM。
 * @module dsh-pet/src/shared/whisper
 */

/** 已解析的碎碎念结果：成功（一句话 + 可选配图）或失败（显式原因，不伪造文本）。
 *  保留这个形状是因为气泡行渲染按它分支，宿主侧失败时也用它表达原因。 */
export type WhisperState =
  | { ok: true; text: string; image?: string; ts: number }
  | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 碎碎念气泡行数据：一句话（role: 'label' 单行，复用余额气泡的通用行渲染）。 */
export type WhisperBubbleRow = { role: 'label'; text: string };

/** 碎碎念文本 → 气泡行（两端共用同一份行数据）。 */
export function whisperBubbleView(state: WhisperState): WhisperBubbleRow[] {
  if (state.ok) return [{ role: 'label', text: state.text }];
  const msg =
    state.reason === 'provider-missing'
      ? '当前对话未配置模型，碎碎念不可用'
      : '碎碎念生成失败' + (state.message ? '：' + state.message : '');
  return [{ role: 'label', text: msg }];
}

/** 表情包图片 URL，与视频同一套拼法：`<base>/pic/memes/<素材根>/<名称>.png`（素材根与名称都需编码）。
 *  带素材根是为了表达这张图属于哪只宠物：`pet/<素材根>-memes/` 存在时该种类只认自己的目录，
 *  否则走用户目录与包内 assets/memes；assetRoot 为空则退回两段形式，未打标的宠物与老宿主仍能取到图。
 *  base 已含 /dsh-pet-7340 前缀（与视频的 assetBase 一致），函数内不得再拼一次，否则桌面端图裂。
 *  桌面页面是 file:// 加载的，相对路径会解析成 file:/// 而必然失败，所以桌面传绝对基址。 */
export function memeImageUrl(name: string, base = ROUTE_PATH, assetRoot = ''): string {
  const root = String(assetRoot ?? '').trim();
  const prefix = root ? '/pic/memes/' + encodeURIComponent(root) : '/pic/memes';
  return base + prefix + '/' + encodeURIComponent(name) + '.png';
}

/** 气泡配图 class（两端共用，样式见 MEME_BUBBLE_CSS）。 */
export const MEME_IMG_CLASS = 'pet-bub-img';
/** 带图气泡 class：取消 min-width，让气泡贴合图片宽度（否则图旁留大片空白）。 */
export const MEME_BUBBLE_CLASS = 'has-img';

/** 气泡配图样式 —— 两端注入同一份。
 *  尺寸锚在字号上：--m = 气泡正文最终字号 --f（各壳按 shared/fonts.ts 的 resolveFontPx 注入），
 *  字号调大图同步变大；--f 未注入时回退到宠物宽 × 0.0455。
 *  系数 = 0.34 ÷ 0.0455 ≈ 7.4725，默认 462px 宠物 / 21px 字号下与固定 0.34 × 宠物宽等价。
 *  max-width:100% 是兜底：关掉 followPet 把字号调小后，固定宽度的图会戳出气泡。 */
export const MEME_BUBBLE_CSS = [
  '.pet-bub-img{--m:var(--f,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.0455));display:block;' +
    'width:calc(var(--m)*7.4725);max-width:100%;height:auto;border-radius:calc(var(--m)*0.5714);' +
    'margin:0 auto calc(var(--m)*0.3736);object-fit:cover;pointer-events:none;user-select:none}',
  '.pet-bubble.has-img,.dsh-pet-bubble.has-img{min-width:0}',
  // 语音状态角标：两端共用；绝对定位在气泡右下角，不参与文字排版、不撑高气泡。
  '.dsh-pet-voice-badge{position:absolute;right:calc(var(--f,21px)*0.25);bottom:calc(var(--f,21px)*0.15);' +
    'width:calc(var(--f,21px)*0.66);height:calc(var(--f,21px)*0.66);display:flex;align-items:center;' +
    'justify-content:center;font-size:calc(var(--f,21px)*0.5);line-height:1;opacity:.65;pointer-events:none}',
  // 加载态：只有上半圈有颜色的细环，靠旋转表达「在转」。
  '.dsh-pet-voice-badge.is-loading::before{content:"";width:calc(var(--f,21px)*0.5);height:calc(var(--f,21px)*0.5);' +
    'border:1.5px solid rgba(43,43,43,.22);border-top-color:rgba(43,43,43,.7);border-radius:50%;' +
    'animation:dsh-pet-voice-spin .8s linear infinite}',
  '@keyframes dsh-pet-voice-spin{to{transform:rotate(360deg)}}',
  // 失败态：静音喇叭，压一点透明度——读得出「这句没念出来」，但不抢文字。
  '.dsh-pet-voice-badge.is-failed{opacity:.5}',
].join('');

/** 只注入一次（页面已有同一标记则跳过）。 */
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

/** 生成气泡配图节点（两端共用同一份渲染）；返回 null 表示本次不配图，调用方走纯文本路径。
 *  @param name - 配图名称（配置 memes 的键），缺省或空白 → null。
 *  @param base - 已含 /dsh-pet-7340 的宿主基址（与视频同规则）：浏览器缺省，桌面传 BASE。
 *  @param assetRoot - 素材根（= 该宠物的条目 key），决定图片去哪个表情包目录链取。 */
export function createMemeImage(name?: string, base = ROUTE_PATH, assetRoot = ''): HTMLImageElement | null {
  const key = String(name ?? '').trim();
  if (!key) return null;
  injectMemeBubbleCss();
  const img = document.createElement('img');
  img.className = MEME_IMG_CLASS;
  img.src = memeImageUrl(key, base, assetRoot);
  img.alt = key;
  return img;
}

/** 生成外部地址配图节点（素材由第三方托管，只给地址）。
 *  与 createMemeImage 共用 class 与样式，区别只在 src：直接用给定地址，不拼表情包路径，也不需要 base。
 *  两种形态二选一由宿主保证，消费端按字段名区分，不做 startsWith('http') 嗅探；地址为空 → null。 */
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
