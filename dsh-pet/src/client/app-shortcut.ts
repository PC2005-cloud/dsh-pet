/**
 * 应用级快捷键的注册壳：软取 `shortcuts` 服务、按环境档案展开默认键位、失败只丢快捷键。
 *
 * DSH 的快捷键服务在旧宿主上可能不存在，注册也可能被拒（键位不合 Web 白名单、id 或键位冲突），
 * 两种情况都只让这一条命令消失，绝不拖垮插件加载。
 * 键位一律「一条命令一个键」：不按桌面/网页给不同默认值，要换去设置里换。
 * @module dsh-pet/src/client/app-shortcut
 */

/** 一条物理键位：`primary` 在 macOS 展开成 Command，其余平台是 Control。 */
export interface ShortcutBinding {
  /** 物理键码（`KeyboardEvent.code`），如 `KeyL`。 */
  readonly code: string;
  readonly modifiers: readonly string[];
}

/** 修饰键的显示名：`primary` 按平台展开。 */
const MODIFIER_LABELS: Readonly<Record<string, string>> = {
  alt: 'Alt',
  control: 'Ctrl',
  meta: 'Cmd',
  shift: 'Shift',
};

/**
 * 把绑定转成给人看的键帽（如 `Ctrl+Shift+L`）。
 *
 * 只给菜单与设置页展示用；`primary` 在 macOS 是 Command、其余平台是 Control。
 *
 * @param binding - 已声明的绑定。
 * @returns 以 `+` 连接的键帽文案。
 */
export function keycapOf(binding: ShortcutBinding): string {
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  const modifiers = binding.modifiers.map((modifier) =>
    modifier === 'primary' ? (isMac ? 'Cmd' : 'Ctrl') : (MODIFIER_LABELS[modifier] ?? modifier),
  );
  return [...modifiers, binding.code.replace(/^Key/, '')].join('+');
}

/** 快捷键服务的最小形状（按用到的成员声明，不引整包类型）。 */
interface ShortcutsService {
  register(command: {
    readonly id: string;
    readonly label: () => string;
    readonly aliases: readonly string[];
    readonly defaults: Readonly<Record<string, unknown>>;
    readonly regions: readonly string[];
    readonly modals: readonly string[];
    resolve: (
      context: unknown,
    ) => { status: 'handled'; run(): void } | { status: 'blocked'; reason: string } | { status: 'pass' };
  }): () => void;
}

/** 注册需要的上下文（只用到软取服务）。 */
export interface ShortcutHost {
  /** Cordis 的软取：拿不到返回 undefined。 */
  get?(name: string): unknown;
}

/**
 * 给默认键位的环境档案。
 *
 * **不含 `web:linux`**：DSH 对 Web 端快捷键有白名单，Linux 只放行几个固定组合，
 * 给它配普通组合会让整条注册被拒。那个环境的用户可以在设置里自己绑。
 */
export const SHORTCUT_PROFILES = [
  'desktop:macos',
  'desktop:windows',
  'desktop:linux',
  'web:macos',
  'web:windows',
] as const;

/** 一条命令的定义：注册壳只关心这四样。 */
export interface AppShortcut {
  /** 命令 id，取 `<域>.<动作>`；重复注册会被服务拒绝。 */
  readonly id: string;
  /** 设置页里显示的标题；惰性求值，切语言后会重算。 */
  readonly label: () => string;
  readonly binding: ShortcutBinding;
  /** 触发时执行的动作。 */
  readonly run: () => void;
}

/**
 * 注册一条应用级快捷键。
 *
 * @param ctx - 客户端上下文。
 * @param shortcut - 命令定义。
 * @returns `registered` 表示是否真的登记成功；`dispose` 用于注销（失败时是空函数），
 *   拿到 `registered: false` 时调用方不能把 commandId 交给别处——指向不存在的命令会让对方注册抛错。
 */
export function registerAppShortcut(
  ctx: ShortcutHost,
  shortcut: AppShortcut,
): { registered: boolean; dispose: () => void } {
  const shortcuts = ctx.get?.('shortcuts') as ShortcutsService | undefined;
  if (shortcuts === undefined || typeof shortcuts.register !== 'function') {
    console.warn('[dsh-pet] 快捷键服务不可用，「' + shortcut.id + '」未注册');
    return { registered: false, dispose: () => {} };
  }
  try {
    const defaults = Object.fromEntries(SHORTCUT_PROFILES.map((profile) => [profile, shortcut.binding]));
    const dispose = shortcuts.register({
      id: shortcut.id,
      label: shortcut.label,
      aliases: [],
      defaults,
      // 页面级命令：输入框里打字时不抢键
      regions: ['page'],
      modals: [],
      resolve: () => ({ status: 'handled', run: shortcut.run }),
    });
    return { registered: true, dispose: () => dispose() };
  } catch (error) {
    // 注册被拒（键位不被接受 / id 冲突）：只丢这一条快捷键
    console.warn('[dsh-pet] 快捷键注册失败：' + (error instanceof Error ? error.message : String(error)));
    return { registered: false, dispose: () => {} };
  }
}
