// tsdown 配置（仿官方 DSH 客户端插件的构建方式：src → 单文件 lib/client.js bundle）
// 说明：DSH 浏览器插件生产出的 lib/client.js 必须是
//       window.__ModuleLoader__.load({ id, factory }) 单文件形态，
//       react / react/jsx-runtime / @deepseek-ai/* 保持外部 require（不打包）。
// TODO（迁移阶段）：把产物整形为 __ModuleLoader__ 外壳 + 注入 CSS，再启用构建。
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "client": "src/client/index.ts",
    "index": "src/host/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "es2020",
  external: ["react", "react/jsx-runtime", /^@deepseek-ai\//],
  dts: false,
  outDir: "lib",
  clean: false,
});
