/**
 * 将共用魔兽工具面板接入 DSH 设置插槽。
 * React 运行时由宿主注入；表单内容和认证 API 由 shared/wow-panel 管理。
 * 卸载时取消全部面板请求与轮询。
 * @module dsh-pet/src/client/wow-settings
 */
import { mountWowPanel } from '../shared/wow-panel/mount.ts';
import { WOW_PANEL_CSS } from '../shared/wow-panel/style.ts';
import type { SettingsRuntime } from './settings/runtime.ts';

/** 创建 DSH 设置分区组件。 */
export function makeWowSettings(rt: Pick<SettingsRuntime, 'h' | 'useEffect' | 'useRef'>) {
  return function WowSettings() {
    const host = rt.useRef<HTMLDivElement | null>(null);
    rt.useEffect(() => {
      if (!document.querySelector('style[data-wow-panel-css]')) {
        const style = document.createElement('style');
        style.dataset.wowPanelCss = '';
        style.textContent = WOW_PANEL_CSS;
        document.head.append(style);
      }
      return host.current ? mountWowPanel(host.current) : undefined;
    }, []);
    return rt.h('div', { ref: host });
  };
}
