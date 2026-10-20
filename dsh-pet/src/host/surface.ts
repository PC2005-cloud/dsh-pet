/**
 * 「这只宠物显示在哪一端」与调用方期望的对齐（`?surface=`）——**纯逻辑层**。
 *
 * 背景（issue #122 第 1 条）：第三方插件常常只想驱动**它所在那一端**的宠物（Wallpaper 的联动
 * 演出只发生在网页里）。而 `?pet=` 只说明"哪一只"，不说明"哪一端"——一只 `display: desktop`
 * 的宠物被当成网页目标时，宿主照旧受理，但**没有任何渲染端会消费它**：调用方拿到 `ok: true`
 * 却什么都不会发生，一直等到回执超时才知道不对。
 *
 * 所以本模块只做一件事：**把"必然不可能"提前变成显式失败**（`pet-not-displayed` + 实际
 * `display` 原样回给调用方）。判定与文案都在这里，可完全离线单测。
 *
 * 三条边界（改之前先读完）：
 *
 *   1. **它是前置校验，不是按面分发**。指令照旧写进同一个叶子、两端内容照旧完全一致
 *      （README 的"两端宠物内容只可能一致"那条不变式）。要"网页播 A、桌面播 B"，用**两只宠物**
 *      表达（`display: web` / `display: desktop`），不是靠这个参数。
 *   2. **`surface` 必填**（与 `pet` 同级）：做成可选的话，忘了传的调用方照样静默不生效——那正是
 *      它要消灭的那个坑。`any` 是给"不关心显示在哪一端"的调用方一个**明说**的方式，而不是靠
 *      "不传"来暗示。
 *   3. **`display: none` 无条件拒绝**，`any` 也拒。给一只不显示的宠物下指令，哪怕用户之后把它
 *      打开也**不会补播**（页面首拉只记基线、不重放旧叶子），所以那种调用本来就是白做。
 *
 * **与 src/shared 无关**：只有宿主用得到（消费端不需要知道 surface），所以不必两边各写一份。
 */

/** 调用方期望的显示端（`?surface=` 的四个取值） */
export type Surface = 'web' | 'desktop' | 'both' | 'any';

/** 合法取值（校验与文案共用一份，避免两处各写一遍） */
export const SURFACES: readonly Surface[] = ['web', 'desktop', 'both', 'any'];

/** 缺省 / 非法时的提示（路由与 openapi 用同一句） */
export const SURFACE_TEXT = 'surface 必填：web / desktop / both / any';

/** 取值收窄：只认四个字面量（大小写、空白、非字符串一律不算），不认识返回 `null` */
export function normalizeSurface(v: unknown): Surface | null {
  return typeof v === 'string' && (SURFACES as readonly string[]).includes(v) ? (v as Surface) : null;
}

/**
 * 该宠物的 `display` 是否满足调用方的期望。
 *
 * | display ＼ want | web | desktop | both | any |
 * | --- | --- | --- | --- | --- |
 * | `web` | ✅ | ❌ | ❌ | ✅ |
 * | `desktop` | ❌ | ✅ | ❌ | ✅ |
 * | `both` | ✅ | ✅ | ✅ | ✅ |
 * | `none` | ❌ | ❌ | ❌ | ❌ |
 *
 * `display` 不是四个合法值之一时（配置校验会拦住，这里只做防御）一律视为不满足。
 */
export function displayCovers(want: Surface, display: string): boolean {
  switch (want) {
    case 'any':
      return display === 'web' || display === 'desktop' || display === 'both';
    case 'web':
      return display === 'web' || display === 'both';
    case 'desktop':
      return display === 'desktop' || display === 'both';
    case 'both':
      return display === 'both';
  }
}
