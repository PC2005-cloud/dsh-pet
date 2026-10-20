/**
 * 右键菜单「桌宠配置」—— 打开 DSH 设置面板并直接定位到本插件的「桌宠配置」分区。
 *
 * ## 为什么需要它
 *
 * DSH 没有给第三方插件「打开设置并跳到某分区」的公开接口；设置面板的开关状态由
 * `dsh-client-ui-settings-general` 自己持有。本模块按**能力探测 + 逐级降级**去够它：
 *
 *   1. **首选：设置壳 store 的 `openSection(id)`**。settings-general 注册 `sidebar.settings`
 *      条目时把壳 store 放进了 `store` 座位（单例：`create()` 恒返回同一个实例），
 *      `ctx.slots.entries('sidebar.settings')` 能读到这条注册 → `store.create().actions.openSection('pet-config')`
 *      一步到位：打开面板 + 选中分区（与面板内点导航行完全同一个 action）。
 *      依据：settings-general lib/client.js 的 `createSettingsShellStore`（open / close / select / openSection）
 *      与 `ctx.slots.register({ name: 'sidebar.settings', store: shellStore, ... })`，
 *      0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.1-rc.2 三个版本形态一致。
 *   2. **降级：快捷键命令 `settings.open`**（就是 Ctrl+, 那条）。经 `ctx.shortcuts.registry.invoke`
 *      以「菜单来源」触发——只能打开面板，不能选分区；打开后再在 DOM 上点一下「桌宠配置」导航行。
 *   3. 两条都够不着 → 只告警，绝不抛错（菜单项点了没反应，但宠物与 DSH 页面都不受影响）。
 *
 * 这些都**不是 DSH 的公开契约**：将来 DSH 提供正式的「打开设置分区」接口后，替换 `openViaStore`
 * 与 `openViaShortcut` 即可，调用方（pet.ts 菜单、宿主信号）不用动。
 *
 * ## 为什么是模块级注册而不是 props 透传
 *
 * 宠物页面组件（pet.ts 的 makePetUI）只拿到 h / useState 等 React 原语，不持有 ctx；
 * 这里与 settings.ts 的 petBridge 同一个做法：app.ts 在 apply 时 `installSettingsOpener(ctx)`，
 * 页面侧只调 `openPetSettings()`。
 */

/** 本插件在设置面板里注册的分区 id（app.ts 的 `settings.section` 注册，与之必须一致） */
export const PET_SETTINGS_SECTION_ID = 'pet-config';

/** 设置面板根节点（settings-general 用 createPortal 挂到 body，带这个属性） */
const PANEL_SELECTOR = '[data-shortcut-modal="settings"]';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx 无静态类型
type AnyCtx = any;

let currentCtx: AnyCtx | undefined;
/** 「桌宠配置」导航行的标题（随语言变：桌宠配置 / Pet Config），DOM 降级时用来认行 */
let navLabel: () => string = () => '';

/** app.ts 的 apply 里调用；返回卸载函数（插件卸载时清空引用，避免持有已失效的 ctx） */
export function installSettingsOpener(ctx: AnyCtx, label: () => string): () => void {
  currentCtx = ctx;
  navLabel = label;
  return () => {
    if (currentCtx === ctx) {
      currentCtx = undefined;
      navLabel = () => '';
    }
  };
}

/** 1. 设置壳 store：openSection(id) = 打开 + 选中分区 */
function openViaStore(ctx: AnyCtx): boolean {
  try {
    const entries = ctx?.slots?.entries?.('sidebar.settings');
    if (!Array.isArray(entries)) return false;
    for (const entry of entries) {
      const instance = entry?.store?.create?.();
      const openSection = instance?.actions?.openSection;
      if (typeof openSection === 'function') {
        openSection(PET_SETTINGS_SECTION_ID);
        return true;
      }
    }
  } catch (e) {
    console.warn('[dsh-pet] 设置壳 store 不可用，改走快捷键命令', e);
  }
  return false;
}

/** 2. 快捷键命令 settings.open（只能打开面板，分区靠 DOM 补一下） */
function openViaShortcut(ctx: AnyCtx): boolean {
  try {
    const registry = ctx?.get?.('shortcuts')?.registry ?? ctx?.shortcuts?.registry;
    if (!registry || typeof registry.invoke !== 'function') return false;
    // 面板已开着时 settings.open 的语义是「关掉」——那就不必再触发，直接去选分区
    if (!document.querySelector(PANEL_SELECTOR)) {
      registry.invoke('settings.open', { region: 'page', modal: null, target: null });
    }
    selectNavRowSoon();
    return true;
  } catch (e) {
    console.warn('[dsh-pet] 快捷键命令 settings.open 触发失败', e);
    return false;
  }
}

/** 面板是异步挂载的：轮询几帧，找到「桌宠配置」导航行就点它（找不到就算了，面板已经开了） */
function selectNavRowSoon(): void {
  const label = navLabel();
  if (!label) return;
  let tries = 0;
  const tick = (): void => {
    const panel = document.querySelector(PANEL_SELECTOR);
    if (panel) {
      for (const btn of Array.from(panel.querySelectorAll('button'))) {
        if ((btn.textContent ?? '').trim() === label) {
          (btn as HTMLButtonElement).click();
          return;
        }
      }
    }
    if (++tries < 20) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}

/**
 * 打开设置面板并定位到「桌宠配置」。
 * @returns 是否成功发起（false = 当前 DSH 版本两条路都够不着，已告警）
 */
export function openPetSettings(): boolean {
  const ctx = currentCtx;
  if (ctx === undefined) {
    console.warn('[dsh-pet] 打开设置失败：插件尚未装配完成');
    return false;
  }
  if (openViaStore(ctx)) return true;
  if (openViaShortcut(ctx)) return true;
  console.warn('[dsh-pet] 当前 DSH 版本不支持从插件打开设置面板（请用 Ctrl+, 打开设置 →「桌宠配置」）');
  return false;
}

/** 宿主 `sections.openSettings` 信号的「新鲜度」窗口：首拉时只认这么久以内发出的请求 */
export const OPEN_SETTINGS_FRESH_MS = 15_000;

/** 读宿主信号叶子 data：`{ at: number }`（宿主写入时刻，ms） */
export function readOpenSettingsAt(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const at = (data as { at?: unknown }).at;
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}
