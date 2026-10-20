// client 半侧 bundle 外壳：由 tsdown 构建为 lib/client.js。
// 必须是一个「普通副作用脚本」——加载时调用 window.__ModuleLoader__.load，
// 不能包含顶层 ESM export / import（react 由 factory 的 require 取得）。
import { makeFactory } from './app';
import { petI18n } from '../shared/i18n';

declare const window: {
  __ModuleLoader__: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 全局注入的模块系统契约（f(require) => module）
    load(info: { id: string; factory: (require: (m: string) => any) => any }): void;
  };
};

// i18n（简体 / 繁体）：只转换 dsh-pet 自己的节点（class 含 dsh-pet），不碰 DSH 页面其它界面
petI18n.init({ base: '/dsh-pet-7340', scope: '[class*="dsh-pet"]' });

window.__ModuleLoader__.load({
  id: 'dsh-pet',
  factory: makeFactory(),
});
