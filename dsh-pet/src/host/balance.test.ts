/**
 * Command Code 用量的契约测试（provider id `commandcode`，控制面 `/alpha/*`）。
 *
 * 背景：Command Code 的用量在官方 CLI 使用的**未文档化控制面**路由上。插件把它的 5h / 周 / 月
 * 三个窗口映射成与 opencode 同构的三窗口用量，展示层因此共用同一套「取最紧迫窗口」逻辑。
 *
 * 本文件把三件事钉住：
 *   ① 真实 GOAT 报文的解析（含 `resetAt: 0` 这类占位值不得被当成 1970 年重置时间）；
 *   ② 失败口径：必填字段缺失/非法一律抛错（→ fetch-error），可选信息一律省略，绝不伪造 0；
 *   ③ 网络链路：四个接口的**顺序与 query**、Bearer 注入、凭证 ref、订阅接口失败不致命。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖；fetch 用手写 stub 顶替（只跑假数据，不联网）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchBalanceProvider,
  parseCommandCode,
  queryBalance,
  type BalanceResult,
  type CommandCodeUsage,
} from './balance.ts';

/** 真实 GOAT 套餐报文（字段名与取值照抄线上响应；`resetAt: 0` 是空闲窗口的占位值） */
const GOAT_CREDITS = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
    weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 },
  },
};
const GOAT_SUBSCRIPTION = {
  success: true,
  data: {
    status: 'active',
    currentPeriodStart: '2026-09-13T01:01:27.000Z',
    currentPeriodEnd: '2026-10-13T01:01:27.000Z',
    planId: 'individual-goat',
  },
};
const GOAT_SUMMARY = { totalCost: 0, periodBasis: 'billing-period' };

/** 取成功的 commandcode 数据；形状不对直接失败（省得每个用例都写一遍收窄） */
function dataOf(result: BalanceResult): CommandCodeUsage {
  if (!result.ok || result.kind !== 'commandcode') {
    assert.fail('期望 commandcode 的成功结果，实际：' + JSON.stringify(result));
  }
  return result.data;
}

/** 百分比是算出来的浮点数：按 1e-9 容差比 */
function assertClose(actual: number | undefined, expected: number, what: string): void {
  assert.equal(typeof actual, 'number', what + ' 应为数字');
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, what + '：期望 ' + expected + '，实际 ' + actual);
}

/** 极简 Response 替身：被测代码只用到 ok / status / json() */
function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** 装上 fetch stub（返回记录与卸载函数）；只按 URL 路由，不做真实网络 */
function stubFetch(handler: (url: string) => Response): {
  calls: string[];
  auths: (string | null)[];
  restore: () => void;
} {
  const calls: string[] = [];
  const auths: (string | null)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    auths.push(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return {
    calls,
    auths,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** 默认路由：四个控制面接口都给真实 GOAT 报文 */
function goatRoute(url: string): Response {
  if (url.includes('/alpha/whoami')) return res({ success: true, user: { id: 'u-1' }, org: { id: 'org-1' } });
  if (url.includes('/alpha/billing/credits')) return res(GOAT_CREDITS);
  if (url.includes('/alpha/billing/subscriptions')) return res(GOAT_SUBSCRIPTION);
  if (url.includes('/alpha/usage/summary')) return res(GOAT_SUMMARY);
  return res({}, 404);
}

describe('BALANCE_PROVIDERS —— commandcode 已登记（凭证 COMMANDCODE_API_KEY）', () => {
  test('provider id 命中 commandcode，展示类型是 commandcode，凭证 ref 是 COMMANDCODE_API_KEY', () => {
    assert.deepEqual(matchBalanceProvider('commandcode'), {
      ids: ['commandcode'],
      ref: 'COMMANDCODE_API_KEY',
      kind: 'commandcode',
    });
  });

  test('未登记的服务商仍然不命中（→ unsupported，不静默伪造 0）', () => {
    assert.equal(matchBalanceProvider('unregistered-provider'), undefined);
    assert.equal(matchBalanceProvider('opencode'), undefined, 'Zen 按量版（opencode）与 Go 是两个 id，前者无用量接口');
  });
});

describe('parseCommandCode —— 真实 GOAT 报文', () => {
  test('空闲窗口（resetAt: 0）：占位重置时间被丢弃，月度重置取订阅周期末', () => {
    const data = dataOf(parseCommandCode(GOAT_CREDITS, GOAT_SUBSCRIPTION, GOAT_SUMMARY, 'commandcode'));
    assert.equal(data.monthly, 0);
    assert.equal(data.monthlyCapUsd, 70, '月度池 = 当期消耗 0 + 剩余 70');
    assert.equal(data.monthlyResetsAt, '2026-10-13T01:01:27.000Z');
    assert.equal(data.rolling, 0);
    assert.equal(data.rollingCapUsd, 14);
    assert.equal(data.weekly, 0);
    assert.equal(data.weeklyCapUsd, 35);
    assert.equal(data.rollingResetsAt, undefined, 'resetAt: 0 是占位值，不能变成 1970 年重置时间');
    assert.equal(data.weeklyResetsAt, undefined);
  });

  test('有消耗：5h/周按 used/cap，月度按 消耗/(消耗+剩余)，字符串重置时间原样保留', () => {
    // windowLimits 嵌在 credits 内的旧变体：同样要认（实际报文在 credits 同级）
    const credits = {
      credits: {
        monthlyCredits: 12.5,
        purchasedCredits: 3,
        freeCredits: 0.5,
        windowLimits: {
          limited: true,
          fiveHour: { used: 4, cap: 14, resetAt: '2026-09-12T18:00:00.000Z' },
          weekly: { used: 12, cap: 40, resetAt: '2026-09-16T00:00:00.000Z' },
        },
      },
    };
    const subscription = { data: { currentPeriodEnd: '2026-10-01T00:00:00.000Z' } };
    const data = dataOf(parseCommandCode(credits, subscription, { totalCost: 7 }, 'commandcode'));

    assertClose(data.rolling, (4 / 14) * 100, '5h 窗口');
    assertClose(data.weekly, (12 / 40) * 100, '周窗口');
    assertClose(data.monthly, (7 / 23) * 100, '月度：消耗 7 /（7 + 16）');
    assert.equal(data.monthlyCapUsd, 23);
    assert.equal(data.rollingResetsAt, '2026-09-12T18:00:00.000Z');
    assert.equal(data.weeklyResetsAt, '2026-09-16T00:00:00.000Z');
    assert.equal(data.monthlyResetsAt, '2026-10-01T00:00:00.000Z');
  });

  test('无窗口限制（limited: false）：只有月度窗，不拿 5h/周充数', () => {
    const credits = {
      credits: { monthlyCredits: 0, purchasedCredits: 18.25, freeCredits: 0 },
      windowLimits: { limited: false },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.monthly, 0);
    assert.equal(data.monthlyCapUsd, 18.25);
    assert.equal(data.rolling, undefined);
    assert.equal(data.weekly, undefined);
    assert.equal(data.rollingCapUsd, undefined);
    assert.equal(data.weeklyCapUsd, undefined);
    assert.equal(data.monthlyResetsAt, undefined, '订阅缺失 → 没有重置倒计时，但不编一个出来');
  });

  test('cap 为 0 / used 缺失的窗口跳过，不影响其余窗口', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 0 },
        weekly: { cap: 10 },
      },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 1 }, 'commandcode'));
    assert.equal(data.rolling, undefined, 'cap 为 0 的窗口不算（不是"已用 0%"）');
    assert.equal(data.weekly, undefined, 'used 缺失的窗口不算');
  });

  test('数字重置时间：秒级/毫秒级时间戳都转成 ISO', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 10, resetAt: 1790000000 },
        weekly: { used: 1, cap: 10, resetAt: 1790000000000 },
      },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.rollingResetsAt, new Date(1790000000 * 1000).toISOString());
    assert.equal(data.weeklyResetsAt, new Date(1790000000000).toISOString());
  });

  test('负用量（无意义数据）按「未消耗」读：不产生负百分比（档位索引会越界）', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { limited: true, fiveHour: { used: -3, cap: 14 } },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.rolling, 0);
  });
});

describe('parseCommandCode —— 必填缺失/非法一律抛错（绝不伪造 0）', () => {
  test('缺少 credits → 抛错', () => {
    assert.throws(() => parseCommandCode({}, undefined, { totalCost: 0 }, 'commandcode'), /credits/);
  });

  test('credits 里三个额度字段全缺 → 抛错（否则分母当 0 会算出「已用 100%」）', () => {
    assert.throws(() => parseCommandCode({ credits: {} }, undefined, { totalCost: 0 }, 'commandcode'), /额度字段/);
  });

  test('缺少 / 非法 totalCost → 抛错', () => {
    const credits = { credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 } };
    assert.throws(() => parseCommandCode(credits, undefined, {}, 'commandcode'), /totalCost/);
    assert.throws(() => parseCommandCode(credits, undefined, { totalCost: 'abc' }, 'commandcode'), /totalCost/);
  });

  test('订阅接口的响应非法不是致命错（可选信息：只影响月度重置倒计时）', () => {
    const credits = { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } };
    for (const subscription of [undefined, {}, { data: null }, { data: { currentPeriodEnd: 0 } }]) {
      const data = dataOf(parseCommandCode(credits, subscription, { totalCost: 0 }, 'commandcode'));
      assert.equal(data.monthlyResetsAt, undefined);
    }
  });
});

describe('queryBalance —— 网络链路（fetch stub）', () => {
  test('四个接口按序请求，Bearer 注入，orgId / since 正确回填', async () => {
    const stub = stubFetch(goatRoute);
    const refs: string[] = [];
    try {
      const result = await queryBalance('commandcode', async (ref) => {
        refs.push(ref);
        return 'k-123';
      });
      assert.equal(result.ok, true);
      assert.deepEqual(stub.calls, [
        'https://api.commandcode.ai/alpha/whoami?limits=1',
        'https://api.commandcode.ai/alpha/billing/credits?orgId=org-1',
        'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-1',
        'https://api.commandcode.ai/alpha/usage/summary?since=2026-09-13T01%3A01%3A27.000Z&orgId=org-1',
      ]);
      assert.deepEqual([...new Set(stub.auths)], ['Bearer k-123']);
      assert.deepEqual(refs, ['COMMANDCODE_API_KEY']);
    } finally {
      stub.restore();
    }
  });

  test('whoami 里没有 org → 后续请求不带 orgId（不硬塞空值）', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/alpha/whoami')) return res({ success: true, user: { id: 'u-1' } });
      return goatRoute(url);
    });
    try {
      const result = await queryBalance('commandcode', async () => 'k');
      assert.equal(result.ok, true);
      assert.equal(stub.calls[1], 'https://api.commandcode.ai/alpha/billing/credits');
      assert.equal(stub.calls[2], 'https://api.commandcode.ai/alpha/billing/subscriptions');
      assert.equal(
        stub.calls[3],
        'https://api.commandcode.ai/alpha/usage/summary?since=2026-09-13T01%3A01%3A27.000Z',
        'orgId 没有就不带，但订阅拿到的当期起始时间照常带（since）',
      );
    } finally {
      stub.restore();
    }
  });

  test('订阅接口失败（按量付费账号可能没有订阅）→ 仍然成功，只是没有重置倒计时', async () => {
    const stub = stubFetch((url) => (url.includes('/alpha/billing/subscriptions') ? res({}, 500) : goatRoute(url)));
    try {
      const result = await queryBalance('commandcode', async () => 'k');
      const data = dataOf(result);
      assert.equal(data.monthlyResetsAt, undefined);
      assert.equal(data.rollingCapUsd, 14, '三个窗口的百分比与额度一个都不少');
      assert.equal(
        stub.calls[3],
        'https://api.commandcode.ai/alpha/usage/summary?orgId=org-1',
        '没拿到当期起始时间就不带 since（默认区间由服务端决定，插件不猜）',
      );
    } finally {
      stub.restore();
    }
  });

  test('401 → fetch-error，错误信息带接口路径与状态码（不退化成「未支持」）', async () => {
    const stub = stubFetch(() => res({ error: { code: 'UNAUTHORIZED' } }, 401));
    try {
      assert.deepEqual(await queryBalance('commandcode', async () => 'bad-key'), {
        ok: false,
        provider: 'commandcode',
        reason: 'fetch-error',
        message: 'commandcode /alpha/whoami HTTP 401',
      });
    } finally {
      stub.restore();
    }
  });

  test('缺凭证 → credential-missing，且一个请求都不发', async () => {
    const stub = stubFetch(goatRoute);
    try {
      assert.deepEqual(await queryBalance('commandcode', async () => undefined), {
        ok: false,
        provider: 'commandcode',
        reason: 'credential-missing',
        message: '缺少凭证 COMMANDCODE_API_KEY',
      });
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('未登记的服务商 → unsupported，且一个请求都不发', async () => {
    const stub = stubFetch(goatRoute);
    let asked = 0;
    try {
      assert.deepEqual(
        await queryBalance('unregistered-provider', async () => {
          asked += 1;
          return 'k';
        }),
        { ok: false, provider: 'unregistered-provider', reason: 'unsupported' },
      );
      assert.equal(asked, 0, '未登记的服务商连凭证都不该去解析');
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });
});
