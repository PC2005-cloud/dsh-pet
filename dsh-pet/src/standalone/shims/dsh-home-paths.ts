/**
 * `@deepseek-ai/dsh-home-paths` 的独立模式替身。
 *
 * 插件把 DSH_HOME 的解析交给 DSH 自己的包（少一处口径漂移）；独立模式没有 DSH 提供这个包，
 * 于是这里**转调插件自己已有的同口径实现** `dshHomeDir()`（host/helper-process.ts 里已经在给
 * Electron 落地目录用它，口径 = `process.env.DSH_HOME || <USERPROFILE|HOME>/.dsh`）。
 *
 * 也就是说：替身不是第二套实现，只是把同一个函数的出口换个名字挂到 DSH 的包名上，
 * 所以独立模式与 DSH 内运行读的是同一个 DSH_HOME。
 *
 * 只在独立模式构建里生效：`tsdown.config.mjs` 用 alias 把该包名指向本文件（见那里的注释）。
 */
export { dshHomeDir as resolveDshHome } from '../../host/helper-process';
