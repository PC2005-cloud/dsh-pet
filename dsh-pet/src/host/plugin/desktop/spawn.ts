/**
 * Helper 进程的拉起与停止：定位 Electron、注入环境、退避重试与熔断。
 *
 * 不算宠物列表（归 ./pets），不决定何时重启（归 ./sync 的调用方）。
 * 依赖显式传入（见输入类型），模块内只读两个进程级环境事实：`DSH_PET_IN_PROCESS` 与 `process.versions.electron`。
 * @module dsh-pet/src/host/plugin/desktop/spawn
 */
import { join } from 'node:path';
import { ROUTE_SEGMENT } from '../../../shared/constants.ts';
import { PACKAGE_ROOT } from '../../paths.ts';
import type { DesktopHelperDeps } from './types.ts';
import type { DesktopPets } from './pets.ts';
import { toBridgeResponse } from './bridge-response.ts';
import {
  HelperProcess,
  defaultElectronExe,
  dshHomeDir,
  ensureElectronDownload,
  hasGraphicalDisplay,
  resolveElectronPath,
} from '../../helper-process.ts';

/** DesktopSpawn的输入。 */
export type DesktopSpawnInput = Pick<
  DesktopHelperDeps,
  'ctx' | 'getHandlePetRoute' | 'log' | 'reportDownload' | 'thumbUserRoot'
> &
  Pick<DesktopPets, 'getHasDesktopPet' | 'desktopPetList' | 'getTrayOn'>;

/** 宿主是不是 DSH 桌面应用（Electron 宿主）。 */
const isDesktopHost = (): boolean => Boolean(process.versions.electron);

/** 菜单首项去向：desktop 唤起桌面应用，standalone 打开本机 AI 设置页，web 打开 DSH 站点。 */
export type OpenTarget = 'desktop' | 'standalone' | 'web';

/**
 * 由宿主形态与已鉴权地址判定菜单首项去向。
 *
 * 独立模式与 web 宿主都不在 Electron 里，只能靠地址形状区分：独立模式的已鉴权地址固定落在本机
 * 设置页，web 宿主指向站点根。判错会让菜单文案与实际打开的目标对不上。
 * @param siteUrl - 交给浏览器的已鉴权地址（独立模式含本机设置页路径）。
 * @param desktopHost - 宿主是否为 DSH 桌面应用。
 * @returns 注入给 Helper 的形态值。
 */
export function resolveOpenTarget(siteUrl: string, desktopHost: boolean): OpenTarget {
  if (desktopHost) return 'desktop';
  return siteUrl.includes('/standalone-ai/') ? 'standalone' : 'web';
}

/**
 * 创建 Helper 进程的拉起与停止句柄：进程内宿主直接跳过，其余按需下载 Electron 后 spawn 并退避重试。
 */
export function createDesktopSpawn(deps: DesktopSpawnInput) {
  const { ctx, getHandlePetRoute, log, reportDownload, thumbUserRoot, getHasDesktopPet, desktopPetList, getTrayOn } =
    deps;

  let desktopModeEverActive = false;

  let helper: HelperProcess | undefined;

  let startRetryTimer: NodeJS.Timeout | undefined;

  let electronEnsure: Promise<void> | undefined;

  let disposed = false;

  let displayWarned = false;

  let noDesktopSkipped = false;

  let portWaitAttempts = 0;

  const inProcessHost = process.env.DSH_PET_IN_PROCESS === '1';

  const launchHelper = (electronPath: string | undefined): void => {
    if (inProcessHost) return; // 应用模式：窗口由本进程建，绝不 spawn
    if (helper || disposed) return;
    // 无桌面宠物时：只有「桌面模式曾启用过且托盘还开着」才值得为托盘常驻，否则不启动
    if (!getHasDesktopPet() && !(desktopModeEverActive && getTrayOn())) return;
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    if (!port || port <= 0) {
      // webServer 可能尚未完成监听（OS 分配端口时 port 短暂为 0）：延迟重试。
      // 诊断日志（issue #168）：这条重试以前完全静默——端口长期不就绪时，桌面宠物
      // 「连尝试都没有」且没有任何线索。这里只加可见性，重试节奏与次数保持原样。
      portWaitAttempts += 1;
      if (portWaitAttempts === 1) {
        log.info(`[dsh-pet] webServer 端口尚未就绪（port=${String(port)}），每 500ms 重试拉起桌面 Helper`);
      } else if (portWaitAttempts % 20 === 0) {
        log.warn(
          `[dsh-pet] 已等待 webServer 端口 ${(portWaitAttempts * 500) / 1000}s 仍未就绪` +
            `（port=${String(port)}），桌面 Helper 尚未拉起`,
        );
      }
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = undefined;
          launchHelper(electronPath);
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    portWaitAttempts = 0;
    const origin = `http://127.0.0.1:${port}`;
    // 右键「打开网站」交出去的是裸 origin：DSH 只在 `GET /` 接受本进程的启动令牌，换发绑定 authority
    // 的签名 Cookie，其余请求一律 401（默认浏览器没有该 authority 的 Cookie 时必然打不开）。
    // 令牌等价登录态：只经子进程环境变量递到 helper 内存，不落盘、不进日志；authority 必须保持
    // 127.0.0.1（与 localhost 算两套 Cookie），故传 origin 而不是另拼地址。
    const siteUrl = ctx.connection.authenticatedUrl(origin);
    // 桌面渲染端也从同一份 handlePetRoute 拿成品配置（每只宠物一个局部小窗口；经管道，不走 HTTP——
    // DSH Desktop 2.0.3+ 会拦插件自拉进程的裸 HTTP 请求，浏览器访问闸门只放行带令牌的请求）
    const configUrl = `${origin}${ROUTE_SEGMENT}/config`;
    helper = new HelperProcess(
      {
        electronPath,
        env: {
          DSH_PET_CONFIG_URL: configUrl,
          // 已鉴权站点 URL（含本进程启动令牌）：只供 helper 的「打开」首项使用，任何日志都不许出现它
          DSH_PET_SITE_URL: siteUrl,
          // 宿主形态决定菜单首项的去向与文案（同名「打开」项，三种形态三种语义）：
          //   desktop    = DSH 桌面应用 → 唤起应用主窗口（helper 走 dsh://open）
          //   standalone = 独立模式 → 本机 AI 设置页
          //   web        = dsh web → DSH 站点
          DSH_PET_OPEN_TARGET: resolveOpenTarget(siteUrl, isDesktopHost()),
          DSH_PET_SCALE: '1',
          // 打开 bridge 协议：main.js 注册 dsh-pet-bridge scheme，把渲染端请求经管道转给宿主
          DSH_PET_BRIDGE: '1',
          // 每只桌面宠物一个局部小窗口：透传宠物列表（[{id,size}]）
          DSH_PET_PETS: JSON.stringify(desktopPetList()),
        },
        // bridge 协议处理器 = HTTP 路由同一份 handlePetRoute（业务逻辑唯一，两端天然一致）；
        // 形状转换在 ./bridge-response，本模块只管把请求转进去。
        bridgeHandler: async (req) => {
          const result = await getHandlePetRoute()(req.url ?? '/', req.method ?? 'GET', req.body);
          return toBridgeResponse(req.id, result);
        },
      },
      log,
    );
    try {
      helper.start();
      desktopModeEverActive = true; // 此后即使桌面宠物清零也保留 Helper：托盘常驻，可随时切回来
      log.info(`dsh-pet desktop helper started (config: ${configUrl})`);
    } catch (e) {
      log.warn(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
      helper = undefined;
    }
  };

  const startHelper = (): void => {
    if (inProcessHost) return; // 应用模式：不探测、不下载 Electron
    if (helper || electronEnsure || disposed) return;
    if (!getHasDesktopPet() && !(desktopModeEverActive && getTrayOn())) {
      // 诊断日志（issue #168）：这条短路不打日志，就是「桌面模式凭空消失：无进程、无目录、无提示」
      // 的直接成因。用 info 而非 warn——纯网页用户这是正常状态；只打一次避免刷屏。
      // 托盘关掉后这里也会命中：没人需要那个图标，空常驻没有意义。
      if (!noDesktopSkipped) {
        noDesktopSkipped = true;
        log.info(
          `[dsh-pet] 无桌面宠物（display 均为 web/none）且无需保留托盘（tray=${getTrayOn()}），已跳过桌面 Helper 启动`,
        );
      }
      return;
    }
    // 无图形显示环境（Linux 服务器 / 容器）：直接放弃，不探测、不下载、不拉起。
    // 否则 Electron 会「拉起即崩」，被守护循环反复重启并刷满 core dump。
    if (!hasGraphicalDisplay()) {
      if (!displayWarned) {
        displayWarned = true;
        log.warn(
          '[dsh-pet] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。' +
            '浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_PET_DESKTOP_FORCE=1。',
        );
      }
      return;
    }
    const found = resolveElectronPath();
    if (found) {
      launchHelper(found);
      return;
    }
    // 诊断日志（issue #168）：只报「没找到」不够用——最常见的情形是「文件明明存在」，
    // 但不在实际查询的路径上（DSH_HOME 不一致）。把真正查的路径一起打出来。
    log.warn(
      `[dsh-pet] 未找到 Electron 可执行文件：DSH_HOME=${dshHomeDir()}，查找路径=${defaultElectronExe()}` +
        `，DSH_PET_ELECTRON_PATH=${process.env.DSH_PET_ELECTRON_PATH ?? '(未设置)'}`,
    );
    log.warn(`[dsh-pet] 开始下载 Electron 到 ${defaultElectronExe()} ...`);
    electronEnsure = ensureElectronDownload({
      // 下载全过程写进工作状态气泡（用户没有控制台，只能靠它看进度与失败原因）
      onLog: ({ text, level, done }) =>
        reportDownload(text, level === 'warn' ? 'error' : done ? 'success' : 'working', done),
      // 同一份进度也落盘：气泡只在有宠物显示时可见，桌面版 Helper 起不来时它就没有载体
      logger: log,
    })
      .then((path) => {
        if (path) {
          launchHelper(path);
        } else {
          log.warn(
            '[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.',
          );
        }
      })
      .finally(() => {
        electronEnsure = undefined;
      });
  };

  const stopHelper = (reason = 'settings-change'): void => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    helper?.stop(reason);
    helper = undefined;
  };

  const stopHelperAndWait = async (reason: string): Promise<void> => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    const old = helper;
    helper = undefined;
    await old?.stopAndWait(reason);
  };

  const animSubdirFor = (ext: string): string => (ext === '.mov' ? 'mov' : 'webm');

  const assetRootFor = (ext: string): string => join(PACKAGE_ROOT, 'assets', animSubdirFor(ext));

  const userRootFor = (ext: string): string => join(thumbUserRoot, animSubdirFor(ext));

  const markDisposed = (): void => {
    disposed = true;
  };

  return { startHelper, stopHelper, stopHelperAndWait, markDisposed, assetRootFor, userRootFor };
}

/** DesktopSpawn的产出。 */
export type DesktopSpawn = ReturnType<typeof createDesktopSpawn>;
