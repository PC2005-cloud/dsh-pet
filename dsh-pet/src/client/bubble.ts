// 余额气泡（client 半侧）：展示当前服务商余额/用量。哑组件——数据由上层传入，
// 自身不发起请求；工厂形态与 pet.ts 一致（react 由 DSH 运行时注入）。
// 内容（文案/档位/数学）来自 src/shared/balance.ts 的 balanceBubbleView ——
// 与桌面模式共用同一份行数据，本文件只负责把行数据映射成 React 节点。
import { balanceBubbleView, type BalanceBubbleRow, type BalanceState } from '../shared/balance';
import {
  MEME_BUBBLE_CLASS,
  MEME_IMG_CLASS,
  injectMemeBubbleCss,
  memeImageUrl,
  whisperBubbleView,
} from '../shared/whisper';
import type { ReactNode } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 气泡内联样式：白色半透明圆润泡 + 底部小尾巴指向宠物；字体用上首软糖体（本地打包，稳定）。
 * 所有尺寸基于 `--dsh-pet-size`（宠物宽度 px）等比缩放——宠物放大/缩小，气泡跟随。
 * 系数按默认 462px 设计：21px 字号 → ×0.0455、120px 最小宽 → 0.26、230px 最大宽 → 0.5 等。 */
const bubbleCss = [
  // 本地字体：/dsh-pet-7340/font/ 由 host 从 assets/fonts 提供；font-display swap 先回退后切换
  '@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/上首软糖体.ttf") format("truetype");font-display:swap;font-weight:400}',
  '.dsh-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-pet-size)*0.108);' +
    'min-width:calc(var(--dsh-pet-size)*0.26);max-width:calc(var(--dsh-pet-size)*0.5);' +
    'padding:calc(var(--dsh-pet-size)*0.022) calc(var(--dsh-pet-size)*0.030);' +
    'border-radius:calc(var(--dsh-pet-size)*0.035);' +
    'background:rgba(255,255,255,.92);' +
    'color:#2b2b2b;font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif;' +
    'font-size:calc(var(--dsh-pet-size)*0.0455);line-height:1.6;z-index:3;pointer-events:none;' +
    'box-shadow:0 calc(var(--dsh-pet-size)*0.009) calc(var(--dsh-pet-size)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;white-space:nowrap}',
  // 底部尾巴：小三角指向下方宠物（同样随宠物缩放）
  '.dsh-pet-bubble::after{content:"";position:absolute;left:50%;bottom:calc(var(--dsh-pet-size)*-0.017);' +
    'transform:translateX(-50%);border:calc(var(--dsh-pet-size)*0.017) solid transparent;' +
    'border-top-color:rgba(255,255,255,.92);border-bottom:none}',
  '.dsh-pet-bubble.is-on{opacity:1}',
  // 碎碎念变体：字号缩到余额气泡的 0.75（0.0455→0.034）、取消 nowrap 允许换行、
  // 宽度随文字数量自适应（短句窄框、长句封顶绕行），高度随行数自然增长
  '.dsh-pet-bubble.dsh-pet-whisper{font-size:calc(var(--dsh-pet-size)*0.034);' +
    'min-width:calc(var(--dsh-pet-size)*0.10);max-width:calc(var(--dsh-pet-size)*0.5);' +
    'white-space:normal;overflow-wrap:anywhere}',
  // 配图（碎碎念/对话共用）：样式在 shared 的 MEME_BUBBLE_CSS（两端同一份，由
  // createMemeImage 注入）——这里不再重复写一份，避免与桌面端 index.html 走样
  '.dsh-pet-bubble .pet-bub-title{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6);margin-bottom:calc(var(--dsh-pet-size)*0.009)}',
  '.dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--dsh-pet-size)*0.030)}',
  '.dsh-pet-bubble .pet-bub-sub{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6)}',
  '.dsh-pet-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--dsh-pet-size)*0.035)}',
  '.dsh-pet-bubble .pet-bub-tag{margin-left:calc(var(--dsh-pet-size)*0.013);font-size:calc(var(--dsh-pet-size)*0.022);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);' +
    'border-radius:calc(var(--dsh-pet-size)*0.013);padding:0 calc(var(--dsh-pet-size)*0.009);vertical-align:1px}',
  // 峰/谷计价档位标注：峰红、谷绿
  '.dsh-pet-bubble .pet-bub-tier{font-weight:700}',
  '.dsh-pet-bubble .pet-bub-tier-peak{color:#e53935}',
  '.dsh-pet-bubble .pet-bub-tier-idle{color:#2e9e4f}',
].join('\n');

/** 只注入一次 */
function injectBubbleCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-pet/bubble"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/bubble';
    tag.textContent = bubbleCss;
    document.head.appendChild(tag);
  }
}

/** 行数据 → React 节点（shared 视图的薄壳） */
function rowsToNodes(h: typeof jsx, rows: BalanceBubbleRow[]): ReactNode {
  // 含档位段（deepseek 余额单行）：同一行内联渲染，峰/谷着色
  if (rows.some((r) => r.role === 'tier')) {
    return h('div', {
      className: 'pet-bub-row',
      children: rows.map((r, i) => {
        if (r.role === 'tier') {
          return h('span', {
            key: i,
            className: 'pet-bub-tier pet-bub-tier-' + r.tier,
            children: r.text,
          });
        }
        return h('span', { key: i, children: r.text });
      }),
    });
  }
  // 其余：每行一个块（label 主行 / sub 次要行 / error 错误行）
  return rows.map((r, i) => {
    if (r.role === 'error') return h('div', { key: i, className: 'pet-bub-err', children: r.text });
    if (r.role === 'sub') return h('div', { key: i, className: 'pet-bub-row pet-bub-sub', children: r.text });
    return h('div', { key: i, className: 'pet-bub-row', children: r.text });
  });
}

/**
 * 制造余额气泡（工厂）。
 * 工厂内注入样式一次（与 pet.ts 的 injectCss 同模式）；组件为哑组件，props = { state, on }。
 * 内容来自 src/shared 的 balanceBubbleView（与桌面模式完全一致）。
 */
export function makeBalanceBubble(rt: { h: typeof jsx }): (props: { state: BalanceState; on: boolean }) => ReactNode {
  const { h } = rt;
  injectBubbleCss();

  return function BalanceBubble({ state, on }: { state: BalanceState; on: boolean }) {
    const rows = balanceBubbleView(state);
    // 不可用状态（不支持/缺凭证/抓取失败）是**多行文字说明**：套用碎碎念的换行变体
    // （余额气泡默认 white-space:nowrap，长文案会直接顶出宠物宽度）
    const wrap = state.ok ? '' : ' dsh-pet-whisper';
    return h('div', {
      className: 'dsh-pet-bubble' + wrap + (on ? ' is-on' : ''),
      children: rowsToNodes(h, rows),
    });
  };
}

/**
 * 制造碎碎念气泡（工厂）。
 * 与余额气泡共用同一套样式（dsh-pet-bubble）与行渲染（rowsToNodes）；
 * 内容来自 src/shared 的 whisperBubbleView（与桌面模式完全一致）。
 * image：配图名称（配置 memes 的键），有值则在文字上方渲染该表情包；
 *        图片样式取自 shared 的 MEME_BUBBLE_CSS（两端同一份，这里只声明式建节点）。
 * assetRoot：素材根（= 该宠物的条目 key），决定图片去哪个表情包目录链取
 *        （种类独占 pet/<名>-memes/ → 用户目录 → 包内），与动画素材同一套归属语义。
 */
export function makeWhisperBubble(rt: {
  h: typeof jsx;
}): (props: { text: string; image?: string; assetRoot?: string; on: boolean }) => ReactNode {
  const { h } = rt;
  injectBubbleCss();
  injectMemeBubbleCss();

  return function WhisperBubble({
    text,
    image,
    assetRoot,
    on,
  }: {
    text: string;
    image?: string;
    assetRoot?: string;
    on: boolean;
  }) {
    const rows = whisperBubbleView({ ok: true, text, ts: 0 });
    const key = String(image ?? '').trim();
    return h('div', {
      className: 'dsh-pet-bubble dsh-pet-whisper' + (key ? ' ' + MEME_BUBBLE_CLASS : '') + (on ? ' is-on' : ''),
      children: key
        ? [
            h('img', {
              key: 'img',
              className: MEME_IMG_CLASS,
              // 浏览器端基址就是本页 origin 下的路由前缀（与上面 @font-face 同一个字面量）
              src: memeImageUrl(key, '/dsh-pet-7340', assetRoot),
              alt: key,
            }),
            rowsToNodes(h, rows),
          ]
        : rowsToNodes(h, rows),
    });
  };
}
