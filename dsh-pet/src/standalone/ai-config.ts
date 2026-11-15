/**
 * 独立模式的 AI 设置模型：校验、迁移、脱敏与成品配置的组装。
 *
 * 负责把调用方补丁校验为成品配置，并让密钥只留在本机配置文件；
 * 不负责模型请求（见 ai-provider），也不负责文件权限与原子写（见 ai-storage）。
 * 必须始终成立：对外只返回脱敏视图；持久化失败时不更新内存中的设置；
 * keys 与 profiles 都按服务商分开存，切换服务商不覆盖任何一家。
 * @module dsh-pet/src/standalone/ai-config
 */
import { z } from 'zod';
import { readAiSettings, writeAiSettings } from './ai-storage.ts';
import {
  BUILTIN_SERVICES,
  CUSTOM_SERVICE,
  KEY_NAMES,
  sameEndpoint,
  serviceKeyName,
  type AiProtocol,
  type KeyName,
  type ServiceId,
} from './services.ts';

/** 每个服务商的密钥：键名固定，值只写不回显。 */
export type KeyMap = Record<KeyName, string>;
/** 一个服务商自己的协议、地址与模型：切换时按它回填，互不影响。 */
export interface ServiceProfile {
  /** 该服务商使用的协议。 */
  protocol: AiProtocol;
  /** 该服务商的对话地址。 */
  baseUrl: string;
  /** 该服务商上次选定的模型。 */
  model: string;
}
/** 每个服务商各一份 profile。 */
export type ProfileMap = Record<ServiceId, ServiceProfile>;

/** 落盘的那部分：不含派生字段。 */
interface StoredAiSettings {
  /** 当前服务商；自定义为 'custom'。 */
  service: ServiceId;
  /** 按服务商分开存的密钥。 */
  keys: KeyMap;
  /** 按服务商分开存的协议、地址与模型。 */
  profiles: ProfileMap;
  maxTokens: number;
  timeoutMs: number;
  /** 仅 DeepSeek 语音（TTS / ASR）用的密钥，与任何服务的对话密钥都分开。 */
  deepseekApiKey: string;
  automaticWhispers: boolean;
  whisperIntervalSec: number;
  /** 兼容旧配置文件的遗留字段，恒为 true；旧文件里的 false 读入后即被覆盖。 */
  enabled: boolean;
}

/** 成品配置：落盘字段 + 由当前服务商派生的 apiKey / protocol / baseUrl / model。 */
export type StandaloneAiSettings = StoredAiSettings & {
  /** 当前服务商的密钥（= keys[serviceKeyName(service)]），不单独落盘。 */
  apiKey: string;
  /** 当前服务商的协议（= profiles[service].protocol）。 */
  protocol: AiProtocol;
  /** 当前服务商的地址（= profiles[service].baseUrl）。 */
  baseUrl: string;
  /** 当前服务商的模型（= profiles[service].model）。 */
  model: string;
};

/** 对外可见的设置视图：密钥只以状态表示，绝不含明文。 */
export interface StandaloneAiPublicSettings {
  /** 当前服务商。 */
  service: ServiceId;
  /** 当前生效的协议，等于 profiles[service].protocol。 */
  protocol: AiProtocol;
  /** 当前生效的接口地址。 */
  baseUrl: string;
  /** 当前生效的模型标识，原样传给服务商。 */
  model: string;
  /** 每个服务商各自记住的协议、地址与模型，切换时回填。 */
  profiles: ProfileMap;
  /** 兼容旧配置文件的遗留字段，已不参与任何调度。 */
  automaticWhispers: boolean;
  /** 兼容旧配置文件的遗留字段；碎碎念周期唯一来源是宠物配置的 `eventsRefreshSec.whisper`。 */
  whisperIntervalSec: number;
  /** 单次回复的输出上限（写入请求的 max_tokens）；页面不再暴露，沿用已存值或默认值。 */
  maxTokens: number;
  /** 单次请求超时，单位毫秒。 */
  timeoutMs: number;
  /** 当前服务商是否已保存密钥。 */
  hasKey: boolean;
  /** 是否已保存 DeepSeek 语音密钥，不回传密钥本身。 */
  hasDeepseekKey: boolean;
  /** 已保存密钥的键名，用于在切换服务商时显示各自的状态。 */
  savedKeys: KeyName[];
}

/** 空的密钥表。 */
const EMPTY_KEYS: Readonly<KeyMap> = Object.freeze({
  DEEPSEEK_API_KEY: '',
  OPENCODE_GO_API_KEY: '',
  COMMANDCODE_API_KEY: '',
  CUSTOM_API_KEY: '',
});

/** 内置服务商的初始 profile：协议与地址取自名录，模型留空由用户选。 */
function builtinProfiles(): ProfileMap {
  const profiles = { [CUSTOM_SERVICE]: { protocol: 'openai-compatible', baseUrl: '', model: '' } } as ProfileMap;
  for (const def of BUILTIN_SERVICES) {
    profiles[def.id] = { protocol: def.protocol, baseUrl: def.baseUrl, model: '' };
  }
  return profiles;
}

/** 落盘默认值；未配置时 AI 保持关闭（地址与密钥为空即不可用）。 */
const DEFAULT_STORED: Readonly<StoredAiSettings> = Object.freeze({
  service: CUSTOM_SERVICE,
  keys: { ...EMPTY_KEYS },
  profiles: builtinProfiles(),
  maxTokens: 1024,
  timeoutMs: 30_000,
  deepseekApiKey: '',
  automaticWhispers: false,
  whisperIntervalSec: 300,
  enabled: true,
});

/** 由落盘字段派生出当前服务商的密钥、协议、地址与模型。 */
function derive(stored: StoredAiSettings): StandaloneAiSettings {
  return {
    ...stored,
    apiKey: stored.keys[serviceKeyName(stored.service)],
    ...stored.profiles[stored.service],
  };
}

/** 默认成品配置。 */
export const DEFAULT_AI_SETTINGS: Readonly<StandaloneAiSettings> = Object.freeze(
  derive({ ...DEFAULT_STORED, keys: { ...EMPTY_KEYS }, profiles: builtinProfiles() }),
);

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

/** 密钥：不许空白与控制字符。 */
const secret = z
  .string()
  .max(4096)
  .refine((s) => !containsControlChar(s) && !/\s/.test(s));

/** 一个服务商 profile 的字段契约。 */
const profileSchema = z
  .object({
    protocol: z.enum(['openai-compatible', 'anthropic']),
    baseUrl: z.string().max(2048).refine(safeEndpoint),
    model: z
      .string()
      .max(200)
      .refine((s) => !containsControlChar(s) && s === s.trim()),
  })
  .strict();

/** 密钥表：四家各一栏，未知键名一律拒绝。 */
const keysSchema = z
  .object({
    DEEPSEEK_API_KEY: secret,
    OPENCODE_GO_API_KEY: secret,
    COMMANDCODE_API_KEY: secret,
    CUSTOM_API_KEY: secret,
  })
  .strict();

/** profile 表：四家各一份，未知键名一律拒绝。 */
const profilesSchema = z
  .object({
    custom: profileSchema,
    'deepseek-official': profileSchema,
    'opencode-go': profileSchema,
    commandcode: profileSchema,
  })
  .strict();

/** 落盘内容的完整校验。 */
const persistedSchema = z
  .object({
    service: z.enum(['custom', 'deepseek-official', 'opencode-go', 'commandcode']),
    keys: keysSchema,
    profiles: profilesSchema,
    maxTokens: z.number().int().min(128).max(4096),
    timeoutMs: z.number().int().min(1000).max(60_000),
    deepseekApiKey: secret,
    automaticWhispers: z.boolean(),
    whisperIntervalSec: z.number().int().min(60).max(86400),
    enabled: z.boolean(),
  })
  .strict();

/** 设置页提交的补丁校验：全部字段可选，密钥与 profile 可以只提交其中一栏。 */
const patchSchema = z
  .object({
    service: z.enum(['custom', 'deepseek-official', 'opencode-go', 'commandcode']).optional(),
    keys: keysSchema.partial().optional(),
    profiles: profilesSchema.partial().optional(),
    maxTokens: z.number().int().min(128).max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(60_000).optional(),
    deepseekApiKey: secret.optional(),
    automaticWhispers: z.boolean().optional(),
    whisperIntervalSec: z.number().int().min(60).max(86400).optional(),
    clearKey: z.boolean().optional(),
    clearDeepseekKey: z.boolean().optional(),
    /** 旧文件会带这个键；读盘时整份配置也走补丁校验，所以必须接受，但取值一律被覆盖成 true。 */
    enabled: z.boolean().optional(),
  })
  .strict();

/** 判断一个未知值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把旧版配置（统一 apiKey + balanceProvider）迁移成按服务商分栏的形态。
 *
 * 迁移只做一次：文件里已经有 keys 或 profiles 时原样返回。
 * 服务商判定只看对话地址——地址正好等于某家内置时认成那家，否则保留自定义，
 * 保证老用户的对话一个字都不变；余额随之跟到该服务，地址不匹配的旧余额（对话走别家、
 * 余额单独选）会失效，这是「对话与余额同一个服务商」的必然代价。
 * @param input - 读到的原始配置。
 * @returns 新格式配置；输入不是普通对象时原样返回。
 */
export function migrateLegacySettings(input: unknown): unknown {
  if (!isRecord(input)) return input;
  if (isRecord(input.keys) || isRecord(input.profiles)) return input;
  // 既没有旧版字段也没有新版分栏，说明文件不是我们写的：原样交回去让 strict 校验拒绝，
  // 不能顺手"修好"——那会把损坏的文件悄悄重置成默认值。
  if (!['apiKey', 'model', 'baseUrl', 'balanceProvider'].some((key) => key in input)) return input;

  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : '';
  const protocol = input.protocol === 'anthropic' ? 'anthropic' : 'openai-compatible';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey : '';
  const model = typeof input.model === 'string' ? input.model : '';
  const matched = BUILTIN_SERVICES.find((def) => sameEndpoint(baseUrl, def.baseUrl));
  const service: ServiceId = matched ? matched.id : CUSTOM_SERVICE;

  const profiles = builtinProfiles();
  // 用户自己的协议/地址/模型原样搬进当前服务那一栏，其余服务沿用名录初值。
  profiles[service] = { protocol, baseUrl, model };

  const next: Record<string, unknown> = { ...input };
  delete next.balanceProvider;
  delete next.apiKey;
  delete next.model;
  delete next.protocol;
  delete next.baseUrl;
  next.service = service;
  next.keys = { ...EMPTY_KEYS, [serviceKeyName(service)]: apiKey };
  next.profiles = profiles;
  return next;
}

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
    const keyPatch = patch.keys;
    const written = KEY_NAMES.filter((name) => (keyPatch?.[name] ?? '') !== '');
    // 清空与写入同时出现时意图不明，直接拒绝。
    if (patch.clearKey && written.length > 0) throw new Error('Conflicting key changes');
    if (patch.clearDeepseekKey && patch.deepseekApiKey) throw new Error('Conflicting key changes');

    const { clearKey, clearDeepseekKey, keys: _keys, profiles: _profiles, ...values } = patch;
    void _keys;
    void _profiles;

    const service = values.service ?? previous.service;
    // 空串表示「这次没填」，保留原值；只有 clearKey 才真正清空当前服务那一栏。
    const keys: KeyMap = { ...previous.keys };
    for (const name of written) keys[name] = keyPatch![name]!;
    if (clearKey) keys[serviceKeyName(service)] = '';

    // 一家的 profile 整体替换，没提交的几家原样保留。
    const profiles: ProfileMap = { ...previous.profiles, ...(patch.profiles ?? {}) };

    const deepseekApiKey = clearDeepseekKey ? '' : values.deepseekApiKey || previous.deepseekApiKey;

    // 配置填一半只是暂时不可用，不该连保存都拒绝；启用位不再有语义，一律写回 true。
    const stored = persistedSchema.parse({
      service,
      keys,
      profiles,
      maxTokens: values.maxTokens ?? previous.maxTokens,
      timeoutMs: values.timeoutMs ?? previous.timeoutMs,
      deepseekApiKey,
      automaticWhispers: values.automaticWhispers ?? previous.automaticWhispers,
      whisperIntervalSec: values.whisperIntervalSec ?? previous.whisperIntervalSec,
      enabled: true,
    });
    return derive(stored);
  } catch {
    throw new Error('Invalid standalone AI settings.');
  }
}

/**
 * 去掉派生字段，得到只该落盘的那部分。
 * @param settings - 成品配置。
 * @returns 不含 apiKey / protocol / baseUrl / model 的落盘对象。
 */
export function persistedSettings(settings: Readonly<StandaloneAiSettings>): StoredAiSettings {
  const { apiKey, protocol, baseUrl, model, ...stored } = settings;
  void apiKey;
  void protocol;
  void baseUrl;
  void model;
  return stored;
}

/** 去掉密钥与启用位，只保留密钥是否已保存。 */
function redact(settings: Readonly<StandaloneAiSettings>): StandaloneAiPublicSettings {
  const { apiKey, deepseekApiKey, enabled, keys, ...rest } = settings;
  // 启用位只为旧文件保留，不进对外视图；解构出来显式丢弃，否则 lint 会当成未使用变量。
  void enabled;
  return {
    ...rest,
    hasKey: apiKey.length > 0,
    hasDeepseekKey: deepseekApiKey.length > 0,
    savedKeys: KEY_NAMES.filter((name) => keys[name].length > 0),
  };
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
    // 旧配置文件没有后加的字段，先迁移旧形状、再铺默认值；否则升级后 strict 校验会拒绝整个文件。
    if (loaded !== undefined) {
      const migrated = migrateLegacySettings(loaded);
      settings = Object.freeze(
        validateSettings(
          persistedSchema.parse({
            ...DEFAULT_STORED,
            keys: { ...EMPTY_KEYS },
            profiles: builtinProfiles(),
            ...(isRecord(migrated) ? migrated : {}),
          }),
          DEFAULT_AI_SETTINGS,
        ),
      );
    }
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
        writeAiSettings(home, persistedSettings(next));
      } catch {
        throw new Error('Cannot securely save standalone AI settings.');
      }
      // 写盘成功后才替换内存中的设置。
      settings = Object.freeze(next);
      return redact(settings);
    },
  };
}
