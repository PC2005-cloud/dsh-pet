// tsdown 配置（仿官方 DSH 客户端插件的构建方式：src → lib 产物）
// 说明：DSH 浏览器插件生产出的 lib/client.js 必须是
//       window.__ModuleLoader__.load({ id, factory }) 单文件形态；
//       react / react/jsx-runtime / @deepseek-ai/* 保持外部 require（不打包）。
//
// 三份配置：
//   1) 浏览器半侧（client → lib/client.js）—— 与 DSH 内运行一致，@deepseek-ai/* 全部
//      外部化（那些包由 DSH 宿主提供）；产物额外包一层 IIFE，理由见该份配置里的注释。
//   2) 宿主半侧（index → lib/index.js）—— 保持 ESM，由 DSH 的 Loader import。
//   3) 独立模式入口（standalone → lib/standalone.js）—— 它要跑在**没有 DSH** 的环境里
//      （插件装进 profile 后直接 `node node_modules/dsh-pet/lib/standalone.js`），
//      而宿主半边的模块图静态 import 了三个只在 DSH 里存在的包，那里解析不到。
//      因此用 alias 把它们换成本地替身（src/standalone/shims/*）：替身只做
//      "转调插件自己的同口径实现" 或 "明确降级"，没有任何生成/网络逻辑（细节见各文件头）。
//      其余 @deepseek-ai/* 仍按外部处理（负向断言），避免哪天误把 DSH 代码打进产物。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/** 本配置文件所在目录（= 包根） */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));

/** 替换包名用的绝对路径（rolldown 的 alias 收绝对路径最稳） */
const shim = (name) => join(packageRoot, 'src', 'standalone', 'shims', `${name}.ts`);

/** 两份配置共用的编译口径 */
const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'es2020',
  dts: false,
  outDir: 'lib',
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    entry: {
      client: 'src/client/index.ts',
    },
    external: [/^@deepseek-ai\//, /^@electron\//, /^node:/],
    // 浏览器半侧必须能被**重复执行**：DSH 把 lib/client.js 当经典脚本加载，而 bundle
    // 重建后（HMR 换 rev）或 combo 请求重试时，同一个文件会在同一页面里再执行一次。
    // 经典脚本的顶层 const/let/function 落在页面的全局词法作用域，第二次解析直接
    // SyntaxError（Identifier 'PET_DISPLAYS' has already been declared），entry 激活
    // 失败 → 桌宠 overlay 与设置页插槽都不注册，只能刷新才恢复。因此整份产物包一层
    // IIFE，让所有模块体声明留在函数作用域内；前导 ';' 抵消 combo 拼接（多个插件
    // bundle 连成一个脚本）时的 ASI 歧义。
    outputOptions: { banner: ';(()=>{', footer: '})();' },
  },
  {
    ...shared,
    // 宿主半侧保持 ESM（由 DSH 的 Loader import），绝不能包 IIFE。
    entry: {
      index: 'src/host/index.ts',
    },
    external: [/^@deepseek-ai\//, /^@electron\//, /^node:/],
  },
  {
    ...shared,
    // 独立模式只在 Node ≥ 22.12 上运行（package.json 的 engines 已声明），因此目标可以是 es2022：
    // es2020 目标会把 class field 一类语法降级成 `_defineProperty(...)`，进而把
    // `@oxc-project/runtime` 拖成一条裸 import —— 那个包不在本包依赖里，装好的用户跑起来会
    // ERR_MODULE_NOT_FOUND。提到 es2022 后这类降级辅助整体消失（与插件本体的 es2020 产物无关，
    // 两者是不同的入口，DSH 侧仍按 es2020 发布）。
    target: 'es2022',
    entry: {
      standalone: 'src/standalone/cli.ts',
    },
    // tsdown 默认把 dependencies/peerDependencies 全部外部化（本包那三个 DSH 专有包正是
    // peerDependencies），所以这里必须先 noExternal 把它们拉回打包图，下面的 alias 才轮得到生效；
    // 否则产物里留下裸 import，在没有 DSH 的环境里 ERR_MODULE_NOT_FOUND。
    noExternal: [/^@deepseek-ai\/(?:dsh-home-paths|dsh-credentials|dsh-llm)$/],
    // 除三个替身外，其余 @deepseek-ai/* 仍视为宿主提供（负向断言）
    external: [/^@electron\//, /^node:/, /^@deepseek-ai\/(?!dsh-home-paths$|dsh-credentials$|dsh-llm$)/],
    alias: {
      '@deepseek-ai/dsh-home-paths': shim('dsh-home-paths'),
      '@deepseek-ai/dsh-credentials': shim('dsh-credentials'),
      '@deepseek-ai/dsh-llm': shim('dsh-llm'),
    },
  },
]);
