/**
 * 运行时状态文件（`<DSH_HOME>/dsh-pet/standalone-runtime.json`）的读取与过期判定（ticket 07）。
 *
 * 独立模式 / 安装版宿主启动时把本机设置页的**能力 URL**（含一次性 token）写进这个文件；
 * 安装版是它的消费者：托盘与宠物右键菜单都经这里拿 URL。因此本模块是唯一的解析/校验入口，
 * 两个进程（宿主里的托盘、桌面壳）都只调用它，不允许各自再写一份。
 *
 * 安全边界：
 *   - settingsUrl 只接受本机 http 的 `/standalone-ai/` 页面且 hash 必须是 43 字符 token；
 *   - 文件被改坏/被替换时不把任意 URL 交给 shell.openExternal；
 *   - 返回的提示文案（会直接弹给用户）**绝不包含** settingsUrl 或 token。
 *
 * 过期判定的口径：pid 不存在（kill(pid, 0) ESRCH）、URL 端口与文件的 port 字段不一致、
 * 或本机端口不可连，都算过期——宿主可能已经退出，点开只会得到空白页/403。
 *
 * 本文件是纯逻辑 + 可注入探针（pidAlive / portReachable），不依赖 Electron；
 * 因此 node:test 可以直接测过期分支，不需要真的启动/杀死一个宿主进程。
 */
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';

/** 能力 URL 的固定路径（独立模式设置页） */
const SETTINGS_PATH = '/standalone-ai/';
/** 43 字符 base64url = 32 字节随机 token（见 standalone/request-security.ts） */
const TOKEN_HASH = /^#token=[A-Za-z0-9_-]{43}$/;
/** 端口连通性探测超时：本机连接要么立刻成功，要么立刻被拒；1s 只兜底防火墙静默丢包 */
const PORT_PROBE_TIMEOUT_MS = 1000;

/** 运行时文件的完整内容（只保留消费方需要的字段） */
export interface RuntimeSettings {
  settingsUrl: string;
  pid: number;
  port: number;
  token: string;
}

/** 不可用原因；调用方据此给出可读提示（文案见下面的 unavailableMessage） */
export type RuntimeUnavailableReason = 'missing' | 'invalid' | 'port-mismatch' | 'pid-gone' | 'port-unreachable';

/** 查询结果：可用时带 URL，不可用时带**不含 URL/token**的可读原因 */
export type RuntimeSettingsLookup =
  ({ available: true } & RuntimeSettings) | { available: false; reason: RuntimeUnavailableReason; message: string };

/** 可注入探针：单测用固定值替换真实进程/网络检查，生产由调用方省略 */
export interface RuntimeProbes {
  pidAlive?: (pid: number) => boolean;
  portReachable?: (port: number) => boolean | Promise<boolean>;
}

type DetailedParse = { ok: true; settings: RuntimeSettings } | { ok: false; reason: 'invalid' | 'port-mismatch' };

/**
 * DSH 主目录：优先 `DSH_HOME`，其次 Windows 的 `USERPROFILE`、类 Unix 的 `HOME`。
 * 与 src/host/helper-process.ts 的 `dshHomeDir()` 同一口径（这里单独实现是为了让桌面壳
 * 不必把整个 helper-process 模块图拖进运行时）。
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const userProfile = env.USERPROFILE || env.HOME || '';
  return env.DSH_HOME || join(userProfile, '.dsh');
}

/** 数据目录固定为 `<DSH_HOME>/dsh-pet`（与独立模式、插件形态共用；不是 %APPDATA%） */
export function petDataDir(home: string): string {
  return join(home, 'dsh-pet');
}

/** 独立模式启动时写出的运行时能力文件（settingsUrl / token / port） */
export function runtimeSettingsPath(home: string): string {
  return join(petDataDir(home), 'standalone-runtime.json');
}

/** 逐字段解析并校验；port 一致性单独给原因（见 evaluateRuntimeSettings） */
function parseDetailed(raw: unknown): DetailedParse {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'invalid' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid' };
  const fields = parsed as { settingsUrl?: unknown; pid?: unknown; port?: unknown };
  if (typeof fields.settingsUrl !== 'string') return { ok: false, reason: 'invalid' };
  if (!Number.isInteger(fields.pid) || (fields.pid as number) <= 0) return { ok: false, reason: 'invalid' };
  if (!Number.isInteger(fields.port) || (fields.port as number) < 1 || (fields.port as number) > 65535) {
    return { ok: false, reason: 'invalid' };
  }
  let url: URL;
  try {
    url = new URL(fields.settingsUrl);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    return { ok: false, reason: 'invalid' };
  }
  if (url.username || url.password) return { ok: false, reason: 'invalid' };
  if (url.pathname !== SETTINGS_PATH && url.pathname !== '/standalone-ai') return { ok: false, reason: 'invalid' };
  if (!TOKEN_HASH.test(url.hash)) return { ok: false, reason: 'invalid' };
  // URL 的 origin 必须与文件的 port 字段一致：两份信息漂移 = 文件过期/被改坏
  if (Number(url.port) !== fields.port) return { ok: false, reason: 'port-mismatch' };
  return {
    ok: true,
    settings: {
      settingsUrl: fields.settingsUrl,
      pid: fields.pid as number,
      port: fields.port as number,
      token: url.hash.slice('#token='.length),
    },
  };
}

/**
 * 从运行时文件原文解析设置页信息；形状不合法（含 URL 端口与 port 字段不一致）时返回 undefined。
 * 菜单可用性判定请用 evaluateRuntimeSettings（它能区分「过期」与「文件损坏」）。
 */
export function parseRuntimeSettings(raw: string | null | undefined): RuntimeSettings | undefined {
  const result = parseDetailed(raw);
  return result.ok ? result.settings : undefined;
}

/** 兼容 ticket 06 的调用方：只返回 URL */
export function parseRuntimeSettingsUrl(raw: string | null | undefined): string | undefined {
  return parseRuntimeSettings(raw)?.settingsUrl;
}

/** 进程是否还在：只有 ESRCH 判「没了」（EPERM = 进程在，只是不该由我们去动） */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 本机 TCP 端口是否可连（connect 成功即视为服务在；错误/超时都算不可用） */
export function probePort(port: number, timeoutMs: number = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 不可用原因 → 用户可读提示。必须明确告诉用户「先启动安装版宿主，或稍后重试」，
 * 且绝不包含 settingsUrl / token（本函数的返回值会直接进 dialog / 日志）。
 */
export function unavailableMessage(reason: RuntimeUnavailableReason): string {
  switch (reason) {
    case 'missing':
      return '没有找到本机 AI 设置页：安装版宿主可能还没有启动。请先启动 DSH Pet（安装版），稍后重试。';
    case 'invalid':
      return '本机 AI 设置页信息无效：运行时状态文件已损坏。请重启 DSH Pet 后重试。';
    case 'port-mismatch':
      return '本机 AI 设置页地址已过期：运行时状态文件里的端口对不上。请重启 DSH Pet 后重试。';
    case 'pid-gone':
      return '本机 AI 设置页已过期：写入它的进程已退出。请重新启动 DSH Pet，稍后重试。';
    case 'port-unreachable':
      return '本机 AI 设置页当前无法连接：本机服务可能已经停止。请重新启动 DSH Pet，稍后重试。';
  }
}

function unavailable(reason: RuntimeUnavailableReason): RuntimeSettingsLookup {
  return { available: false, reason, message: unavailableMessage(reason) };
}

/** 文件原文 + 探针 → 可用性；undefined 表示文件不存在 */
export async function evaluateRuntimeSettings(
  raw: string | null | undefined,
  probes: RuntimeProbes = {},
): Promise<RuntimeSettingsLookup> {
  if (raw === null || raw === undefined) return unavailable('missing');
  const parsed = parseDetailed(raw);
  if (!parsed.ok) return unavailable(parsed.reason);
  const pidAlive = probes.pidAlive ?? processAlive;
  if (!pidAlive(parsed.settings.pid)) return unavailable('pid-gone');
  const portReachable = probes.portReachable ?? probePort;
  if (!(await portReachable(parsed.settings.port))) return unavailable('port-unreachable');
  return { available: true, ...parsed.settings };
}

/** 从数据目录读取并判定；文件不存在/读不了都给出可读原因，绝不抛异常打断菜单 */
export async function readRuntimeSettings(home: string, probes: RuntimeProbes = {}): Promise<RuntimeSettingsLookup> {
  let raw: string;
  try {
    raw = await readFile(runtimeSettingsPath(home), 'utf8');
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid');
  }
  return evaluateRuntimeSettings(raw, probes);
}
