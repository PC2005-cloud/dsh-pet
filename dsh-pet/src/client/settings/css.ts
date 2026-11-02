/**
 * 设置页样式表与注入入口：三族类名——`dsh-pet-mp__*`（AI 模型选择器）、`dsh-pet-sel__*`（通用单选下拉）与 `dsh-pet-cfg__*`（配置卡片）。
 * 只放伪类、悬浮、过渡与容器查询这类内联 style 表达不了的东西，其余排版走组件内联 style。
 * 颜色与圆角取 `--dsw-alias-*` / `--dsw-radius-*` token；填充按钮上的白字与阴影回退值是刻意例外。
 * 注入按 `data-plugin-css` 去重，同一页面重复渲染设置页不会长第二份样式。
 * @module dsh-pet/src/client/settings/css
 */

/** 设置页样式表；按类名族分段拼成单段文本，行内注释标出反直觉的那几条规则。 */
const SETTINGS_CSS = [
  '.dsh-pet-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.dsh-pet-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:340px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}',
  '.dsh-pet-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
  '.dsh-pet-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
  '.dsh-pet-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}',
  '.dsh-pet-mp__chevron.is-open{transform:rotate(180deg)}',
  // 浮层用 fixed 脱离设置页的滚动容器（不被 overflow 裁掉）；z-index 与插件右键菜单同一档。
  '.dsh-pet-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
  '.dsh-pet-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}',
  // overflow-x 必须显式 hidden：只设 overflow-y 时 CSS 会把另一轴的 visible 抬成 auto，
  // 而条目是 width:100% + 左右 padding，横向会多出 16px，于是冒出没用的横向滚动条。
  '.dsh-pet-mp__list{display:flex;flex-direction:column;min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin}',
  '.dsh-pet-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-pet-mp__item:hover:not(:disabled),.dsh-pet-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-mp__item[aria-checked="true"]{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__check{flex:none;margin-left:auto}',
  '.dsh-pet-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

  // 通用单选下拉：触发器叠加在 __inp 之上，只补按钮该有而输入框没有的排布；浮层与上面的模型选择器同一套外观。
  '.dsh-pet-sel{position:relative;min-width:0}',
  '.dsh-pet-sel__trigger{display:flex;align-items:center;gap:6px;text-align:left;cursor:pointer}',
  '.dsh-pet-sel__trigger:disabled{cursor:default}',
  '.dsh-pet-sel__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  // 箭头用小三角而不是字符：不依赖字体，旋转时的基线与折叠卡一致。
  '.dsh-pet-sel__chevron{flex:none;margin-left:auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;color:var(--dsw-alias-label-tertiary);transition:transform .12s}',
  '.dsh-pet-sel__chevron.is-open{transform:rotate(180deg)}',
  '.dsh-pet-sel__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:2px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-sel__list{display:flex;flex-direction:column;min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin}',
  '.dsh-pet-sel__item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-pet-sel__item:hover:not(:disabled),.dsh-pet-sel__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-sel__item[aria-selected="true"]{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-sel__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-sel__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-sel__check{flex:none;margin-left:auto}',

  '.dsh-pet-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.dsh-pet-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}',

  '.dsh-pet-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
  '.dsh-pet-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}',
  '.dsh-pet-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',

  // 折叠卡（高级配置 / 卸载与存储）：标题行常驻，正文收进裁剪层。
  // 卡片自身的 gap 归零，头与正文的间距改由正文内层的 padding-top 提供——收起时随裁剪一起消失，底部不留空缝。
  '.dsh-pet-cfg__card.is-fold{gap:0}',
  '.dsh-pet-cfg__foldToggle{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;min-height:20px;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;outline:none}',
  '.dsh-pet-cfg__foldToggle:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
  // 箭头用小三角而不是字符：不依赖字体、缩进也不受行高影响。
  '.dsh-pet-cfg__chevron{flex:none;margin-left:auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;color:var(--dsw-alias-label-tertiary);transition:transform .12s}',
  '.dsh-pet-cfg__chevron.is-open{transform:rotate(180deg)}',
  '.dsh-pet-cfg__fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows .12s ease}',
  '.dsh-pet-cfg__card.is-open .dsh-pet-cfg__fold{grid-template-rows:1fr}',
  '.dsh-pet-cfg__foldClip{min-height:0;overflow:hidden}',
  '.dsh-pet-cfg__foldBody{display:flex;flex-direction:column;gap:10px;padding-top:10px}',

  '.dsh-pet-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',

  '@container (max-width:600px){.dsh-pet-cfg__grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@container (max-width:400px){.dsh-pet-cfg__grid2,.dsh-pet-cfg__grid3,.dsh-pet-cfg__grid4{grid-template-columns:minmax(0,1fr)}}',

  '.dsh-pet-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-pet-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',

  // 顶部一行：头像作左列，右侧是 2×2 的输入网格；窄容器降成单列，头像回到输入之上。
  '.dsh-pet-cfg__topRow{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px 18px;align-items:stretch;margin-bottom:10px}',

  // 头像：宽度固定，高度**撑满右侧两行**——否则头像下方会空出一大块（右列比 72px 高得多）。
  // 能换的时候整块就是按钮：悬浮出遮罩、点它直接开文件框，没有独立按钮。
  '.dsh-pet-cfg__avatarCol{position:relative;width:120px;flex:none}',
  '.dsh-pet-cfg__avatarImg{display:block;width:100%;height:100%;min-height:72px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);object-fit:cover;background:var(--dsw-alias-bg-layer-1)}',
  '.dsh-pet-cfg__avatarPick{position:relative;display:block;height:100%;border-radius:14px}',
  // 键盘可达：input 铺满整块且透明（display:none 会让它不可聚焦）；焦点与悬浮一样出遮罩。
  '.dsh-pet-cfg__avatarPick:focus-within{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
  // 遮罩用 token，缺 token 时回退到半透明黑：与本文件其它「token + fallback」写法一致，
  // 不在规则里直接写字面色值。文字色同理用静态白 token。
  '.dsh-pet-cfg__avatarMask{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:14px;background:var(--dsw-alias-bg-mask,rgba(0,0,0,.55));color:var(--dsw-static-neutral-00,#fff);font-size:12px;line-height:1;opacity:0;transition:opacity .12s;pointer-events:none}',
  '.dsh-pet-cfg__avatarPick:hover .dsh-pet-cfg__avatarMask,.dsh-pet-cfg__avatarPick:focus-within .dsh-pet-cfg__avatarMask,.dsh-pet-cfg__avatarMask.is-busy{opacity:1}',
  '.dsh-pet-cfg__file{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:0}',

  // 竖排时没有「右侧两行」可撑：头像回到 72px 的方块，否则会被拉成整宽的大图。
  '@container (max-width:400px){.dsh-pet-cfg__topRow{grid-template-columns:minmax(0,1fr)}.dsh-pet-cfg__avatarCol{width:72px}.dsh-pet-cfg__avatarImg{height:72px;min-height:0}}',

  '.dsh-pet-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
  '.dsh-pet-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',

  // 人设复用 __inp 的边框与字号，只补高度与纵向缩放；人设没有长度上限，右下角只显示字数、不阻断输入。
  '.dsh-pet-cfg__persona{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.dsh-pet-cfg__area{min-height:66px;resize:vertical;line-height:18px}',
  '.dsh-pet-cfg__count{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right}',

  '.dsh-pet-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
  '.dsh-pet-cfg__toggle>label>span{overflow-wrap:anywhere}',
  '.dsh-pet-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',

  // 悬浮说明气泡：由 ./tip-layer 按光标挂到 body 上，不画在触发元素里——右列与贴顶的说明
  // 会被窗口边缘或滚动容器裁掉。这里只管外观，坐标由 tooltipPlacement 写进 style。
  '.pet-cfg-tip{position:fixed;left:0;top:0;z-index:2147483000;max-width:320px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-00);font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;opacity:0;transition:opacity .12s ease;box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.22))}',
  '.pet-cfg-tip.is-on{opacity:1}',

  // 问号：气泡的一个圆形宿主外观。
  '.dsh-pet-cfg__q{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',
  // 折叠卡把问号放进了标题按钮里：包一层 span 以便单独拦截点击（点问号只出气泡、不开合）。
  '.dsh-pet-cfg__qWrap{display:inline-flex;flex:none;align-items:center}',

  '.dsh-pet-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
  // 实心主按钮必须排除在通用 hover 外：半透明 hover 会顶掉 button-info-fill，让蓝色按钮一悬停就发白；
  // 主按钮的 hover 走主题自己的 button-info-hover。
  '.dsh-pet-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
  '.dsh-pet-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dsh-pet-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__btn.is-sm{padding:2px 10px}',
  '.dsh-pet-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dsh-pet-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  // 种类条单独一行：与下面的宠物条隔开，避免两组按钮读成一行。
  '.dsh-pet-cfg__kinds{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
  '.dsh-pet-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}',
  '.dsh-pet-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__tab:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-pet-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
  '.dsh-pet-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
  '.dsh-pet-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}',
  '.dsh-pet-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
].join('\n');

/** 注入去重用的标记值，写在 `<style>` 的 `data-plugin-css` 上。 */
const settingsCssTag = 'dsh-pet/settings.css';

/** 把设置页样式注入 `document.head`：幂等，且没有 document（SSR 或单测）时直接返回。 */
export function injectSettingsCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + settingsCssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = settingsCssTag;
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
}
