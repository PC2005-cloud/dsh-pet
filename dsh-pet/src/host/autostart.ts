/**
 * 开机自启（ticket 09）—— 宿主侧纯逻辑，零 Electron 依赖。
 *
 * 三个职责分开，方便单测与替换系统实现：
 *   1. 登录项适配层：把 Electron 的 `app.get/setLoginItemSettings` 包成两个方法
 *      （isEnabled / setEnabled），参数恒带 `--autostart`；
 *   2. 默认开启：首次以宿主角色启动时写一次系统登录项，并在 `<DSH_HOME>/dsh-pet/`
 *      留下 `autostart-initialized` 标记 —— 用户之后在托盘里关掉，后续启动不得写回；
 *   3. 自启延迟参数：`DSH_PET_AUTOSTART_DELAY_MS` 可覆盖，默认 4000ms。
 *
 * 为什么状态不另存配置：托盘勾选直接读系统登录项（HKCU Run），避免「配置文件说开、
 * 系统启动项说关」两份状态漂移。标记文件只记录「默认值是否已经应用过」，不是开关状态。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { petDataDir, resolveDshHome } from './runtime-settings';

/** 自启启动时携带的唯一参数：宿主据此延迟启动、不抢焦点 */
export const AUTOSTART_ARGS: readonly string[] = ['--autostart'];

/** 默认延迟：登录后约 4 秒再起服务，避开登录瞬间的程序启动高峰 */
export const DEFAULT_AUTOSTART_DELAY_MS = 4000;

/** 覆盖延迟的环境变量（测试/手动验证用 0 或 100） */
export const AUTOSTART_DELAY_ENV = 'DSH_PET_AUTOSTART_DELAY_MS';

/** 「默认开启」只应用一次的标记文件名（与配置、素材同目录） */
export const AUTOSTART_MARKER_FILENAME = 'autostart-initialized';

/** Electron 登录项 API 的最小子集（真实实现由主进程传入 app） */
export interface LoginItemLaunchItem {
  name?: string;
  path?: string;
  /** 任务管理器「启动」页的启用态；用户在那里禁用后为 false */
  enabled?: boolean;
}

export interface LoginItemSettings {
  openAtLogin: boolean;
  /** Electron 43 起返回的启动项明细（可缺省，兼容更老版本/其它平台） */
  launchItems?: LoginItemLaunchItem[];
}

export interface LoginItemApi {
  getLoginItemSettings(options?: { args: string[] }): LoginItemSettings;
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[]; enabled?: boolean }): void;
}

/** 宿主/托盘只依赖这两个动作，测试可完全替换系统 */
export interface LoginItemAdapter {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

/**
 * 把 Electron 的登录项 API 包成适配层。
 *
 * 关键细节（Electron 43.3.0 实测）：
 *   - 读写都必须带同一组 `args`（`['--autostart']`），否则 `openAtLogin` 比对不上；
 *   - 不能用 `name` 选项：`setLoginItemSettings` 认它，但 `getLoginItemSettings` 仍按默认
 *     值名（`electron.app.<app name>`）判断，勾选态会永远显示未开启；
 *   - `openAtLogin` 只反映 HKCU Run 是否存在，**不看**任务管理器写入 StartupApproved 的
 *     禁用态；真实状态要看 `launchItems[].enabled`；
 *   - 开启时显式传 `enabled: true`，把用户在任务管理器里的禁用态一并解除。
 */
export function createLoginItemAdapter(api: LoginItemApi): LoginItemAdapter {
  return {
    isEnabled(): boolean {
      const settings = api.getLoginItemSettings({ args: [...AUTOSTART_ARGS] });
      if (!settings.openAtLogin) return false;
      const items = settings.launchItems;
      // 没有明细（老版本 Electron/非 Windows）时退回 openAtLogin
      if (!Array.isArray(items) || items.length === 0) return true;
      // 同一 exe 理论上只有我们这一个启动项；只要有一项启用，登录时就会启动
      return items.some((item) => item.enabled !== false);
    },
    setEnabled(enabled: boolean): void {
      api.setLoginItemSettings({
        openAtLogin: enabled,
        args: [...AUTOSTART_ARGS],
        // Electron 只在 openAtLogin=true 时应用 enabled；关闭时整条 Run 值会被删除
        ...(enabled ? { enabled: true } : {}),
      });
    },
  };
}

/**
 * 解析自启启动延迟（ms）：未设置 → 4000；合法非负数 → 取整；非法值 → 回落 4000。
 * 负延迟没有语义，宁可回到默认值也不要把启动时序变成「不确定」。
 */
export function resolveAutostartDelayMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[AUTOSTART_DELAY_ENV];
  if (raw === undefined) return DEFAULT_AUTOSTART_DELAY_MS;
  if (raw.trim() === '') return DEFAULT_AUTOSTART_DELAY_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_AUTOSTART_DELAY_MS;
  return Math.round(value);
}

/** 标记文件路径：`<DSH_HOME>/dsh-pet/autostart-initialized` */
export function autostartMarkerPath(home: string): string {
  return join(petDataDir(home), AUTOSTART_MARKER_FILENAME);
}

/** 默认 DSH 主目录下的标记路径（主进程用；env 可注入便于测试） */
export function defaultAutostartMarkerPath(env: Record<string, string | undefined> = process.env): string {
  return autostartMarkerPath(resolveDshHome(env));
}

/** 标记文件的读写接缝（测试用内存实现替换） */
export interface AutostartMarker {
  exists(): boolean;
  /** 写入标记；已存在时抛 EEXIST（write-once，不覆盖） */
  create(): void;
}

/** 真实标记文件：自动创建父目录，`wx` 保证只写一次 */
export function createFileMarker(file: string): AutostartMarker {
  return {
    exists: () => existsSync(file),
    create: () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${new Date().toISOString()}\n`, { encoding: 'utf8', flag: 'wx' });
    },
  };
}

export type AutostartInitOutcome = 'already-initialized' | 'enabled' | 'already-enabled';

/**
 * 首次启动初始化：标记不存在时确保系统登录项开启，然后写标记。
 *
 * - 标记存在：什么都不做（用户可能已经主动关掉自启，绝不能写回）；
 * - 系统已开启（用户手动加过启动项）：不重写，只补标记；
 * - 写系统失败：不写标记并向上抛——下次启动还能重试，不会永久丢掉默认开启。
 */
export function initializeAutostartOnce(options: {
  loginItem: LoginItemAdapter;
  marker: AutostartMarker;
}): AutostartInitOutcome {
  if (options.marker.exists()) return 'already-initialized';
  const alreadyEnabled = options.loginItem.isEnabled();
  if (!alreadyEnabled) options.loginItem.setEnabled(true);
  options.marker.create();
  return alreadyEnabled ? 'already-enabled' : 'enabled';
}
