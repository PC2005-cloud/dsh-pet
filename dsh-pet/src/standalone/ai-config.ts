/**
 * 独立模式的 AI 设置模型：校验、脱敏与成品配置的组装。
 *
 * 负责把调用方补丁校验为成品配置，并让密钥只留在本机配置文件；
 * 不负责模型请求（见 ai-provider），也不负责文件权限与原子写（见 ai-storage）。
 * 必须始终成立：对外只返回脱敏视图，持久化失败时不更新内存中的设置。
 * @module dsh-pet/src/standalone/ai-config
 */
import { z } from 'zod';
import { readAiSettings, writeAiSettings } from './ai-storage.ts';

/** 对外可见的设置视图：密钥只以 hasKey 表示；AI 是否可用只看地址、模型与密钥是否齐全。 */
export interface StandaloneAiPublicSettings {
  /** 接口协议，仅支持 OpenAI 兼容与 Anthropic 两种。 */
  protocol: 'openai-compatible' | 'anthropic';
  /** 服务商接口地址，为空表示尚未配置。 */
  baseUrl: string;
  /** 模型标识，原样传给服务商。 */
  model: string;
  /** 兼容旧配置文件的遗留字段，已不参与任何调度；保留只为让旧文件继续通过 strict 校验。 */
  automaticWhispers: boolean;
  /** 兼容旧配置文件的遗留字段；碎碎念周期唯一来源是宠物配置的 `eventsRefreshSec.whisper`。 */
  whisperIntervalSec: number;
  /** 单次回复的输出上限（写入请求的 max_tokens）；页面不再暴露，沿用已存值或默认值。 */
  maxTokens: number;
  /** 单次请求超时，单位毫秒。 */
  timeoutMs: number;
  /** 是否已保存密钥，不回传密钥本身。 */
  hasKey: boolean;
}
/** 内部成品配置：在公开视图上补回明文密钥，以及只为文件兼容保留的启用位。 */
export type StandaloneAiSettings = Omit<StandaloneAiPublicSettings, 'hasKey'> & {
  apiKey: string;
  /** 兼容旧配置文件的遗留字段，恒为 true；旧文件里的 false 读入后即被覆盖。 */
  enabled: boolean;
};

/** 默认成品配置；未配置时 AI 保持关闭。 */
export const DEFAULT_AI_SETTINGS: Readonly<StandaloneAiSettings> = Object.freeze({
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  enabled: true,
  automaticWhispers: false,
  whisperIntervalSec: 300,
  maxTokens: 1024,
  timeoutMs: 30_000,
  apiKey: '',
});

/** 只接受空值或干净的 HTTP 或 HTTPS 地址；账号、查询参数与片段都不允许。 */
function safeEndpoint(value: string): boolean {
  if (!value) return true;
  if (value !== value.trim() || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
      return false;
    }
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/** 检查控制字符，避免不可见字符写进配置。 */
function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

/** 成品配置的字段契约：长度、范围与字符集在这里一次定死。 */
const fields = {
  protocol: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: z.string().max(2048).refine(safeEndpoint),
  model: z
    .string()
    .trim()
    .max(200)
    .refine((s) => !containsControlChar(s)),
  /** 只为旧文件兼容保留：保存时一律写 true，可用性由地址、模型与密钥决定。 */
  enabled: z.boolean(),
  automaticWhispers: z.boolean(),
  whisperIntervalSec: z.number().int().min(60).max(86400),
  maxTokens: z.number().int().min(128).max(4096),
  timeoutMs: z.number().int().min(1000).max(60_000),
  apiKey: z
    .string()
    .max(4096)
    .refine((s) => !containsControlChar(s) && !/\s/.test(s)),
};
/** 落盘内容的完整校验。 */
const persistedSchema = z.object(fields).strict();
/** 设置页提交的补丁校验，允许额外带一个清空密钥标记。 */
const patchSchema = persistedSchema.partial().extend({ clearApiKey: z.boolean().optional() }).strict();

/**
 * 校验未知输入并合并到上一份成品配置。
 * @param input - 调用方给出的补丁，可能只含部分字段。
 * @param previous - 上一份成品配置，用作未提供字段的基线。
 * @returns 校验并合并后的新的成品配置。
 * @throws 字段越界，或清空与写入密钥同时出现时。
 */
export function validateSettings(input: unknown, previous: Readonly<StandaloneAiSettings>): StandaloneAiSettings {
  try {
    const patch = patchSchema.parse(input);
    // 清空与写入同时出现时意图不明，直接拒绝。
    if (patch.clearApiKey && patch.apiKey) throw new Error('Conflicting key changes');
    const { clearApiKey, ...values } = patch;
    const apiKey = clearApiKey ? '' : values.apiKey || previous.apiKey;
    // 配置填一半只是暂时不可用，不该连保存都拒绝；启用位不再有语义，一律写回 true。
    return persistedSchema.parse({ ...previous, ...values, apiKey, enabled: true });
  } catch {
    throw new Error('Invalid standalone AI settings.');
  }
}

/** 去掉密钥与启用位，只保留是否已保存密钥。 */
function redact(settings: Readonly<StandaloneAiSettings>): StandaloneAiPublicSettings {
  const { apiKey, enabled, ...publicFields } = settings;
  // 启用位只为旧文件保留，不进对外视图；解构出来显式丢弃，否则 lint 会当成未使用变量。
  void enabled;
  return { ...publicFields, hasKey: apiKey.length > 0 };
}

/** 设置存储的读写门面，调用方只能拿到脱敏视图。 */
export interface AiConfigStore {
  /** 取当前成品配置（含密钥，仅供本进程使用）。 */
  current(): Readonly<StandaloneAiSettings>;
  /** 取脱敏视图，用于设置页与路由响应。 */
  publicSettings(): StandaloneAiPublicSettings;
  /** 校验并持久化补丁，返回新的脱敏视图。 */
  save(input: unknown): Promise<StandaloneAiPublicSettings>;
}

/**
 * 从本机配置创建设置存储。
 * @param home - DSH_HOME。
 * @returns 设置存储。
 * @throws 配置文件不安全或无法读取时抛出。
 */
export function createAiConfig(home: string): AiConfigStore {
  let settings: Readonly<StandaloneAiSettings> = DEFAULT_AI_SETTINGS;
  try {
    const loaded = readAiSettings(home);
    // 持久化内容也要重新校验，坏数据不能进入内存。
    if (loaded !== undefined)
      settings = Object.freeze(validateSettings(persistedSchema.parse(loaded), DEFAULT_AI_SETTINGS));
  } catch {
    // 读取失败说明无法确认文件权限，宁可整体失败。
    throw new Error('Cannot securely load standalone AI settings.');
  }
  return {
    current: () => settings,
    publicSettings: () => redact(settings),
    async save(input) {
      const next = validateSettings(input, settings);
      try {
        writeAiSettings(home, next);
      } catch {
        throw new Error('Cannot securely save standalone AI settings.');
      }
      // 写盘成功后才替换内存中的设置。
      settings = Object.freeze(next);
      return redact(settings);
    },
  };
}
