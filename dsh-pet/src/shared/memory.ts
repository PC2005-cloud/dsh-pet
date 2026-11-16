/**
 * 长期记忆实现的共享约定：内置 PowerContext 实现的 id 与它的连接配置。
 * 宿主注册该实现、设置页判断「选中它才显示地址与令牌」用的是同一个字符串，写两份迟早漂移。
 * @module dsh-pet/src/shared/memory
 */

/** 内置 PowerContext 记忆实现的 id（`memoryProvider` 的取值之一）。 */
export const POWERCONTEXT_MEMORY_ID = 'powercontext';

/** PowerContext 连接配置（`powercontext` 顶层段，整段替换）。 */
export interface PowerContextConfig {
  /** 服务根地址，含协议与端口、不带尾斜杠。 */
  endpoint: string;
  /** Bearer 令牌；服务端未开认证时为空串。只驻配置与内存，禁止进日志与错误文案。 */
  token: string;
}
