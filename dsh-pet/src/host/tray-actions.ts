/**
 * 应用托盘的动作分发（ticket 06）。
 *
 * 托盘菜单模板（runtime/electron-helper/tray-menu.js）是零依赖的纯数据；本模块把「用户点了哪一项」
 * 翻译成**副作用描述**（打开 URL / 提交 pet-display / 设置自启 / 退出…），真正的 Electron 调用
 * 在桌面入口 desktop/tray.mjs。这样翻转规则、缺字段时不发请求等行为可以在 node:test 里钉住，
 * 不需要启动 Electron，也不需要给系统托盘写自动化。
 */
import { join } from 'node:path';

/** 托盘菜单项的稳定形状（模板里每项都带 id/action，宠物项另带 petId/display） */
export interface TrayActionItem {
  action?: unknown;
  petId?: unknown;
  display?: unknown;
  url?: unknown;
}

/** 点击时需要的应用状态（自启状态以系统登录项为准，不另存配置） */
export interface TrayActionState {
  autostart?: boolean;
}

/** 托盘只需要的宠物字段（与壳的 startTray 同一口径） */
export interface TrayMenuPet {
  id: string;
  name: string;
  display: string;
}

/** 交给 buildTrayMenuTemplate 的输入 */
export interface TrayMenuScenario {
  pets: TrayMenuPet[];
  settingsUrl?: string;
  autostart: boolean;
}

/**
 * 拍平 `GET /dsh-pet-7340/config` 的成品聚合：顶层键是配置条目（不是宠物），
 * 宠物在各条目的 `pets` 数组里，规则与渲染端 `flattenConfigPets`、壳的 `startTray` 相同。
 * 把条目本身当宠物读会让 name/display 恒为空、勾选永远不中——壳里已经踩过这个坑。
 */
export function flattenConfigPets(config: unknown): TrayMenuPet[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const pets: TrayMenuPet[] = [];
  for (const entry of Object.values(config as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const list = (entry as { pets?: unknown }).pets;
    if (!Array.isArray(list)) continue;
    for (const pet of list) {
      if (!pet || typeof pet !== 'object') continue;
      const fields = pet as { id?: unknown; name?: unknown; display?: unknown };
      const id = typeof fields.id === 'string' ? fields.id.trim() : '';
      if (!id) continue;
      pets.push({
        id,
        name: typeof fields.name === 'string' ? fields.name.trim() : '',
        display: typeof fields.display === 'string' ? fields.display : '',
      });
    }
  }
  return pets;
}

/** 配置 + 运行时能力 → 模板输入；settingsUrl 缺失/空白时不显示「打开 AI 设置…」 */
export function trayMenuScenario(input: {
  config?: unknown;
  settingsUrl?: string;
  autostart?: boolean;
}): TrayMenuScenario {
  const settingsUrl = String(input.settingsUrl ?? '').trim();
  return {
    pets: flattenConfigPets(input.config),
    ...(settingsUrl ? { settingsUrl } : {}),
    autostart: Boolean(input.autostart),
  };
}

export type TrayEffect =
  | { type: 'pet-display'; id: string; display: string }
  | { type: 'open-url'; url: string }
  | { type: 'set-autostart'; enabled: boolean }
  | { type: 'open-data-dir' }
  | { type: 'show-help' }
  | { type: 'quit' }
  | { type: 'noop'; action: string };

/** 托盘图标来自应用根（打包后是 asar 根），不是宿主 bundle 所在目录 */
export function trayIconPath(appPath: string): string {
  return join(appPath, 'assets', 'logo.png');
}

// 运行时状态文件（settingsUrl / pid / port）的读取与过期判定住在 runtime-settings.ts：
// 托盘与宠物右键菜单（桌面壳）必须走同一份校验，不允许各自再实现一遍。本模块只保留
// 「托盘菜单/动作」相关的纯逻辑。

/** 「使用说明」的正文：不依赖日志也能知道入口与安装版的限制 */
export function helpText(): string {
  return [
    'DSH Pet 使用说明',
    '',
    '• 右键宠物：打开动作菜单（打开网站 / 查看余额 / 碎碎念 / 对话 / 回到初始位置 / 显示位置 / 重载配置）。',
    '• 托盘图标：勾选每只宠物是否显示在桌面，也可以打开 AI 设置与数据目录。',
    '• 退出：在托盘菜单里选择「退出」。会先停止桌面宠物、释放本机服务并清理运行时状态，再退出进程。',
    '• 安装版暂不可用：余额查询、DSH 会话工作状态、系统通知。',
  ].join('\n');
}

/**
 * 翻转「桌面位」：both↔web、desktop↔none——浏览器位保持不动，因此不制造新的单向门。
 * 与桌面壳 runtime/electron-helper/main.js 的 toggleDisplay 同一口径（插件形态仍由壳处理）。
 */
export function nextPetDisplay(display: string): string {
  return display === 'both' ? 'web' : display === 'web' ? 'both' : display === 'desktop' ? 'none' : 'desktop';
}

/** 模板项 + 当前状态 → 副作用描述；未知/分隔项一律 noop，绝不让点击把托盘打崩 */
export function dispatchTrayAction(item: TrayActionItem, state: TrayActionState = {}): TrayEffect {
  const action = typeof item?.action === 'string' ? item.action : '';
  switch (action) {
    case 'toggle-pet': {
      const id = typeof item.petId === 'string' ? item.petId.trim() : '';
      // 空 id 提交给宿主只会得到 pet-required 业务错误；这里直接不发请求
      if (!id) return { type: 'noop', action };
      return { type: 'pet-display', id, display: nextPetDisplay(String(item.display ?? '')) };
    }
    case 'open-settings': {
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      // settingsUrl 是带一次性 token 的能力 URL：空值说明运行时文件没读到，不显示也不打开
      if (!url) return { type: 'noop', action };
      return { type: 'open-url', url };
    }
    case 'toggle-autostart':
      // 以当前系统登录项状态为准翻转，而不是信菜单里可能过期的勾选态
      return { type: 'set-autostart', enabled: !state.autostart };
    case 'open-data-dir':
      return { type: 'open-data-dir' };
    case 'show-help':
      return { type: 'show-help' };
    case 'quit':
      return { type: 'quit' };
    default:
      return { type: 'noop', action };
  }
}
