/**
 * @electron/get 的打包替身（stub）—— 仅供桌面应用打包构建（tsdown 第 4 份配置）alias 使用。
 *
 * 打包成桌面应用后，应用自身就是一个完整的 Electron 运行时（bootstrap.js 直接跑在
 * Electron 主进程里），宿主半边 `helper-process.ts` 里的 `ensureElectronDownload`
 * （"找不到 Electron 就下载一个"）这条路永远不该走到。该文件静态 import 了
 * `downloadArtifact` —— 打包时把它 alias 到这里，产物里就不出现对 @electron/get 的
 * 裸引用（那个包不随应用分发，留引用会在运行时 ERR_MODULE_NOT_FOUND）。
 * 真被调用（不该发生）就显式报错，不静默假装成功。
 */
export function downloadArtifact(): Promise<string> {
  return Promise.reject(new Error('打包版桌面应用自身即 Electron，无需再下载 Electron'));
}
