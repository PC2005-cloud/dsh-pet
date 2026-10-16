/**
 * `@deepseek-ai/dsh-credentials` 的独立模式替身。
 *
 * 插件只用 `credentialRef()` 构造一个交给 `ctx.credentials.resolve()` 的引用（余额接口那一条路径）。
 * 独立模式的 `ctx.credentials.resolve()` 恒返回 `undefined`（没有凭证后端），引用本身不需要任何结构，
 * 因此原样返回即可 —— 余额路由会走到「未登记接口 / 缺凭证」的明确失败分支，而不是崩掉。
 *
 * 只在独立模式构建里生效：`tsdown.config.mjs` 用 alias 把该包名指向本文件。
 */

/** 引用原样返回（独立模式不解析凭证，只保证模块图可加载） */
export function credentialRef(ref: unknown): unknown {
  return ref;
}
