/**
 * 浏览器半侧的余额与碎碎念气泡：哑组件，只把 shared 的行数据或节点树映射成 React 节点。
 * 不发起请求，显隐与停留时长由 pet.ts 控制。
 * 依赖运行时注入的 react 与 shared 的 balance / whisper 视图。
 * 必须始终成立：样式与桌面端同源，文案与档位由 shared 计算。
 * @module dsh-pet/src/client/bubble
 */
import {
  balancePageView,
  customClickable,
  customViews,
  type BalanceBubbleRow,
  type BalanceState,
  type CustomNode,
} from '../shared/balance/index.ts';
import {
  MEME_BUBBLE_CLASS,
  MEME_IMG_CLASS,
  injectMemeBubbleCss,
  memeImageUrl,
  whisperBubbleView,
} from '../shared/whisper.ts';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import { ROUTE_PATH } from '../shared/constants.ts';

/** 气泡内联样式：白色半透明圆泡加底部小尾巴，盒子尺寸锚字号 `--f`，位置锚宠物尺寸。
 *  width:max-content 不可省：left:50% 的绝对定位盒可用宽度只有包含块一半，shrink-to-fit
 *  会先被卡死；先按内容取宽，再由 max-width 收口。box-sizing 钉死 content-box，避免宿主
 *  全局 border-box 把内边距算进宽度；断词用 break-word，数字与单位不会被拆行。
 */
const bubbleCss = [
  // 本地字体：由 host 从 assets/fonts 提供；font-display:swap 先回退后切换。
  `@font-face{font-family:"ShangshouSoftCandy";src:url("${ROUTE_PATH}/font/上首软糖体.ttf") format("truetype");font-display:swap;font-weight:400}`,
  '.dsh-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-pet-size)*0.108);' +
    'width:max-content;min-width:calc(var(--f)*5.7143);max-width:min(calc(var(--f)*16),100%);' +
    // 钉死 content-box：宿主可能全局设了 border-box，让 min/max-width 把内边距算进去，
    // 表现为「明明还有空位却折行」；桌面端同样钉死，两端一致。
    'box-sizing:content-box;' +
    'padding:calc(var(--f)*0.4835) calc(var(--f)*0.6593);' +
    'border-radius:calc(var(--f)*0.7692);' +
    'background:rgba(255,255,255,.92);' +
    '--f0:var(--dsh-pet-font-bubble,calc(var(--dsh-pet-size)*0.0455));--f:var(--f0);' +
    'color:#2b2b2b;font-family:var(--dsh-pet-font-family,"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif);' +
    'font-size:var(--f);line-height:1.6;z-index:3;pointer-events:none;' +
    'box-shadow:0 calc(var(--f)*0.1978) calc(var(--f)*0.7692) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;' +
    'white-space:normal;overflow-wrap:break-word}',
  // 底部尾巴：小三角指向下方宠物，尺寸锚字号。
  '.dsh-pet-bubble::after{content:"";position:absolute;left:50%;bottom:calc(var(--f)*-0.3736);' +
    'transform:translateX(-50%);border:calc(var(--f)*0.3736) solid transparent;' +
    'border-top-color:rgba(255,255,255,.92);border-bottom:none}',
  '.dsh-pet-bubble.is-on{opacity:1}',
  // 碎碎念变体：字号缩到余额气泡的 0.75，宽度下限更窄，上限与折行规则相同。
  '.dsh-pet-bubble.dsh-pet-whisper{font-size:calc(var(--f)*0.7473);' +
    'min-width:calc(var(--f)*2.1978);max-width:min(calc(var(--f)*10.989),100%)}',
  // 配图样式在 shared 的 MEME_BUBBLE_CSS，这里只保留标题与行样式。
  '.dsh-pet-bubble .pet-bub-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6);margin-bottom:calc(var(--f)*0.1978)}',
  '.dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--f)*0.6593);flex-wrap:wrap}',
  // 档位行由多个片段拼成：只在片段之间换行，片段内部不拆字，避免竖排。
  '.dsh-pet-bubble .pet-bub-row>span{white-space:nowrap}',
  '.dsh-pet-bubble .pet-bub-sub{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}',
  '.dsh-pet-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--f)*0.7692)}',
  '.dsh-pet-bubble .pet-bub-tag{margin-left:calc(var(--f)*0.2857);font-size:calc(var(--f)*0.4835);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);' +
    'border-radius:calc(var(--f)*0.2857);padding:0 calc(var(--f)*0.1978);vertical-align:1px}',
  // 峰/谷计价档位：峰红、谷绿。
  '.dsh-pet-bubble .pet-bub-tier{font-weight:700}',
  '.dsh-pet-bubble .pet-bub-tier-peak{color:#e53935}',
  '.dsh-pet-bubble .pet-bub-tier-idle{color:#2e9e4f}',
  // 展开态：每个窗口一行，进度条长度等于已用百分比。
  // 气泡默认不挡宿主页面，只有可展开的余额气泡才开命中。
  '.dsh-pet-bubble.is-clickable{pointer-events:auto;cursor:pointer}',
  // 收起态排不下「窗口名 + 条 + 百分比 + 重置」四列，展开态单独加宽并缩到 60% 字号。
  '.dsh-pet-bubble.is-expanded{--f:calc(var(--f0)*0.6);width:min(calc(var(--f)*21),100%);max-width:100%}',
  // 淡出：换内容前先透明，换完去掉这个类再淡入。
  '.dsh-pet-bubble.is-on.is-fading{opacity:0}',
  '.dsh-pet-bubble .pet-bub-quota{display:flex;align-items:center;gap:calc(var(--f)*0.4);margin:calc(var(--f)*0.13) 0}',
  '.dsh-pet-bubble .pet-bub-quota-label{flex:none;min-width:calc(var(--f)*1.9);font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}',
  '.dsh-pet-bubble .pet-bub-quota-bar{flex:1 1 auto;height:calc(var(--f)*0.5);border-radius:calc(var(--f)*0.25);background:rgba(43,43,43,.12);overflow:hidden}',
  '.dsh-pet-bubble .pet-bub-quota-fill{display:block;height:100%;border-radius:inherit;background:#2e9e4f}',
  '.dsh-pet-bubble .pet-bub-quota-fill.pet-bub-quota-warn{background:#e8952f}',
  '.dsh-pet-bubble .pet-bub-quota-fill.pet-bub-quota-crit{background:#e53935}',
  '.dsh-pet-bubble .pet-bub-quota-used{flex:none;min-width:calc(var(--f)*2.2);text-align:right;font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-quota-reset{flex:none;min-width:calc(var(--f)*2.6);text-align:right;font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}',
  // 用量页（第三页）：三行两列占满展开态宽度，总量是唯一的大字。
  // 配色只给进/出两处强调，其余沿用次级灰——同页里超过两种彩色会盖过数值本身。
  '.dsh-pet-bubble .pet-bub-usage{display:flex;flex-direction:column;gap:calc(var(--f)*0.22);margin:calc(var(--f)*0.1) 0}',
  '.dsh-pet-bubble .pet-bub-usage-line{display:flex;align-items:baseline;justify-content:space-between;gap:calc(var(--f)*0.8);line-height:1.45}',
  '.dsh-pet-bubble .pet-bub-usage-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.62)}',
  '.dsh-pet-bubble .pet-bub-usage-total{font-size:calc(var(--f)*1.45);line-height:1.2;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-usage-in{font-size:calc(var(--f)*0.7692);font-variant-numeric:tabular-nums;color:#3f6ea8}',
  '.dsh-pet-bubble .pet-bub-usage-out{font-size:calc(var(--f)*0.7692);font-variant-numeric:tabular-nums;color:#b4703c}',
  '.dsh-pet-bubble .pet-bub-usage-period{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.62)}',
  '.dsh-pet-bubble .pet-bub-usage-spend{font-size:calc(var(--f)*0.7692);font-weight:650;font-variant-numeric:tabular-nums;color:#1f1f1f}',
  // 进出比例条：两段按真实占比分宽，颜色与下面的数字一一对应；占比极小时只留一条细线，不放大。
  '.dsh-pet-bubble .pet-bub-usage-bar{display:flex;height:calc(var(--f)*0.3);border-radius:calc(var(--f)*0.15);overflow:hidden;background:rgba(43,43,43,.1);margin:calc(var(--f)*0.05) 0}',
  '.dsh-pet-bubble .pet-bub-usage-bar-in{display:block;height:100%;background:#3f6ea8}',
  '.dsh-pet-bubble .pet-bub-usage-bar-out{display:block;height:100%;background:#b4703c}',
].join('\n');

/** 注入气泡样式，每页只注入一次。 */
function injectBubbleCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-pet/bubble"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/bubble';
    tag.textContent = bubbleCss;
    document.head.appendChild(tag);
  }
}

/** 把余额行数据映射成 React 节点。 */
function rowsToNodes(h: typeof jsx, rows: BalanceBubbleRow[]): ReactNode {
  // 含档位段时同一行内联渲染，峰/谷着色。
  if (rows.some((r) => r.role === 'tier')) {
    return h('div', {
      className: 'pet-bub-row',
      children: rows.map((r, i) => {
        // 进度条行不会与档位段同现。
        if (r.role === 'quota') return null;
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
  // 其余每行一个块：label、sub、error、quota。
  return rows.map((r, i) => {
    // 展开态一行一个窗口；四段 flex 同行，进度条吃剩余宽度。
    if (r.role === 'quota') {
      return h('div', {
        key: i,
        className: 'pet-bub-quota',
        children: [
          h('span', { key: 'label', className: 'pet-bub-quota-label', children: r.label }),
          h('span', {
            key: 'bar',
            className: 'pet-bub-quota-bar',
            children: h('i', {
              className: 'pet-bub-quota-fill pet-bub-quota-' + r.tone,
              style: { width: Math.max(0, Math.min(100, r.percent)) + '%' },
            }),
          }),
          h('span', { key: 'used', className: 'pet-bub-quota-used', children: r.usedText }),
          h('span', { key: 'reset', className: 'pet-bub-quota-reset', children: r.resetText }),
        ],
      });
    }
    // 用量页：三行两列，总量是整卡唯一的大字；进/出各一处强调色，其余保持次级灰。
    if (r.role === 'usage') {
      return h('div', {
        key: i,
        className: 'pet-bub-usage',
        children: [
          h('div', {
            key: 'head',
            className: 'pet-bub-usage-line',
            children: [
              h('span', { key: 'title', className: 'pet-bub-usage-title', children: r.title }),
              h('span', { key: 'total', className: 'pet-bub-usage-total', children: r.total }),
            ],
          }),
          // 进出比例条：宽度即真实占比，输入通常压倒性占多数，条偏单色属正常。
          r.inputPercent === undefined
            ? null
            : h('div', {
                key: 'bar',
                className: 'pet-bub-usage-bar',
                children: [
                  h('i', { key: 'in', className: 'pet-bub-usage-bar-in', style: { width: r.inputPercent + '%' } }),
                  h('i', {
                    key: 'out',
                    className: 'pet-bub-usage-bar-out',
                    style: { width: 100 - r.inputPercent + '%' },
                  }),
                ],
              }),
          h('div', {
            key: 'io',
            className: 'pet-bub-usage-line',
            children: [
              h('span', { key: 'in', className: 'pet-bub-usage-in', children: r.input }),
              h('span', { key: 'out', className: 'pet-bub-usage-out', children: r.output }),
            ],
          }),
          h('div', {
            key: 'foot',
            className: 'pet-bub-usage-line',
            children: [
              h('span', { key: 'period', className: 'pet-bub-usage-period', children: r.period }),
              h('span', { key: 'spend', className: 'pet-bub-usage-spend', children: r.spend }),
            ],
          }),
        ],
      });
    }
    if (r.role === 'error') return h('div', { key: i, className: 'pet-bub-err', children: r.text });
    if (r.role === 'sub') return h('div', { key: i, className: 'pet-bub-row pet-bub-sub', children: r.text });
    return h('div', { key: i, className: 'pet-bub-row', children: r.text });
  });
}

/** 把自定义节点树映射成 React 节点，与 rowsToNodes 并列。
 *  行数据由插件定排版，这里把第三方定好的 tag、内联样式与文本原样映射。
 *  解析层已做白名单裁剪，故不做二次校验；不用 innerHTML，没有注入面。
 *  先文本后子节点，与 DOM 的 textContent + appendChild 顺序一致。
 */
function treeToNodes(h: typeof jsx, node: CustomNode, key: string | number): ReactNode {
  const props: Record<string, unknown> = { key };
  if (node.style) props.style = node.style;
  if (node.tag === 'img') {
    // 配图地址只来自解析层的 http/https 白名单；alt 留空由周围文本承担。
    props.src = node.src ?? '';
    props.alt = '';
    return h('img', props);
  }
  const children: ReactNode[] = [];
  if (node.text) children.push(node.text);
  for (let i = 0; i < (node.children?.length ?? 0); i++) {
    children.push(treeToNodes(h, node.children![i]!, i));
  }
  props.children = children;
  return h(node.tag, props);
}

/** 换内容前的淡出等待（ms），与 opacity 过渡同为 250ms。 */
const BALANCE_FADE_MS = 250;

/** 制造余额气泡组件（工厂），注入样式一次。
 *  内容来自 shared 的 balancePageView（按页取行数据）；内置形态走行数据，
 *  custom 走第三方节点树。切页是淡出 → 换内容 → 淡入，显隐与 10s 计时归 pet.ts 管。
 */
export function makeBalanceBubble(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）。
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}): (props: {
  state: BalanceState;
  on: boolean;
  /** 目标页：0 为初始页；内置 windows 形态下 0 收起、1 窗口明细、2 区间用量。 */
  index: number;
  /** 点击气泡：上层切到下一页并重置 10s 计时器。 */
  onCycle: () => void;
}) => ReactNode {
  const { h, useState, useEffect } = rt;
  injectBubbleCss();

  return function BalanceBubble({
    state,
    on,
    index,
    onCycle,
  }: {
    state: BalanceState;
    on: boolean;
    index: number;
    onCycle: () => void;
  }) {
    // shown 是实际显示页，index 是目标页；分开是为了留出淡出换内容的 250ms。
    const [shown, setShown] = useState(0);
    const [fading, setFading] = useState(false);
    useEffect(() => {
      if (index === shown) return;
      setFading(true);
      const timer = window.setTimeout(() => {
        setShown(index);
        setFading(false);
      }, BALANCE_FADE_MS);
      return () => window.clearTimeout(timer);
    }, [index, shown]);

    // 行数据与第三方节点树二选一；custom 页索引越界时夹到最后一页，避免显示残页。
    const isCustom = state.ok && state.shape === 'custom';
    const views = isCustom ? customViews(state) : undefined;
    const tree = views ? views[Math.min(shown, views.length - 1)] : undefined;
    const rows = isCustom ? [] : balancePageView(state, shown);
    // 可点：windows 可展开；custom 只有多于 1 页才可点；其余形态点开没有新内容。
    const clickable = state.ok && (state.shape === 'windows' || (isCustom && customClickable(state)));
    // 不可用状态是多行说明，套用碎碎念的窄字号变体。
    const wrap = state.ok ? '' : ' dsh-pet-whisper';
    // 展开态字号只属于内置 windows 的窗口明细与用量两页；custom 各页是对等页面，翻页不该切紧凑字号。
    return h('div', {
      className:
        'dsh-pet-bubble' +
        wrap +
        (on ? ' is-on' : '') +
        (clickable ? ' is-clickable' : '') +
        (!isCustom && shown > 0 ? ' is-expanded' : '') +
        (fading ? ' is-fading' : ''),
      // 就地吞掉，避免触发宠物本体的点击与拖拽。
      onClick: clickable
        ? (e: ReactNS.MouseEvent<HTMLDivElement>) => {
            e.stopPropagation();
            onCycle();
          }
        : undefined,
      children: tree ? treeToNodes(h, tree, 'tree') : rowsToNodes(h, rows),
    });
  };
}

/** 制造碎碎念气泡组件（工厂），与余额气泡共用样式与行渲染。
 *  image 是池内名（按素材根拼路径），url 是第三方完整地址，两者互斥且由 host 判定层保证。
 *  有配图时渲染在文字上方，图片样式取自 shared 的 MEME_BUBBLE_CSS。
 */
export function makeWhisperBubble(rt: {
  h: typeof jsx;
}): (props: {
  text: string;
  image?: string;
  url?: string;
  assetRoot?: string;
  on: boolean;
  voiceState?: 'idle' | 'loading' | 'ready' | 'failed';
}) => ReactNode {
  const { h } = rt;
  injectBubbleCss();
  injectMemeBubbleCss();

  return function WhisperBubble({
    text,
    image,
    url,
    assetRoot,
    on,
    voiceState = 'idle',
  }: {
    text: string;
    image?: string;
    url?: string;
    assetRoot?: string;
    on: boolean;
    voiceState?: 'idle' | 'loading' | 'ready' | 'failed';
  }) {
    const rows = whisperBubbleView({ ok: true, text, ts: 0 });
    const key = String(image ?? '').trim();
    const href = String(url ?? '').trim();
    // 配图二选一：url 直接用，image 按素材根拼路径；判别位在字段名上，不靠 startsWith 嗅探。
    const src = href || (key ? memeImageUrl(key, ROUTE_PATH, assetRoot) : '');
    const body = src
      ? [
          h('img', {
            key: 'img',
            className: MEME_IMG_CLASS,
            // 名称形态拼本页路由前缀；url 形态是完整地址，与本页 origin 无关。
            src,
            alt: key || href,
          }),
          rowsToNodes(h, rows),
        ]
      : rowsToNodes(h, rows);
    return h('div', {
      className: 'dsh-pet-bubble dsh-pet-whisper' + (src ? ' ' + MEME_BUBBLE_CLASS : '') + (on ? ' is-on' : ''),
      children: voiceState === 'idle' ? body : [body, voiceBadgeNode(h, voiceState)],
    });
  };
}

/** 语音状态角标：只在手动触发的播报上出现，右下角绝对定位，不参与文字排版。
 *  `failed` 用静音喇叭——「本该有声却没响」，不是系统告警，所以不上警告符号。 */
function voiceBadgeNode(h: typeof jsx, state: 'loading' | 'ready' | 'failed'): ReactNode {
  return h('span', {
    key: 'voice',
    className:
      'dsh-pet-voice-badge' + (state === 'loading' ? ' is-loading' : '') + (state === 'failed' ? ' is-failed' : ''),
    'aria-hidden': 'true',
    children: state === 'loading' ? null : state === 'failed' ? '🔇' : '🔊',
  });
}
