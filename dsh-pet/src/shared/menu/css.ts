/**
 * 右键菜单样式：只列选择器与规则，注入由挂载侧统一负责。
 *
 * 不含交互逻辑。菜单是覆盖在网页与桌面内容之上的浮层，需要固定对比度，所以自带一套
 * 浅色调色盘、不读宿主 `--dsw-*` 变量：跟随主题会在深色背景上糊成一片，桌面渲染进程
 * 也不注入那组 token，两端看起来会不一样。
 * 必须始终成立：菜单配色只出现在本文件，调用方不得另行覆盖。
 * @module dsh-pet/src/shared/menu/css
 */
import { SIZE_PANEL_CSS } from './size-panel.ts';

/** 菜单样式 —— 两端注入同一份。每级面板是独立的绝对定位盒子，位置由 JS 内联写入，互不嵌套。 */
export const MENU_CSS = [
  // 浮层固定浅色：对比度与两端口径一致，优先于跟随宿主主题。
  '.dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
  '.dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}',
  '.dsh-pet-menu-column{position:absolute;min-width:150px;max-width:300px;padding:4px;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;',
  // 自定义滚动条：Chromium 系走 ::-webkit-scrollbar，Firefox 走 scrollbar-width/scrollbar-color；
  // thumb 用 border + background-clip 内缩留白，与圆角白底协调。
  'scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}',
  '.dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}',
  '.dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;',
  'gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}',
  '.dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}',
  // 文字占满剩余宽度：菜单项是 space-between 的 flex 行，label 吃掉弹性空间后，箭头与 hint 才会贴右。
  // 按类名选而不是 `>span:first-child`——带缩略图的项里第一个子节点是 img。
  '.dsh-pet-menu-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
  // 配图缩略图：裁成方形小图，不参与拉伸；行高由它撑到 28+padding。
  '.dsh-pet-menu-thumb{width:28px;height:28px;border-radius:4px;object-fit:cover;flex:none;',
  'background:rgba(0,0,0,.06)}',
  // 带图的项：图与文字之间收窄（默认 14px 是给「文字 ↔ 箭头」的间距）
  '.dsh-pet-menu-item-pic{gap:8px}',
  // 右侧快捷键提示（菜单项 hint）：与 label 同一 flex 行，space-between 自动贴右
  '.dsh-pet-menu-hint{color:#9aa0a6;font-size:12px;flex:none;white-space:nowrap}',
  '.dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}',
  // 大小滑块与菜单同源：两端各注入一次菜单样式，滑块样式搭车，避免再挂一个 <style>。
  ...SIZE_PANEL_CSS,
].join('');
