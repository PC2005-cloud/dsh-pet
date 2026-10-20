/**
 * dsh-pet desktop helper —— 托盘菜单模板（纯逻辑）。
 *
 * 为什么单独抽出来：托盘菜单将来要从「只有宠物勾选」升级为应用入口（AI 设置 / 开机自启 /
 * 数据目录 / 使用说明 / 退出），而「有没有设置页 URL」「自启当前状态」这些分支必须能被单测钉住；
 * 本模块只产出**描述**（纯数据），不 require('electron')、不碰 fs / process，main.js 负责把描述
 * 变成 Electron 的 Menu。每个可交互项都带稳定的 `id` 与 `action`，后续接线按 action 找项即可，
 * 不需要再改这里的模板构造逻辑。
 *
 * 注意：打包形态下宿主角色也会复用这份模板（ticket 06），所以它必须保持零依赖。
 */

'use strict';

/** display 含 desktop/both 时宠物在桌面上可见（勾选态口径，与渲染端/宿主一致） */
function isDesktopDisplay(display) {
  return display === 'desktop' || display === 'both';
}

/**
 * 构造托盘菜单模板。
 *
 * @param {{
 *   pets?: Array<{id?: string, name?: string, display?: string}>,
 *   settingsUrl?: string,
 *   autostart?: boolean,
 * }} [input]
 *   pets: 配置里全部宠物（含 display 为 web/none 的——托盘是它们回到桌面的唯一入口）
 *   settingsUrl: 独立模式写出的 AI 设置页 URL；没有时不出该项（ticket 07）
 *   autostart: 当前系统登录项状态（ticket 09）
 * @returns {Array<Record<string, unknown>>} Electron Menu.buildFromTemplate 兼容的模板数组
 */
function buildTrayMenuTemplate(input = {}) {
  const pets = Array.isArray(input.pets) ? input.pets : [];
  /** @type {Array<Record<string, unknown>>} */
  const template = [];

  for (const pet of pets) {
    if (!pet || !pet.id) continue;
    const id = String(pet.id);
    template.push({
      id: 'pet:' + id,
      action: 'toggle-pet',
      type: 'checkbox',
      label: String(pet.name || '').trim() || id,
      checked: isDesktopDisplay(pet.display),
      // 点击时用：当前 display 决定翻转方向（both↔web、desktop↔none）
      petId: id,
      display: String(pet.display || ''),
    });
  }

  if (template.length > 0) {
    template.push({ id: 'separator-pets', action: 'separator', type: 'separator' });
  }

  const settingsUrl = String(input.settingsUrl || '').trim();
  if (settingsUrl) {
    template.push({
      id: 'settings',
      action: 'open-settings',
      label: '打开 AI 设置…',
      url: settingsUrl,
    });
  }

  template.push(
    {
      id: 'autostart',
      action: 'toggle-autostart',
      type: 'checkbox',
      label: '开机自启',
      checked: Boolean(input.autostart),
    },
    { id: 'data-dir', action: 'open-data-dir', label: '打开数据目录' },
    { id: 'help', action: 'show-help', label: '使用说明' },
    { id: 'separator-quit', action: 'separator', type: 'separator' },
    { id: 'quit', action: 'quit', label: '退出' },
  );

  return template;
}

module.exports = {
  buildTrayMenuTemplate,
  isDesktopDisplay,
};
