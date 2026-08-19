// client 半侧入口（src）：由 tsdown 构建为 lib/client.js 的 __ModuleLoader__ 单文件 bundle。
// 当前先汇集「纯逻辑层」（与 React 无关，可独立单测）。
// TODO(迁移)：把 lib/client.js 的 Pet 组件与各 hook 关注点迁到 src/client/ 其余模块，
//            并在本入口组装 window.__ModuleLoader__.load({ id, factory }) 外壳。
export * from './constants';
export * from './types';
export * from './pickers';
export * from './config';
