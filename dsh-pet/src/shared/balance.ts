// 余额数据层与展示视图（src/shared 纯逻辑，浏览器 bundle 与桌面 shared-core 共用）：
// 解析 S 的余额叶子（host 的 BalanceResult）→ 客户端视图 → 档位计算 → 气泡行数据。
// 取数不在本模块：余额由 host 定时器刷新并写进 /state（两端共享同一份结果），本模块只做纯解析/展示。
// 不依赖 React/DOM；host/balance/ 的 BalanceResult 与本模块的 RawBalanceResult 同构（HTTP 契约两端
// 各自声明，host 无需 import 本目录——DSH 单文件加载约束）。
//
// **本模块不认识任何服务商**：只认叶子里的 `shape`（展示形态）与数据自带的业务事实
// （各窗口满额度、滚动窗时长、档位基准、峰谷档位）。服务商名字只用于日志与去重键。
// 加一个服务商只要落到 `windows` / `money` 之一，这里与两端展示层一行都不用改。

/** 余额叶子里的原始响应（与 host/balance/ 的 BalanceResult 同构；两端按此结构校验） */
export interface RawBalanceResult {
  ok: boolean;
  provider?: string;
  /** 展示形态（host 写叶子时带上）：windows = 三窗口用量，money = 账户金额 */
  shape?: 'windows' | 'money';
  reason?: string;
  message?: string;
  data?: {
    rolling?: unknown;
    weekly?: unknown;
    monthly?: unknown;
    rollingResetsAt?: unknown;
    weeklyResetsAt?: unknown;
    monthlyResetsAt?: unknown;
    rollingCapUsd?: unknown;
    weeklyCapUsd?: unknown;
    monthlyCapUsd?: unknown;
    rollingLabel?: unknown;
    currency?: unknown;
    total?: unknown;
    granted?: unknown;
    toppedUp?: unknown;
    fullBalance?: unknown;
    tier?: unknown;
  };
}

/** 计价档位装饰（气泡上的「峰/谷」）：由服务商算好后随数据带出，展示层原样渲染 */
export type PricingTier = 'peak' | 'idle';

/** 已解析的余额视图（展示 + 档位计算用） */
export interface BalanceView {
  provider: string;
  shape: 'windows' | 'money';
  ok: true;
  /**
   * 三窗口已用百分比（0-100 数字）+ 各自的重置时间。
   * `monthly` 必有（月度窗口是数据的底线）；`rolling` / `weekly` 可缺省 = 该服务商没有这个窗口。
   */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /**
   * 各窗口满额度（USD），由服务商随数据带出（opencode 是业务常量、commandcode 是接口回报）。
   * 用于「最紧迫窗口」的绝对口径；缺省 → 退化为百分比口径。展示层不再写死任何服务商的额度。
   */
  rollingCapUsd?: number;
  weeklyCapUsd?: number;
  monthlyCapUsd?: number;
  /** 滚动窗展示名（服务商自报，如 `5h`）；缺省回落 DEFAULT_ROLLING_LABEL */
  rollingLabel?: string;
  /** money：余额金额（字符串，与接口一致） */
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
  /**
   * money：档位基准（同 currency 单位）。余额 ≥ 该值视为未消耗。
   * 缺省 = 该服务商不给基准 → 不折算百分比、不播档位动画（不替它猜一个基准）。
   */
  fullBalance?: string;
  /** money：计价档位装饰；缺省 = 渲染成不带峰谷的「余额 ¥x.xx」 */
  tier?: PricingTier;
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
 * 可选数字：缺省 → undefined；出现但非法 → null（调用方据此整拍跳过——不把 NaN/字符串送进展示层）。
 */
function optNum(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * host 的余额原始响应（`BalanceResult`，经 `/state` 的 `sections.balance` 叶子送达）→ 客户端视图。
 *
 * 形状非法 / shape 不认识 → **null**（消费端跳过这一拍）——注意这里**不抛**：它跑在 1s 轮询里，
 * 抛异常会把整拍打断（其余叶子也跟着不渲染）。取数失败（HTTP/网络）不在这里发生：取数在 host，
 * 失败会以 `ok:false` 写进 S，由这里正常映射成"不可用"状态。
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

  if (r.shape === 'windows') {
    const monthly = optNum(d.monthly);
    const rolling = optNum(d.rolling);
    const weekly = optNum(d.weekly);
    const rollingCapUsd = optNum(d.rollingCapUsd);
    const weeklyCapUsd = optNum(d.weeklyCapUsd);
    const monthlyCapUsd = optNum(d.monthlyCapUsd);
    // 月度窗口是这份数据的底线：缺了/非法 = 认不出响应（滚动窗与周窗口、各窗口额度都是可选）
    if (monthly === undefined || monthly === null) return null;
    // 出现但非法（optNum 返回 null）→ 整拍跳过，不把坏数字送进展示层
    if (
      rolling === null ||
      weekly === null ||
      rollingCapUsd === null ||
      weeklyCapUsd === null ||
      monthlyCapUsd === null
    ) {
      return null;
    }
    return {
      provider,
      shape: 'windows',
      ok: true,
      rolling,
      weekly,
      monthly,
      rollingCapUsd,
      weeklyCapUsd,
      monthlyCapUsd,
      rollingLabel: typeof d.rollingLabel === 'string' && d.rollingLabel.length > 0 ? d.rollingLabel : undefined,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  if (r.shape === 'money') {
    return {
      provider,
      shape: 'money',
      ok: true,
      currency: typeof d.currency === 'string' ? d.currency : undefined,
      total: typeof d.total === 'string' ? d.total : undefined,
      granted: typeof d.granted === 'string' ? d.granted : undefined,
      toppedUp: typeof d.toppedUp === 'string' ? d.toppedUp : undefined,
      fullBalance: typeof d.fullBalance === 'string' ? d.fullBalance : undefined,
      tier: d.tier === 'peak' || d.tier === 'idle' ? d.tier : undefined,
    };
  }
  return null;
}

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
 * - windows：取三窗口最大（风险最高者为准）
 * - money：余额按**数据自带的基准**（`fullBalance`）折算（基准 20 → 余额 20 元 → 0%，10 元 → 50%，
 *   0 元 → 100%）。没有基准 → undefined（不播档位动画，不替服务商猜一个）
 */
export function balancePercent(v: BalanceView): number | undefined {
  if (v.shape === 'money') {
    const total = Number(v.total);
    const full = Number(v.fullBalance);
    if (!Number.isFinite(total)) return undefined; // 金额非法（非数字）：不触发（上层校验已兜底，此处双保险）
    if (!Number.isFinite(full) || full <= 0) return undefined; // 无基准：该服务商不给档位语义
    // 负数 = 透支，与 0 等价按「已用完」折算：-0.02 → 剩余 0 → 已用 100%（播「分文不剩」档）
    const remaining = (Math.max(0, total) / full) * 100; // 剩余百分比 0~100+
    return Math.max(0, Math.min(100, 100 - remaining)); // 折算为已用百分比
  }
  // windows：三窗口取最大（只有月窗口时就是它自己）
  return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
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

/** 窗口键（三种窗口类别，与服务商无关） */
export type WindowKey = 'rolling' | 'weekly' | 'monthly';

/**
 * 窗口展示名（联想框文案用）：周、月。
 * 滚动窗的时长是**服务商自己的业务事实**（如 5 小时），不走这张表，见 DEFAULT_ROLLING_LABEL。
 */
export const WINDOW_LABELS = {
  weekly: '周',
  monthly: '月',
} as const;

/**
 * 滚动窗展示名的兜底：服务商应随数据带 `rollingLabel`，缺省时才用它。
 * 之所以要有兜底：缺一个标签会让气泡出现空档，而 5h 是当前两个滚动窗口服务商的共同取值。
 */
export const DEFAULT_ROLLING_LABEL = '5h';

/** 一个窗口的额度概况（用于联想框一句话判定） */
export interface WindowUsage {
  label: string;
  percent: number;
  /** 满额度（USD），由服务商随数据带出；算不出时缺省 */
  quotaUsd?: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100；满额度未知时缺省 */
  remainingUsd?: number;
  resetsAt?: string;
}

/** 窗口展示名：滚动窗取服务商自报值（缺省 5h），周/月走固定表 */
function windowLabel(v: BalanceView, w: WindowKey): string {
  if (w === 'rolling') return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
  return WINDOW_LABELS[w];
}

/** 各窗口的满额度（USD）：全部来自数据（展示层不写死任何服务商的额度） */
function windowQuotas(v: BalanceView): Record<WindowKey, number | undefined> {
  return { rolling: v.rollingCapUsd, weekly: v.weeklyCapUsd, monthly: v.monthlyCapUsd };
}

/**
 * 取最先告急的一个窗口（所有 windows 形态的服务商共用同一套，无服务商判断）：
 * - 满额度齐全 → 绝对口径：剩余额度（USD）最少者；
 * - 有窗口给不出满额度 → 退化为相对口径：已用百分比最大者
 *   （两窗额度量级不同，缺一个还硬比绝对剩余会反直觉）。
 * 不存在的窗口直接跳过，不补 0。
 *
 * 绝对口径的副作用（刻意保留）：滚动窗额度最小，通常先报它；两端一致，完整读数见 tools/api-tester.html。
 */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  if (v.shape === 'money') return undefined;
  const quotas = windowQuotas(v);
  const resets: Record<WindowKey, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  const present = (['rolling', 'weekly', 'monthly'] as WindowKey[]).filter((w) => v[w] !== undefined);
  if (present.length === 0) return undefined;
  const allQuotas = present.every((w) => {
    const quota = quotas[w];
    return quota !== undefined && quota > 0;
  });

  let best: WindowUsage | undefined;
  for (const w of present) {
    const percent = v[w] ?? 0;
    const quota = quotas[w];
    const cand: WindowUsage = {
      label: windowLabel(v, w),
      percent,
      quotaUsd: quota,
      remainingUsd: allQuotas && quota !== undefined ? (quota * (100 - percent)) / 100 : undefined,
      resetsAt: resets[w],
    };
    if (best === undefined) {
      best = cand;
      continue;
    }
    const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
    if (moreUrgent) best = cand;
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
 * 把 BalanceState 渲染成气泡行数据（纯函数，不碰 DOM/React）：
 * - windows：两行 —— 「X额度已用 N%」+ 重置倒计时
 * - money：一行 —— 「余额（峰/谷）¥x.xx」（峰红/谷绿由 role:'tier' 表达）；
 *   服务商没给档位装饰时退化成「余额 ¥x.xx」，不替它编一个峰谷
 * - 无效：显式展示不可用原因（见 unavailableRows），绝不伪造数字
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (state.ok) {
    if (state.shape !== 'money') {
      // windows：三窗口中先告急的一个
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
    // money：币种符号由数据带出（CNY → ¥，USD → $）
    const symbol = state.currency === 'USD' ? '$' : '¥';
    const amount = symbol + (state.total ?? '-');
    // 档位装饰（峰/谷）只有提供该计价规则的服务商才有；没有就不加括号那一段
    if (!state.tier) return [{ role: 'label', text: '余额 ' + amount }];
    return [
      { role: 'label', text: '余额（' },
      { role: 'tier', tier: state.tier, text: state.tier === 'peak' ? '峰' : '谷' },
      { role: 'label', text: '）' + amount },
    ];
  }
  return unavailableRows(state);
}

/** 非 ok 状态「弹不弹文字说明气泡」的判定结果 */
export interface BalanceNoticeDecision {
  /** true = 本次应弹气泡（文字说明）；false = 静默（同一原因已提示过，且非显式请求） */
  show: boolean;
  /** 本次提示的原因标识（形如 `unsupported:unregistered-provider`；ok 状态为 null）：调用方存下，供下次比较 */
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
