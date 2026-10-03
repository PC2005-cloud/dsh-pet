// 余额数据层与展示视图（src/shared 纯逻辑，浏览器 bundle 与桌面 shared-core 共用）：
// 解析 S 的余额叶子（host 的 BalanceResult）→ 客户端视图 → 档位计算 → 气泡行数据。
// 取数不在本模块：改造后余额由 host 定时器刷新并写进 /state（两端共享同一份结果），
// 本模块只做纯解析/展示。不依赖 React/DOM；host/balance.ts 的 BalanceResult 与本模块的
// RawBalanceResult 同构（HTTP 契约两端各自声明，host 无需 import 本目录——DSH 单文件加载约束）。

/** 余额叶子里的原始响应（与 host/balance.ts 的 BalanceResult 同构；两端按此结构校验） */
export interface RawBalanceResult {
  ok: boolean;
  provider?: string;
  kind?: 'opencode' | 'deepseek';
  reason?: string;
  message?: string;
  data?: {
    rolling?: unknown;
    weekly?: unknown;
    monthly?: unknown;
    rollingResetsAt?: unknown;
    weeklyResetsAt?: unknown;
    monthlyResetsAt?: unknown;
    currency?: unknown;
    total?: unknown;
    granted?: unknown;
    toppedUp?: unknown;
  };
}

/** 已解析的余额视图（展示 + 档位计算用） */
export interface BalanceView {
  provider: string;
  kind: 'opencode' | 'deepseek';
  ok: true;
  /** opencode：三窗口用量（0-100 数字）+ 各自的重置时间 */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /** deepseek：余额金额（字符串，与接口一致） */
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
}

/** 无效（不支持/缺凭证/抓取失败）：显式标记，不静默 */
export interface BalanceUnavailable {
  provider: string;
  ok: false;
  reason: 'unsupported' | 'credential-missing' | 'fetch-error';
  message?: string;
}

export type BalanceState = BalanceView | BalanceUnavailable;

/**
 * host 的余额原始响应（`BalanceResult`，经 `/state` 的 `sections.balance` 叶子送达）→ 客户端视图。
 *
 * 形状非法 / kind 不认识 → **null**（消费端跳过这一拍）——注意这里**不抛**：它跑在 1s 轮询里，
 * 抛异常会把整拍打断（其余叶子也跟着不渲染）。取数失败（HTTP/网络）在改造后不再发生在这里：
 * 取数在 host，失败会以 `ok:false` 写进 S，由这里正常映射成"不可用"状态。
 */
export function toBalanceState(raw: unknown): BalanceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawBalanceResult;
  const provider = String(r.provider ?? 'unknown');
  if (r.ok !== true) {
    const reason =
      r.reason === 'unsupported' || r.reason === 'credential-missing' || r.reason === 'fetch-error'
        ? r.reason
        : 'fetch-error';
    return { provider, ok: false, reason, message: typeof r.message === 'string' ? r.message : undefined };
  }

  const d = r.data;
  if (!d || typeof d !== 'object') return null;

  if (r.kind === 'opencode') {
    const rolling = Number(d.rolling);
    const weekly = Number(d.weekly);
    const monthly = Number(d.monthly);
    if (![rolling, weekly, monthly].every(Number.isFinite)) return null;
    return {
      provider,
      kind: 'opencode',
      ok: true,
      rolling,
      weekly,
      monthly,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  if (r.kind === 'deepseek') {
    return {
      provider,
      kind: 'deepseek',
      ok: true,
      currency: typeof d.currency === 'string' ? d.currency : undefined,
      total: typeof d.total === 'string' ? d.total : undefined,
      granted: typeof d.granted === 'string' ? d.granted : undefined,
      toppedUp: typeof d.toppedUp === 'string' ? d.toppedUp : undefined,
    };
  }
  return null;
}

/** DeepSeek 满额基准（¥）：余额 ≥ 该值视为 100%（未消耗），余额按比例折算为已用百分比 */
export const DEEPSEEK_FULL_BALANCE_CNY = 20;

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
 * - opencode：取三窗口最大（风险最高者为准）
 * - deepseek：余额按 DEEPSEEK_FULL_BALANCE_CNY（¥20 = 100%）折算为已用百分比
 *   （余额 20 元 → 0%，10 元 → 50%，0 元 → 100%）
 */
export function balancePercent(v: BalanceView): number | undefined {
  if (v.kind === 'opencode') return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
  if (v.kind === 'deepseek') {
    const total = Number(v.total);
    if (!Number.isFinite(total)) return undefined; // 金额非法（非数字）：不触发（上层校验已兜底，此处双保险）
    // 负数 = 透支，与 0 等价按「已用完」折算：-0.02 → 剩余 0 → 已用 100%（播「分文不剩」档）
    const remaining = (Math.max(0, total) / DEEPSEEK_FULL_BALANCE_CNY) * 100; // 剩余百分比 0~100+
    return Math.max(0, Math.min(100, 100 - remaining)); // 折算为已用百分比
  }
  return undefined;
}

/**
 * 余额事件档位索引（与 assets/config.jsonc 注释一致）：
 * index = p === 100 ? 5 : Math.floor(p / 20)
 */
export function balanceEventIndex(p: number): number {
  if (p === 100) return 5;
  const i = Math.floor(p / 20);
  return i < 5 ? i : 4;
}

/** OpenCode 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
export const OPENCODE_QUOTA_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

/** 窗口展示名（联想框文案用）：5h = 5 小时额度窗口、周、月 */
export const WINDOW_LABELS = {
  rolling: '5h',
  weekly: '周',
  monthly: '月',
} as const;

export type OpenCodeWindow = keyof typeof OPENCODE_QUOTA_USD;

/** 一个窗口的额度概况（用于联想框一句话判定） */
export interface WindowUsage {
  label: string;
  percent: number;
  quotaUsd: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100 */
  remainingUsd: number;
  resetsAt?: string;
}

/** 取三窗口剩余额度最少的那个（最先到达满额度/最先用完） */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  if (v.kind !== 'opencode') return undefined;
  const windows: OpenCodeWindow[] = ['rolling', 'weekly', 'monthly'];
  const resets: Record<OpenCodeWindow, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  let best: WindowUsage | undefined;
  for (const w of windows) {
    const percent = v[w] ?? 0;
    const quota = OPENCODE_QUOTA_USD[w];
    const remaining = (quota * (100 - percent)) / 100;
    const cand: WindowUsage = {
      label: WINDOW_LABELS[w],
      percent,
      quotaUsd: quota,
      remainingUsd: remaining,
      resetsAt: resets[w],
    };
    if (best === undefined || remaining < best.remainingUsd) best = cand;
  }
  return best;
}

/**
 * 重置时间 → 相对文案（保留 1 位小数）：
 * - 距重置 ≥ 4 天 → 「N.x 天」
 * - 距重置 < 4 天 → 「N.x 小时」
 * - 已过重置点 → 「已重置」；未知时间 → 空串
 */
export function resetInText(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - Date.now();
  if (delta <= 0) return '已重置';
  const hoursF = delta / 3_600_000;
  if (hoursF >= 96) return (Math.round((hoursF / 24) * 10) / 10).toFixed(1) + ' 天';
  return Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1) + ' 小时';
}

/**
 * DeepSeek 峰谷计价档位（北京时间）：
 * - 高峰：工作日 9:00–12:00、14:00–18:00；其余为空闲（低谷）
 * - 周六/周日全天按低谷价计费（自 2026-08-23 起，周末不再区分峰谷）
 */
export type PricingTier = 'peak' | 'idle';

/** 当前时刻的 DeepSeek 计价档位（按北京时间 Asia/Shanghai，UTC+8 无夏令时） */
export function deepseekPricingTier(now: Date = new Date()): PricingTier {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23', // h23 避免午夜被格式化为 "24:00"
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle'; // 周末全天低谷
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}

// ---------- 富余额气泡展示视图（浏览器与桌面共用同一份内容/文案/数学） ----------

/** 气泡行数据：role 决定两端的样式类（浏览器 React span；桌面 DOM div）；tier 用于峰谷着色 */
export type BalanceBubbleRow =
  | { role: 'label'; text: string }
  | { role: 'sub'; text: string }
  | { role: 'error'; text: string }
  | { role: 'tier'; tier: PricingTier; text: string };

/** 不可用状态的气泡行（显式说明原因，绝不伪造数字）：
 *  - unsupported：服务商未登记查询接口（配置事实，不是故障）→ 报出 provider id，便于自查"当前到底是谁"
 *  - credential-missing：缺凭证 → 次要行放 host 报的凭证名（不含 message 时不留空行）
 *  - fetch-error：抓取失败 → 次要行放底层错误
 * 次要行为空的会被剔除：空 div 在气泡里会白占一行高度。 */
function unavailableRows(state: BalanceUnavailable): BalanceBubbleRow[] {
  const rows: BalanceBubbleRow[] =
    state.reason === 'unsupported'
      ? [
          { role: 'error', text: '当前服务商暂不支持余额查询' },
          { role: 'sub', text: '当前服务商：' + state.provider },
        ]
      : state.reason === 'credential-missing'
        ? [
            // host 的 message 本身已带「缺少凭证 X」前缀：这里只作次要行原样展示，不再加前缀
            // （曾经的「缺少凭证：缺少凭证 X」双重前缀）
            { role: 'error', text: '缺少余额查询凭证' },
            { role: 'sub', text: state.message ?? '' },
          ]
        : [
            { role: 'error', text: '余额查询失败' },
            { role: 'sub', text: state.message ?? '' },
          ];
  return rows.filter((r) => r.text !== '');
}

/**
 * 余额金额的展示文本：固定两位小数 + 千位分隔。
 *
 * 为什么不能直接打印 `state.total`：账号态余额是「充值 + 赠金」两个浮点数相加的结果，
 * 原样输出会带上浮点长尾（实测 `13.9468696`），在 max-width 受限的气泡里偏长且不像金额；
 * 两位小数与鲸鱼挂件（dsh-whale-widget）同口径。
 *
 * 解析失败（空值/非数字）原样回落，绝不把已有内容吞成 '-'。
 */
export function formatBalanceText(value: string | number | undefined | null): string {
  if (value === null || value === undefined || value === '') return '-';
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return String(value);
  const two = Math.round(n * 100) / 100;
  const [int, frac] = two.toFixed(2).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
}

/**
 * 把 BalanceState 渲染成气泡行数据（纯函数，不碰 DOM/React）：
 * - opencode：两行 —— 「5h/周/月」额度已用 N% + 重置倒计时
 * - deepseek：一行 —— 余额（峰/谷）¥x.xx（峰红/谷绿由 role:'tier' 表达）
 * - 无效：显式展示不可用原因（见 unavailableRows），绝不伪造数字
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (state.ok) {
    if (state.kind === 'opencode') {
      const w = urgentWindow(state);
      if (w) {
        const reset = resetInText(w.resetsAt);
        const rows: BalanceBubbleRow[] = [
          { role: 'label', text: w.label + '额度已用 ' + Math.round(w.percent) + '%' },
          { role: 'sub', text: reset ? reset + '重置' : '已重置' },
        ];
        return rows;
      }
      return [{ role: 'label', text: '额度数据不可用' }];
    }
    const tier = deepseekPricingTier();
    return [
      { role: 'label', text: '余额（' },
      { role: 'tier', tier, text: tier === 'peak' ? '峰' : '谷' },
      { role: 'label', text: '）¥' + formatBalanceText(state.total) },
    ];
  }
  return unavailableRows(state);
}

/** 非 ok 状态「弹不弹文字说明气泡」的判定结果 */
export interface BalanceNoticeDecision {
  /** true = 本次应弹气泡（文字说明）；false = 静默（同一原因已提示过，且非显式请求） */
  show: boolean;
  /** 本次提示的原因标识（形如 `unsupported:commandcode`；ok 状态为 null）：调用方存下，供下次比较 */
  key: string | null;
}

/**
 * 余额不可用时是否弹气泡（浏览器 overlay 与桌面外壳共用同一份判定——两端各写一份必然漂移）：
 * - 显式请求（`/balance` 命令、桌面「查看余额」菜单）：一律弹——用户问了就该有答复，包括"不支持"这件事；
 * - 自动轮询：只在原因（含服务商）**变化**时弹一次（首次检测到也算变化），避免每 30 分钟反复刷同一句话。
 * 判定纯粹基于传入的 lastKey，不持有状态；调用方负责保存返回值里的 key。
 */
export function decideBalanceNotice(
  state: BalanceState,
  lastKey: string | null,
  explicit: boolean,
): BalanceNoticeDecision {
  if (state.ok) return { show: false, key: null };
  const key = state.reason + ':' + state.provider;
  return { show: explicit || key !== lastKey, key };
}
