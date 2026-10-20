/**
 * 打包形态的应用托盘（ticket 06）。
 *
 * 为什么放在宿主进程：安装版没有 DSH 桌面应用，宿主是常驻进程；托盘是用户唯一的应用入口
 * （每只宠物的显示勾选 / 打开 AI 设置 / 开机自启 / 打开数据目录 / 使用说明 / 退出）。
 * 桌面壳在打包形态不再自建托盘（main.js 用 DSH_PET_PACKAGED 判断），插件形态行为不变。
 *
 * 本文件只做 Electron 接线：
 *   - 菜单模板来自 runtime/electron-helper/tray-menu.js（纯函数，ticket 01）；
 *   - 「点了之后发生什么」来自 src/host/tray-actions.ts 的构建产物 lib/tray-actions.js
 *     （纯逻辑，单测覆盖）；这里不再判断翻转方向、不再手写菜单文案。
 *
 * 数据来源与写入通道都复用现有本机 HTTP 服务（与渲染端同一套接口）：
 *   GET  /dsh-pet-7340/config      读成品聚合（顶层条目 → pets 数组）
 *   POST /dsh-pet-7340/pet-display 写回某只宠物的 display（宿主的 HTTP 服务落盘并重启壳）
 * 请求带 x-dsh-pet-token —— token 是能力令牌，不得写日志。
 */
import { createRequire } from 'node:module';

import { dispatchTrayAction, helpText, trayIconPath, trayMenuScenario } from '../lib/tray-actions.js';
// 运行时状态文件的读取/校验与宠物右键菜单（桌面壳）共用同一份实现（ticket 07）
import { petDataDir, readRuntimeSettings, resolveDshHome } from '../lib/runtime-settings.js';

const require = createRequire(import.meta.url);
const { app, dialog, Menu, nativeImage, shell, Tray } = require('electron');
const { buildTrayMenuTemplate } = require('../runtime/electron-helper/tray-menu.js');
const { trayPlatform } = require('../runtime/electron-helper/tray-platform.js');

const CONFIG_PATH = '/dsh-pet-7340/config';
const PET_DISPLAY_PATH = '/dsh-pet-7340/pet-display';
/** 配置变化（settings 页/右键菜单/其它实例）的收敛周期；点勾选后会立即强制刷新一次 */
const DEFAULT_POLL_MS = 1000;
const AUTOSTART_ARGS = ['--autostart'];

const describeError = (error) => (error instanceof Error ? error.message : String(error));

/** 只打路径与方法，绝不把能力 URL / token 写进日志 */
async function hostRequest(handle, method, path, body) {
  const headers = { 'x-dsh-pet-token': handle.token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} 失败：HTTP ${response.status}`);
  return response;
}

/**
 * 运行时文件由 startStandalone 刚写出；缺失/过期/改坏时只是不显示「打开 AI 设置…」。
 * 过期判定（pid 存活 + 端口可连）与右键菜单共用 readRuntimeSettings，避免点开空白页。
 */
async function currentSettingsUrl(home) {
  const settings = await readRuntimeSettings(home);
  return settings.available ? settings.settingsUrl : undefined;
}

/** 运行时文件不可用时的可读提示（不含 URL/token） */
async function showSettingsUnavailable(message) {
  await dialog.showMessageBox({
    type: 'warning',
    title: 'AI 设置',
    message: '暂时无法打开 AI 设置',
    detail: message,
    buttons: ['知道了'],
    noLink: true,
  });
}

function createTrayIcon(appPath) {
  const file = trayIconPath(appPath);
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    // 读不到图标 = 托盘不可见但菜单逻辑照跑，必须留下能定位的日志
    console.error(`[dsh-pet] 托盘图标缺失或不可读：${file}`);
    return image;
  }
  image = image.resize({ width: 16, height: 16 });
  if (trayPlatform(process.platform).templateImage) image.setTemplateImage(true);
  return image;
}

/** 自启状态以系统登录项为准（不另存一份配置，避免两份状态漂移） */
function readAutostart() {
  try {
    return Boolean(app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin);
  } catch (error) {
    console.warn(`[dsh-pet] 读取开机自启状态失败：${describeError(error)}`);
    return false;
  }
}

function writeAutostart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: AUTOSTART_ARGS });
}

/**
 * 创建并维护唯一的托盘图标。
 *
 * @param {{
 *   handle: { port: number, token: string, shutdown(reason?: string): Promise<void> },
 *   appPath?: string,
 *   dshHome?: string,
 *   pollMs?: number,
 * }} options
 * @returns {Promise<{ tray: import('electron').Tray, refresh: () => Promise<void>, dispose: () => void } | undefined>}
 */
export async function startAppTray(options = {}) {
  // 仅安装版存在宿主托盘；插件形态由桌面壳自建托盘（壳是唯一入口）
  if (process.env.DSH_PET_PACKAGED !== '1') return undefined;
  const handle = options.handle;
  if (!handle) throw new Error('startAppTray 需要 startStandalone 返回的 handle');

  await app.whenReady();
  const home = options.dshHome ?? resolveDshHome();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const state = {
    config: undefined,
    settingsUrl: await currentSettingsUrl(home),
    autostart: readAutostart(),
  };
  let template = [];
  let menu = null;
  let lastSignature = '';
  let disposed = false;
  let quitting = false;
  let refreshing = null;
  let timer;

  const tray = new Tray(createTrayIcon(options.appPath ?? app.getAppPath()));
  tray.setToolTip('dsh-pet 桌面宠物');
  // Windows 的 setContextMenu 只接管右键；左键要自己弹（macOS 由系统接管，Linux 的 click 不可靠）
  if (trayPlatform(process.platform).leftClickPopsMenu) tray.on('click', () => tray.popUpContextMenu());

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    try {
      tray.destroy();
    } catch {
      // 进程退出阶段销毁失败无需处理：图标随进程消失
    }
  };

  function publishTestHook() {
    // 仅测试用（Playwright app.evaluate / Node inspector 读取与触发菜单）：不经过任何 IPC，
    // 也不暴露给渲染端。electron 引用用于替换 openExternal/openPath/dialog/登录项并断言参数。
    globalThis.__dshPetTray = {
      tray,
      electron: { app, shell, dialog },
      get menu() {
        return menu;
      },
      get template() {
        return template;
      },
      get scenario() {
        return trayMenuScenario(state);
      },
      refresh: () => refresh({ force: true }),
      invoke: (id) => invoke(id),
    };
  }

  function rebuild() {
    const scenario = trayMenuScenario(state);
    template = buildTrayMenuTemplate(scenario);
    const electronTemplate = template.map((item) => {
      if (item.type === 'separator') return { id: item.id, type: 'separator' };
      return {
        id: item.id,
        label: item.label,
        type: item.type,
        checked: item.checked,
        click: () => {
          void runAction(item).catch((error) => {
            console.warn(`[dsh-pet] 托盘动作失败：${describeError(error)}`);
          });
        },
      };
    });
    menu = Menu.buildFromTemplate(electronTemplate);
    tray.setContextMenu(menu);
    publishTestHook();
  }

  /**
   * 拉配置 + 自启状态并重建菜单。
   * 非强制刷新失败（宿主刚起、壳正在重启）时保留旧菜单；强制刷新（刚点完勾选）把错误交给调用方。
   */
  async function refresh(refreshOptions = {}) {
    if (disposed) return;
    if (refreshing) {
      // 轮询已在跑：普通刷新直接复用；强制刷新（刚点完勾选）必须等它结束后再拉一次，
      // 否则可能拿到写盘前的旧配置，勾选态要等下一个轮询周期才对。
      if (!refreshOptions.force) return refreshing;
      await refreshing.catch(() => {});
      if (disposed) return;
    }
    refreshing = (async () => {
      let config;
      try {
        config = await (await hostRequest(handle, 'GET', CONFIG_PATH)).json();
      } catch (error) {
        if (refreshOptions.force) throw error;
        return;
      }
      state.config = config;
      state.autostart = readAutostart();
      // 运行时文件可能被宿主收尾删除/重写：设置项跟着出现/消失，避免留着一个点了报错的入口
      state.settingsUrl = await currentSettingsUrl(home);
      const signature = JSON.stringify(trayMenuScenario(state));
      if (!refreshOptions.force && signature === lastSignature) return;
      lastSignature = signature;
      rebuild();
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    // 先回收托盘图标，再走独立模式的正规停机：释放插件 effect → 关服务 → 删运行时文件
    dispose();
    try {
      await handle.shutdown('tray-quit');
      app.exit(0);
    } catch (error) {
      console.error(`[dsh-pet] 退出时收尾失败：${describeError(error)}`);
      app.exit(1);
    }
  }

  /** 把纯函数的副作用描述翻译成 Electron 调用 */
  async function runAction(item) {
    const effect = dispatchTrayAction(item, { autostart: state.autostart });
    switch (effect.type) {
      case 'pet-display':
        await hostRequest(handle, 'POST', PET_DISPLAY_PATH, { id: effect.id, display: effect.display });
        // 宿主在响应前已把配置落盘（随后异步重启壳）；此刻刷新勾选态
        await refresh({ force: true });
        break;
      case 'open-url': {
        // 点击时重新读一次：菜单可能是轮询前建的，运行时文件也可能刚被收尾删除/改写。
        // 过期时给可读提示并收掉菜单项，绝不打开空白页。
        const settings = await readRuntimeSettings(home);
        if (!settings.available) {
          state.settingsUrl = undefined;
          rebuild();
          await showSettingsUnavailable(settings.message);
          break;
        }
        // URL 是带一次性 token 的能力令牌：直接交给系统浏览器。失败也只打固定文案——
        // openExternal 的异常信息可能回显 URL，不能让它进日志。
        try {
          await shell.openExternal(settings.settingsUrl);
        } catch {
          console.warn('[dsh-pet] 打开 AI 设置失败（可在托盘菜单重试）');
          await showSettingsUnavailable('系统浏览器没有打开设置页。请稍后重试，或重启 DSH Pet。');
        }
        break;
      }
      case 'set-autostart':
        writeAutostart(effect.enabled);
        state.autostart = readAutostart();
        rebuild();
        break;
      case 'open-data-dir': {
        // 数据目录固定为 <DSH_HOME>/dsh-pet（不是 %APPDATA%）
        const failure = await shell.openPath(petDataDir(home));
        if (failure) console.warn(`[dsh-pet] 打开数据目录失败：${failure}`);
        break;
      }
      case 'show-help':
        await dialog.showMessageBox({
          type: 'info',
          title: '使用说明',
          message: 'DSH Pet 使用说明',
          detail: helpText(),
          buttons: ['知道了'],
          noLink: true,
        });
        break;
      case 'quit':
        await quit();
        break;
      default:
        break;
    }
    return effect;
  }

  async function invoke(id) {
    const item = template.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`托盘菜单没有 id=${id}`);
    return runAction(item);
  }

  // 先建出应用项（即使配置暂时读不到，退出入口也必须在），再补宠物项
  rebuild();
  try {
    await refresh({ force: true });
  } catch (error) {
    console.warn(`[dsh-pet] 读取宠物配置失败（托盘应用项仍可用）：${describeError(error)}`);
  }

  timer = setInterval(() => {
    void refresh().catch((error) => {
      console.warn(`[dsh-pet] 托盘菜单刷新失败：${describeError(error)}`);
    });
  }, pollMs);
  app.once('before-quit', dispose);

  return { tray, refresh: () => refresh({ force: true }), dispose };
}
