/**
 * Google Antigravity（provider id `google-antigravity`）—— 额度窗口用量。
 *
 * 这条路由没有 API Key（`credential.mode === 'none'`）：OAuth 凭证由 `dsh-tool-antigravity` 插件管理，
 * 额度经调用方注入的 `resolveAntigravity`（= `ctx.get('antigravityAuth', false)?.usage()`）获取。
 *
 * Antigravity 的配额按分组（gemini / non-gemini）包含 5h 滚动窗口与 weekly 每周窗口：
 * - 窗口中的 `remainingFraction` 为剩余比例（0~1，如 0.85 = 剩余 85%）；
 * - dsh-pet 的 windows 契约要求**已用百分比**（0~100）：
 *   已用百分比 = (1 − remainingFraction) × 100；
 * - 滚动窗展示名为 `5h`；
 * - 支持根据当前选中的 `model` 自动匹配 gemini 或 non-gemini（Claude/GPT 等）分组。
 */
import { obj } from '../internal';
import type { BalanceProvider, BalanceSuccess, WindowsUsage } from '../types';

export interface AntigravityWindowView {
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
}

export interface AntigravityGroupView {
  group?: string;
  modelCount?: number;
  windows?: AntigravityWindowView[];
}

export interface AntigravityQuotaStatus {
  state?: string;
  checkedAt?: string;
  groups?: AntigravityGroupView[];
}

export function parseGoogleAntigravityQuota(
  rawUsage: unknown,
  provider: string,
  model?: string,
): BalanceSuccess {
  const root = obj(rawUsage);
  const usage = (root && 'value' in root && obj(root.value) ? root.value : root) as
    | AntigravityQuotaStatus
    | undefined;

  if (!usage || typeof usage !== 'object') {
    throw new Error('dsh-pet: 缺少 Antigravity 配额数据');
  }
  if (usage.state === 'unauthenticated') {
    throw new Error('dsh-pet: Antigravity 未登录，请先在 dsh-tool-antigravity 插件中登录');
  }
  if (usage.state === 'rate-limited') {
    throw new Error('dsh-pet: Antigravity 配额查询被限流，请稍后重试');
  }
  if (usage.state === 'forbidden') {
    throw new Error('dsh-pet: Antigravity 账号无权查询配额');
  }
  if (usage.state !== 'available') {
    throw new Error('dsh-pet: Antigravity 配额不可用（' + usage.state + '）');
  }

  const groups = Array.isArray(usage.groups) ? usage.groups : [];
  if (groups.length === 0) {
    throw new Error('dsh-pet: Antigravity 响应缺少配额分组');
  }

  const m = (model ?? '').toLowerCase();
  const isNonGemini =
    m.includes('claude') ||
    m.includes('gpt') ||
    m.includes('openai') ||
    m.includes('anthropic') ||
    m.includes('3p');
  let group = groups.find((g) => (isNonGemini ? g?.group === 'non-gemini' : g?.group === 'gemini'));
  if (!group) group = groups[0];

  const windows = Array.isArray(group?.windows) ? group.windows : [];
  const win5h = windows.find((w) => w?.window === '5h');
  const winWeekly = windows.find((w) => w?.window === 'weekly');

  if (!win5h && !winWeekly) {
    throw new Error('dsh-pet: Antigravity 配额缺少有效窗口');
  }

  const data: WindowsUsage = {};
  if (win5h && typeof win5h.remainingFraction === 'number' && Number.isFinite(win5h.remainingFraction)) {
    data.rolling = Math.max(0, Math.min(100, Math.round((1 - win5h.remainingFraction) * 10000) / 100));
    data.rollingLabel = '5h';
    if (typeof win5h.resetTime === 'string' && win5h.resetTime.length > 0) {
      data.rollingResetsAt = win5h.resetTime;
    }
  }
  if (winWeekly && typeof winWeekly.remainingFraction === 'number' && Number.isFinite(winWeekly.remainingFraction)) {
    data.weekly = Math.max(0, Math.min(100, Math.round((1 - winWeekly.remainingFraction) * 10000) / 100));
    if (typeof winWeekly.resetTime === 'string' && winWeekly.resetTime.length > 0) {
      data.weeklyResetsAt = winWeekly.resetTime;
    }
  }

  return {
    ok: true,
    provider,
    shape: 'windows',
    data,
  };
}

export const googleAntigravity: BalanceProvider = {
  id: 'google-antigravity',
  credential: { mode: 'none' },
  async fetch({ provider, resolveAntigravity, model }) {
    if (!resolveAntigravity) throw new Error('dsh-pet: 缺少 Antigravity 服务（' + provider + '）');
    const raw = await resolveAntigravity();
    return parseGoogleAntigravityQuota(raw, provider, model);
  },
};
