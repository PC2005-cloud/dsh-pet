/**
 * 宿主形态判定（ticket 08）—— 决定「打开网站」菜单项的语义。
 *
 * 三种形态：
 *   desktop  = 跑在 DSH 桌面应用里 → 唤起 DSH 主窗口（helper 走 dsh://open）
 *   site     = dsh web / 独立模式 CLI → 系统浏览器打开站点
 *   packaged = 安装版自带 Electron 运行时 → 系统浏览器打开本机服务地址（site 语义）
 *
 * 判据以启动方显式传入的 `DSH_PET_HOST_KIND` 为准：打包后的宿主自己就是 Electron 进程，
 * 若只看 `process.versions.electron` 会把它误判成 DSH 桌面应用（菜单文案变成
 * 「打开 DeepSeek Harness」并去唤起一个不存在的 dsh:// 协议）。
 *
 * 嗅探回退**只**用于一种情况：DSH 桌面应用启动插件宿主时无法给进程注入环境变量，
 * 而它以 `ELECTRON_RUN_AS_NODE=1` 跑，`process.versions.electron` 仍在。独立模式 CLI
 * 是纯 Node 进程，未设置时同样回退为 `site`。
 */

/** 宿主形态 */
export type HostKind = 'desktop' | 'site' | 'packaged';

/** 「打开网站」注入给桌面壳的去向（helper 只认这两个值） */
export type OpenTarget = 'desktop' | 'site';

/** 启动方显式声明宿主形态的环境变量 */
export const HOST_KIND_ENV = 'DSH_PET_HOST_KIND';

/** 只关心 Electron 标记的运行时版本视图（Electron 运行时会往 process.versions 里补 electron 字段） */
type RuntimeVersions = { readonly electron?: string | undefined };

/**
 * 解析宿主形态：显式环境变量优先，未设置（或取值非法）时回退到 Electron 嗅探。
 *
 * 入参可注入，便于单测；默认读真实进程环境。
 */
export function resolveHostKind(
  env: Record<string, string | undefined> = process.env,
  versions: RuntimeVersions | NodeJS.ProcessVersions = process.versions,
): HostKind {
  const explicit = env[HOST_KIND_ENV];
  if (explicit === 'desktop' || explicit === 'site' || explicit === 'packaged') return explicit;
  // 兼容 DSH 启动的插件形态（无法注入环境变量）；打包宿主必须显式设为 packaged，走不到这里。
  return versions.electron ? 'desktop' : 'site';
}

/** 宿主形态 → 桌面壳的「打开网站」去向：只有 DSH 桌面应用需要唤起主窗口。 */
export function openTargetForHostKind(kind: HostKind): OpenTarget {
  return kind === 'desktop' ? 'desktop' : 'site';
}
