/**
 * 独立模式设置接口的校验与白名单：给 HTTP 层与单进程入口共用。
 *
 * 不依赖任何模型后端，便于在没有 AI 客户端时测试；不负责持久化。
 * 必须始终成立：只放行已知字段，密钥永远不会出现在白名单输出里。
 * @module dsh-pet/src/standalone/settings
 */
import type { ModelDiscoveryInput, ModelDiscoveryResult } from './ai-provider/types.ts';
import { z } from 'zod';

/** 设置服务的对外形状，不绑定具体模型后端。 */
export interface StandaloneSettingsService {
  /** 读当前设置。 */
  getSettings(): unknown;
  /** 保存设置并返回新视图。 */
  saveSettings(input: unknown): Promise<unknown>;
  /** 可选：用一次请求验证连接。 */
  testConnection?(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
  /** 可选：拉取端点声明可用的模型。 */
  discoverModels?(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult>;
}

/** 接口地址的校验：只允许干净的 HTTP 或 HTTPS 地址，凭据不放进 URL。 */
const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, '接口地址必须是 HTTP(S) 地址，且不能含账号、查询参数或片段');
/** 设置补丁的契约：未知字段一律拒绝。 */
const settingsSchema = z
  .object({
    protocol: z.enum(['openai-compatible', 'anthropic']).optional(),
    baseUrl: endpoint.optional(),
    model: z.string().max(200).optional(),
    apiKey: z.string().max(8192).optional(),
    clearApiKey: z.boolean().optional(),
    automaticWhispers: z.boolean().optional(),
    whisperIntervalSec: z.number().int().min(60).max(86400).optional(),
    maxTokens: z.number().int().min(128).max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
  })
  .strict();

/** 校验设置补丁。 */
export function validateSettings(input: unknown): z.infer<typeof settingsSchema> {
  const result = settingsSchema.safeParse(input);
  if (!result.success) throw new Error('设置无效：请检查协议、接口地址、间隔（至少 60 秒）和输出上限（128–4096）');
  return result.data;
}

/** 可出现在响应里的字段白名单。 */
const publicNames = [
  'protocol',
  'baseUrl',
  'model',
  'automaticWhispers',
  'whisperIntervalSec',
  'maxTokens',
  'timeoutMs',
  'hasKey',
] as const;
/** 过滤出可公开的设置字段。 */
export function publicSettings(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    publicNames
      .filter((name) => Object.prototype.hasOwnProperty.call(record, name))
      .map((name) => [name, record[name]]),
  );
}
