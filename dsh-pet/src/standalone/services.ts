/**
 * 独立模式内置服务商名录：键名、协议、对话地址与模型清单地址的唯一来源。
 *
 * 只服务独立模式，不引用宿主半侧（host）的任何定义；新增一家只需在 {@link BUILTIN_SERVICES} 加一行。
 * 必须始终成立：{@link ServiceDef.baseUrl} 是「客户端直接拼 /chat/completions」的形态，
 * 不能照抄官方文档里带 /openai 或 /anthropic 分段的完整端点，否则会多出一段路径。
 * @module dsh-pet/src/standalone/services
 */

/** 对话协议：与 ai-transport 的两条分支一一对应。 */
export type AiProtocol = 'openai-compatible' | 'anthropic';

/** 自定义服务商：用户自填地址，恒为下拉第一项，也是旧配置的落点。 */
export const CUSTOM_SERVICE = 'custom' as const;

/** 内置服务商 id。 */
export type BuiltinServiceId = 'deepseek-official' | 'opencode-go' | 'commandcode';

/** 服务商 id：自定义或三家内置之一。 */
export type ServiceId = typeof CUSTOM_SERVICE | BuiltinServiceId;

/**
 * 凭据键名：沿用 DSH 的引用名习惯，配置文件里一眼能看出属于哪家。
 * 注意 DeepSeek 的键名不带 OFFICIAL，与宿主凭据名保持一致。
 */
export type KeyName = 'DEEPSEEK_API_KEY' | 'OPENCODE_GO_API_KEY' | 'COMMANDCODE_API_KEY' | 'CUSTOM_API_KEY';

/** 全部键名，也是 keys 表的固定形状与顺序。 */
export const KEY_NAMES: readonly KeyName[] = [
  'DEEPSEEK_API_KEY',
  'OPENCODE_GO_API_KEY',
  'COMMANDCODE_API_KEY',
  'CUSTOM_API_KEY',
];

/** 一个内置服务商的全部固定知识。 */
export interface ServiceDef {
  /** 稳定标识：出现在配置、设置页与余额查询里。 */
  readonly id: BuiltinServiceId;
  /** 设置页显示名。 */
  readonly label: string;
  /** 该家的凭据键名。 */
  readonly keyName: KeyName;
  /** 对话协议。 */
  readonly protocol: AiProtocol;
  /** 对话基础地址（客户端在其后拼 /chat/completions 或 /v1/messages）。 */
  readonly baseUrl: string;
  /** 模型清单地址；缺省由 baseUrl 推导。 */
  readonly modelsUrl?: string;
  /**
   * 服务商要求每个请求携带的会话头名。值由传输层填一个进程内稳定的 ID；
   * opencode Go 缺这个头会直接 400（无法路由），见 https://opencode.ai/docs/console/go/ 的 Where can I use it。
   */
  readonly sessionHeader?: string;
}

/** 内置服务商；顺序即设置页下拉顺序。 */
export const BUILTIN_SERVICES: readonly ServiceDef[] = [
  {
    id: 'deepseek-official',
    label: 'DeepSeek 官方',
    keyName: 'DEEPSEEK_API_KEY',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'opencode-go',
    label: 'opencode Go',
    keyName: 'OPENCODE_GO_API_KEY',
    protocol: 'openai-compatible',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    // 对话地址带 /openai/v1，模型清单却在上一级；照 baseUrl 推导会 404。
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',
    // 不带这个头会 400 Request is missing x-opencode-session。
    sessionHeader: 'x-opencode-session',
  },
  {
    id: 'commandcode',
    label: 'commandcode',
    keyName: 'COMMANDCODE_API_KEY',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
  },
];

/** 全部服务商 id，自定义在前。 */
export const SERVICE_IDS: readonly ServiceId[] = [CUSTOM_SERVICE, ...BUILTIN_SERVICES.map((def) => def.id)];

/**
 * 按 id 取内置服务商定义。
 * @param id - 服务商 id，可以是自定义或未知值。
 * @returns 内置定义；自定义与未知值返回 undefined。
 */
export function builtinService(id: string): ServiceDef | undefined {
  return BUILTIN_SERVICES.find((def) => def.id === id);
}

/**
 * 判断是否内置服务商 id。
 * @param id - 待判定的值。
 * @returns 是内置服务商时为 true。
 */
export function isBuiltinService(id: string): id is BuiltinServiceId {
  return builtinService(id) !== undefined;
}

/**
 * 取服务商对应的凭据键名。
 * @param service - 服务商 id。
 * @returns 内置服务的键名；自定义与未知值一律落到 CUSTOM_API_KEY。
 */
export function serviceKeyName(service: string): KeyName {
  return builtinService(service)?.keyName ?? 'CUSTOM_API_KEY';
}

/**
 * 取服务商显示名。
 * @param service - 服务商 id。
 * @returns 内置服务的中文名；自定义与未知值为「自定义」。
 */
export function serviceLabel(service: string): string {
  return builtinService(service)?.label ?? '自定义';
}

/** 地址归一：去首尾空白与尾斜杠，再抹掉末尾的版本段，供「是否同一家」比较。 */
function normalizeEndpoint(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v\d+$/i, '')
    .toLowerCase();
}

/**
 * 判断两个对话地址是否指向同一家（容忍尾斜杠与 /v1 这类版本段差异）。
 * @param left - 地址 A。
 * @param right - 地址 B。
 * @returns 归一后相等时为 true；任一侧为空时为 false。
 */
export function sameEndpoint(left: string, right: string): boolean {
  if (left.trim() === '' || right.trim() === '') return false;
  return normalizeEndpoint(left) === normalizeEndpoint(right);
}

/**
 * 按已保存的对话地址反查内置服务商，用于旧配置迁移。
 * @param baseUrl - 旧配置里的 Base URL。
 * @returns 地址正好等于某家时返回该家 id；否则 undefined。
 */
export function serviceForEndpoint(baseUrl: string): ServiceDef | undefined {
  return BUILTIN_SERVICES.find((def) => sameEndpoint(baseUrl, def.baseUrl));
}
