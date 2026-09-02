// src/shared —— 浏览器 bundle 与桌面 shared-core（构建产物）共用的纯逻辑层。
// 约定：
//   - 只含无 React / DOM 依赖的纯函数、类型、常量、拍平逻辑；
//   - 配置的读取/合并/校验收敛在 host（src/host/config.ts 的 readAllConfig，经
//     GET /dsh-pet-7340/config 暴露成品）；本目录只负责把成品拍平成渲染列表（flattenConfigPets）；
//   - host 半侧**不得** import 本目录（DSH 单文件加载约束会拆 chunk 导致加载失败），
//     其配置实现是自包含的（见 src/host/config.ts 头部注释）；
//   - 新增「行为」请落在这里 + 两边的薄壳（浏览器 React 组件 / 桌面 DOM sprite）。
export * from './types';
export * from './constants';
export * from './pickers';
export * from './motion';
export * from './balance';
export * from './whisper';
export * from './config';
export * from './notify';
export * from './menu'; // 统一右键菜单（本目录唯一的 DOM 例外：树=纯函数，渲染=两端共用同一份）
export * from './chat'; // 对话弹窗（menu 之后第二个 DOM 例外：数据=纯函数，弹窗=两端共用同一份）
export * from './physics'; // 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹）
export * from './score'; // 点击积分（速度/大小 → 分数，纯逻辑）
export * from './score-popup'; // 点击积分弹窗 + 粒子爆发（menu/chat 之后第三个 DOM 例外：渲染=两端共用同一份）
