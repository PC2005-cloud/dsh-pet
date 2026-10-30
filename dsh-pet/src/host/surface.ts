/**
 * 「这只宠物显示在哪一端」的判定：`?surface=` 的对齐、可见性，以及这一句该由哪一端念。
 *
 * 负责把「必然不可能」提前变成显式失败（pet-not-displayed + 实际 display），纯逻辑、可离线单测。
 * 不负责按面分发内容：指令照旧写进同一个叶子、两端内容照旧完全一致；要两端播不同内容用两只宠物表达。
 * 依赖无；只有宿主用得到，所以不与 src/shared 各写一份。
 * 始终成立：surface 必填（any 是「不关心哪一端」的明说方式，不是省略）；`web`/`desktop`/`both`
 * 仍拒绝 `display: none`，只有 `any` 放行——对话窗口这类不看渲染结果的消费方用 `any`。
 *
 * @module dsh-pet/src/host/surface
 */

/** 调用方期望的显示端（`?surface=` 的四个取值）。 */
export type Surface = 'web' | 'desktop' | 'both' | 'any';

/** 合法取值，校验与文案共用一份。 */
export const SURFACES: readonly Surface[] = ['web', 'desktop', 'both', 'any'];

/** 缺省 / 非法时的提示文案。 */
export const SURFACE_TEXT = 'surface 必填：web / desktop / both / any';

/** 取值收窄：只认四个字面量，大小写、空白、非字符串一律不算，不认识返回 null。 */
export function normalizeSurface(v: unknown): Surface | null {
  return typeof v === 'string' && (SURFACES as readonly string[]).includes(v) ? (v as Surface) : null;
}

/**
 * 该宠物的 display 是否满足调用方的期望。
 *
 * `any` 不看显示模式（含 none）：调用方不看渲染结果。其余三值按 display 收窄；
 * 非法 display 一律不满足（配置校验会拦，这里只防御）。
 */
export function displayCovers(want: Surface, display: string): boolean {
  switch (want) {
    case 'any':
      return display === 'web' || display === 'desktop' || display === 'both' || display === 'none';
    case 'web':
      return display === 'web' || display === 'both';
    case 'desktop':
      return display === 'desktop' || display === 'both';
    case 'both':
      return display === 'both';
  }
}

/** 一次说话该由哪一端念；与 src/shared/state 的同名联合体是两份（宿主不 import src/shared），改动时两边一起改。 */
export type VoiceTarget = 'web' | 'desktop';

/**
 * 该宠物的 display 是否在任一端可见；`none` = 完全不显示。
 *
 * 只看配置，与「这一刻有没有人在看」无关——后者宿主无从得知，也不该靠猜。
 * @param display - 宠物实例的 display 取值。
 */
export function isDisplayed(display: string): boolean {
  return displayCovers('web', display) || displayCovers('desktop', display);
}

/**
 * 挑出这一句该由哪一端念：桌面优先，桌面不显示才退到网页端。
 *
 * 桌面优先是可用性判断而非偏好：桌面端只要 helper 在跑就一定有窗口，网页端随时可能被关掉，
 * 反过来会经常出现「指令发给了一端不存在的消费方」。
 * @param display - 宠物实例的 display 取值。
 * @returns 该念的一端；两端都不显示时 `null`（调用方应先用 {@link isDisplayed} 把它挡在生成之前）。
 */
export function pickVoiceSurface(display: string): VoiceTarget | null {
  if (displayCovers('desktop', display)) return 'desktop';
  if (displayCovers('web', display)) return 'web';
  return null;
}

/**
 * 把请求上的 `?surface=` 落成「该由哪一端念」。
 *
 * `web` / `desktop` 是具体的一端，原样落地；`both` 是「我哪端都在」、`any` 是「我不关心哪一端」，
 * 两者都不足以指定一端的消费方，返回 `undefined` 交回调用方按 display 推导。
 * @param want - 已由 {@link normalizeSurface} 收窄过的请求面。
 * @returns 该念的一端；无法确定时为 `undefined`。
 */
export function voiceTargetOfSurface(want: Surface): VoiceTarget | undefined {
  return want === 'web' || want === 'desktop' ? want : undefined;
}
