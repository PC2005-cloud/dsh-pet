/**
 * 长期记忆实现的共享约定：内置 PowerContext 实现的 id 与它的连接配置。
 * 宿主注册该实现、设置页判断「选中它才显示地址与令牌」用的是同一个字符串，写两份迟早漂移。
 * @module dsh-pet/src/shared/memory
 */

/** 内置 PowerContext 记忆实现的 id（`memoryProvider` 的取值之一）。 */
export const POWERCONTEXT_MEMORY_ID = 'powercontext';

/** PowerContext 连接配置。 */
export interface PowerContextConfig {
  /** 服务根地址，含协议与端口、不带尾斜杠。 */
  endpoint: string;
  /** Bearer 令牌；服务端未开认证时为空串。只驻配置与内存，禁止进日志与错误文案。 */
  token: string;
  /** 是否用模型把用户这句话改写成检索查询。默认关：指代指向的内容通常已在对话历史里。 */
  optimizeQuery: boolean;
}

/** 长期记忆段（配置顶层 `memory`）：用哪个实现 + 该实现的连接参数。 */
export interface MemoryConfig {
  /** 记忆实现 id；空串等价于内置实现。 */
  provider: string;
  /** 内置 PowerContext 实现的参数；选别的实现时这些值原样留在配置里。 */
  powercontext: PowerContextConfig;
}
