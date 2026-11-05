/**
 * 独立服务的端口与选项形状：默认端口、扫描上限与对外能力。
 *
 * 纯类型与常量，不含实现。
 * 必须始终成立：默认端口变化要同步 CLI 帮助文案与 CONFIG.md。
 * @module dsh-pet/src/standalone/server/options
 */
import { type RegisteredRoute, type StandaloneLogger } from '../context.ts';
import { type RequestSecurity } from '../request-security.ts';
import { type StandaloneSettingsService } from '../settings.ts';
import type { SetupService } from '../setup.ts';

/** 默认监听端口。 */
export const DEFAULT_STANDALONE_PORT = 3080;

/** 端口被占用时最多向后顺延的次数。 */
export const PORT_SCAN_LIMIT = 25;

/** 启动选项。 */
export interface StandaloneServerOptions {
  /** 插件注册的路由。 */
  routes: RegisteredRoute[];
  /** 日志出口。 */
  logger: StandaloneLogger;
  /** 首选端口。 */
  port?: number;
  /** 健康检查返回的状态。 */
  status?: () => unknown;
  /** 停机回调。 */
  onShutdown?: () => void;
  /** 访问校验门面。 */
  security?: RequestSecurity;
  /** 设置服务。 */
  ai?: StandaloneSettingsService;
  /** First-run installation and managed local memory. */
  setup?: SetupService;
  /** 正文读取时限，仅供超时测试覆盖。 */
  bodyTimeoutMs?: number;
}

/** 已启动的服务。 */
export interface StandaloneServer {
  /** 实际监听端口。 */
  port: number;
  /** 本次运行的访问校验门面。 */
  security: RequestSecurity;
  /** 关闭监听并断开在途连接。 */
  close(): Promise<void>;
}
