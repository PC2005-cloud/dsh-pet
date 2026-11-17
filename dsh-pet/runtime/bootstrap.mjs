/**
 * 打包应用的主进程入口：按 DSH_PET_DPI_PROBE 在探测子进程与正式应用之间分叉。
 * 不改插件入口（package.json 的 main），也不改探测超时。
 * 不变量：探测臂绝不加载 lib/app.js。helper 使用 require / __filename，须经 createRequire 加载；
 * 应用臂保持顶层动态 import，静态 import 会在分叉前求值 lib/app.js。
 * @module dsh-pet/runtime/bootstrap
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

if (process.env.DSH_PET_DPI_PROBE === '1') {
  require('./electron-helper/main.js');
} else {
  await import('../lib/app.js');
}
