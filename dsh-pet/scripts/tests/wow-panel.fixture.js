import { mountWowPanel } from '../../src/shared/wow-panel/mount.ts';
import { WOW_PANEL_CSS } from '../../src/shared/wow-panel/style.ts';

const style = document.createElement('style');
style.textContent = WOW_PANEL_CSS;
document.head.append(style);
window.disposeWowPanel = mountWowPanel(document.getElementById('root'), { locale: 'zh-CN' });
