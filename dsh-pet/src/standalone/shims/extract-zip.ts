/**
 * @electron-internal/extract-zip 的打包替身（stub）—— 仅供桌面应用打包构建（tsdown 第 4 份配置）alias 使用。
 *
 * 该包只在 `ensureElectronDownload` 解压 Electron zip 时被**动态 import**（见
 * `helper-process.ts`）；桌面应用自身即 Electron，这条路永远不该走到。打包时把
 * `import('@electron-internal/extract-zip')` alias 到这里，产物就不携带该原生模块。
 * 真被调用（不该发生）就显式报错，不静默假装成功。
 */
export default function extract(): Promise<void> {
  return Promise.reject(new Error('打包版桌面应用自身即 Electron，无需再解压 Electron'));
}
