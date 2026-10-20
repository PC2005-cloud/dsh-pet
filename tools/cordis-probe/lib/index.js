/**
 * dsh-cordis-probe 的宿主半侧 —— 故意什么都不做。
 *
 * ## 为什么必须存在
 *
 * profile 的 `cordis.patch.yml` 里一条 entry 写的是 `name: dsh-cordis-probe`，
 * DSH 的 Loader 会 import 这个包的**入口**（package.json 的 `main`）并把它的导出
 * 当成 Cordis 插件加载。包如果只有浏览器半侧（`exports['./client']`），入口解析
 * 直接失败，整条 entry 加载不起来，浏览器半侧自然也不会被提供给页面。
 *
 * 所以这里放一个空插件：加载成功、什么也不注册、也不报错。真正的内容全在
 * `lib/client.js` 里。
 *
 * @module dsh-cordis-probe
 */

/** Cordis 插件名（诊断与日志里显示）。 */
export const name = 'cordis-probe';

/**
 * 空插件体。
 *
 * 不声明 inject，不注册任何服务或事件；`() => {}` 的形式让 Loader 明确知道
 * 这是一个「加载成功且无需清理」的插件。
 */
export function apply() {}
