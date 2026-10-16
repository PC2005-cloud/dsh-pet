/**
 * 余额「不可用」路径的契约测试：**必须有可见反馈**，且两端（浏览器 overlay / 桌面外壳）只走一份判定。
 *
 * 背景：`/dsh-pet-7340/balance` 对未登记的服务商返回 `{ ok:false, reason:'unsupported' }`（HTTP 200），
 * 客户端原本在渲染处硬性要求 `balance.ok`，且气泡只由「拉取成功」的 tick 驱动——于是未登记的服务商
 * **页面上完全没有任何反应**：不播动画、不弹气泡、连 console 都特意不打。
 * 现在改为：不可用时弹「文字说明」气泡；弹不弹由 src/shared 的 decideBalanceNotice 统一判定
 * （显式请求必弹；自动轮询仅在原因变化时弹一次），两端各自只负责把行数据画出来。
 *
 * 本文件把四件事钉住：
 *   ① 不可用状态的文案（含 provider/凭证名，且不留空行、不出现双重「缺少凭证」前缀）；
 *   ② 弹窗判定（显式 vs 自动、原因变化、ok 状态清零）；
 *   ③ commandcode 的三窗口（cap 参与「最紧迫窗口」判定、无窗口限制时不补 0）与 opencode 同一套口径；
 *   ④ 源码级守卫——客户端渲染不得再要求 balance.ok（有 React/DOM 依赖，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  balanceBubbleView,
  balancePercent,
  decideBalanceNotice,
  toBalanceState,
  urgentWindow,
  type BalanceState,
  type BalanceView,
} from './balance.ts';

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 一次「自动轮询」后存档的提示 key（等价于调用方存下的 lastKey） */
const rememberedKey = (state: BalanceState): string | null => decideBalanceNotice(state, null, false).key;

const unsupported: BalanceState = { provider: 'unregistered-provider', ok: false, reason: 'unsupported' };

describe('balanceBubbleView —— 不可用状态必须给出可读的文字说明', () => {
  test('unsupported：报出「不支持」+ 当前服务商 id（便于自查到底是谁）', () => {
    assert.deepEqual(balanceBubbleView(unsupported), [
      { role: 'error', text: '当前服务商暂不支持余额查询' },
      { role: 'sub', text: '当前服务商：unregistered-provider' },
    ]);
  });

  test('credential-missing：host 的 message 已带前缀，不再叠加（无双重「缺少凭证」）', () => {
    const rows = balanceBubbleView({
      provider: 'deepseek-official',
      ok: false,
      reason: 'credential-missing',
      message: '缺少凭证 DEEPSEEK_API_KEY',
    });
    assert.deepEqual(rows, [
      { role: 'error', text: '缺少余额查询凭证' },
      { role: 'sub', text: '缺少凭证 DEEPSEEK_API_KEY' },
    ]);
    assert.equal(
      rows.filter((r) => r.text.includes('缺少凭证')).length,
      1,
      '「缺少凭证」只应出现一次（曾经是「缺少凭证：缺少凭证 X」）',
    );
  });

  test('fetch-error：主行固定文案 + 次要行为底层错误；message 缺失时不留空行', () => {
    assert.deepEqual(
      balanceBubbleView({ provider: 'deepseek-official', ok: false, reason: 'fetch-error', message: 'HTTP 401' }),
      [
        { role: 'error', text: '余额查询失败' },
        { role: 'sub', text: 'HTTP 401' },
      ],
    );
    assert.deepEqual(balanceBubbleView({ provider: 'deepseek-official', ok: false, reason: 'fetch-error' }), [
      { role: 'error', text: '余额查询失败' },
    ]);
  });

  test('成功路径不受影响（opencode 两行 / deepseek 单行含峰谷档位）', () => {
    // 取三窗口里最紧迫（剩余最少）的那个：weekly 75% 剩余 7.5 USD 最少 → 「周额度已用 75%」
    const rows = balanceBubbleView({
      provider: 'opencode-go',
      ok: true,
      shape: 'windows',
      rolling: 10,
      rollingCapUsd: 12,
      weekly: 75,
      weeklyCapUsd: 30,
      monthly: 20,
      monthlyCapUsd: 60,
      rollingLabel: '5h',
    });
    assert.equal(rows[0]?.text, '周额度已用 75%');
    assert.equal(rows[1]?.role, 'sub');

    const ds = balanceBubbleView({
      provider: 'deepseek-official',
      ok: true,
      shape: 'money',
      total: '8.79',
      tier: 'idle',
    });
    assert.equal(ds[0]?.text, '余额（');
    assert.equal(ds[1]?.role, 'tier'); // 峰/谷由数据带出，这里只钉结构与金额
    assert.equal(ds[2]?.text, '）¥8.79');
  });

  test('money：服务商没给档位装饰时不编峰谷，退化成「余额 ¥x.xx」', () => {
    const rows = balanceBubbleView({
      provider: 'some-wallet',
      ok: true,
      shape: 'money',
      currency: 'CNY',
      total: '8.79',
    });
    assert.deepEqual(rows, [{ role: 'label', text: '余额 ¥8.79' }]);
  });

  test('windows：滚动窗展示名由数据带出，缺省回落 5h', () => {
    const base = {
      provider: 'some-windows',
      shape: 'windows' as const,
      ok: true as const,
      rolling: 10,
      monthly: 1,
      monthlyResetsAt: '2999-01-01T00:00:00.000Z',
    };
    assert.equal(urgentWindow(base)?.label, '5h', '缺 rollingLabel → 回落 5h');
    assert.equal(urgentWindow({ ...base, rollingLabel: '24h' })?.label, '24h', '数据自报的窗口名优先');
  });

  test('deepseek-account 与 deepseek-official 气泡完全同构，只有币种符号按 currency 变', () => {
    // 官方路由：CNY → ¥（现有行为，逐字不变）
    const official = balanceBubbleView({
      provider: 'deepseek-official',
      ok: true,
      shape: 'money',
      total: '8.79',
      tier: 'idle',
    });
    // 账号路由：同一 shape、同一结构
    const account = balanceBubbleView({
      provider: 'deepseek-account',
      ok: true,
      shape: 'money',
      currency: 'CNY',
      total: '9.99',
      tier: 'idle',
    });
    assert.deepEqual(
      account.map((r) => r.role),
      official.map((r) => r.role),
      '两端的行结构必须逐位一致',
    );
    assert.equal(account[0]?.text, '余额（');
    assert.equal(account[2]?.text, '）¥9.99');

    // USD 钱包：同一位置换成 $（其余逐字不变）
    const usd = balanceBubbleView({
      provider: 'deepseek-account',
      ok: true,
      shape: 'money',
      currency: 'USD',
      total: '12.50',
      tier: 'idle',
    });
    assert.equal(usd[2]?.text, '）$12.50');
  });
});

describe('decideBalanceNotice —— 弹不弹文字说明（两端共用同一份判定）', () => {
  test('ok 状态：不弹，并把 key 清零（下次不可用视为新原因）', () => {
    assert.deepEqual(
      decideBalanceNotice(
        { provider: 'opencode-go', ok: true, shape: 'windows', rolling: 1, weekly: 2, monthly: 3 },
        'unsupported:unregistered-provider',
        false,
      ),
      { show: false, key: null },
    );
  });

  test('自动轮询：首次不可用要弹（lastKey=null），同一原因再来一次不弹', () => {
    const first = decideBalanceNotice(unsupported, null, false);
    assert.deepEqual(first, { show: true, key: 'unsupported:unregistered-provider' });
    assert.equal(decideBalanceNotice(unsupported, first.key, false).show, false, '同一原因不重复打扰');
  });

  test('自动轮询：原因变化再弹一次；换了另一个未登记的服务商也算变化', () => {
    assert.equal(decideBalanceNotice(unsupported, 'credential-missing:deepseek-official', false).show, true);
    assert.equal(
      decideBalanceNotice(
        { provider: 'openrouter', ok: false, reason: 'unsupported' },
        rememberedKey(unsupported),
        false,
      ).show,
      true,
    );
  });

  test('显式请求（/balance、桌面「查看余额」）：一律弹，不受去重影响', () => {
    assert.equal(decideBalanceNotice(unsupported, rememberedKey(unsupported), true).show, true);
  });
});

describe('源码守卫 —— 不可用状态不得再被静默丢掉', () => {
  test('浏览器 overlay：渲染处不许再要求 balance.ok，且由 noticeTick 驱动气泡、判定来自 shared', () => {
    const clientPet = readSource('../client/pet.ts');
    assert.ok(
      !/balance\.ok\s*&&\s*cfg\.balanceEnabled/.test(clientPet),
      '余额气泡不得再要求 balance.ok：那是「未登记服务商完全没反应」的根因，文字说明走同一个气泡',
    );
    assert.ok(/balanceNoticeTick/.test(clientPet), '容器必须把「该提示不可用原因」传给各宠物');
    assert.ok(/decideBalanceNotice/.test(clientPet), '弹窗判定必须来自 src/shared（两端同一份），不得各写一份');
  });

  test('桌面外壳：同一条判定 + 不可用也走气泡渲染（不再只写 console）', () => {
    const events = readSource('../../runtime/electron-helper/events.js');
    const sprite = readSource('../../runtime/electron-helper/sprite.js');
    assert.ok(
      /S\.decideBalanceNotice/.test(events),
      '桌面轮询必须调用同一份判定（shared-core 的 S.decideBalanceNotice）',
    );
    assert.ok(
      /showBalanceNotice/.test(events) && /showBalanceNotice/.test(sprite),
      '桌面必须有不可用的气泡渲染路径（showBalanceNotice），不能只 console.error',
    );
  });
});

describe('commandcode —— 三窗口用量走与 opencode 同一套展示口径', () => {
  test('toBalanceState：真实叶子 → 视图（cap 与重置时间一并带过来）', () => {
    const s = toBalanceState({
      ok: true,
      provider: 'commandcode',
      shape: 'windows',
      data: {
        monthly: 30,
        monthlyCapUsd: 70,
        monthlyResetsAt: '2026-10-13T01:01:27.000Z',
        rolling: 10,
        rollingCapUsd: 14,
        weekly: 75,
        weeklyCapUsd: 35,
      },
    });
    assert.ok(s && s.ok, 'commandcode 叶子必须解析出可用视图');
    if (!s || !s.ok) throw new Error('unreachable');
    assert.equal(s.shape, 'windows');
    assert.equal(s.monthly, 30);
    assert.equal(s.monthlyCapUsd, 70);
    assert.equal(s.monthlyResetsAt, '2026-10-13T01:01:27.000Z');
    assert.equal(s.rolling, 10);
    assert.equal(s.rollingCapUsd, 14);
    assert.equal(s.weekly, 75);
    assert.equal(s.weeklyCapUsd, 35);
    assert.equal(s.rollingResetsAt, undefined);
  });

  test('无窗口限制时只带月度窗（不补 0）：百分比与气泡都只说月度', () => {
    const view: BalanceView = {
      provider: 'commandcode',
      shape: 'windows',
      ok: true,
      monthly: 40,
      monthlyCapUsd: 70,
      monthlyResetsAt: '2999-01-01T00:00:00.000Z',
    };
    assert.equal(balancePercent(view), 40);
    const rows = balanceBubbleView(view);
    assert.equal(rows[0]?.text, '月额度已用 40%');
    assert.equal(rows[1]?.role, 'sub');
  });

  test('月度窗缺失 / 出现的字段非法 → null（不把 NaN 送进展示层）', () => {
    const leaf = (data: Record<string, unknown>) => ({
      ok: true,
      provider: 'commandcode',
      shape: 'windows',
      data,
    });
    assert.equal(toBalanceState(leaf({ rolling: 10 })), null, '缺月度窗 = 认不出响应');
    assert.equal(toBalanceState(leaf({ monthly: 'x' })), null);
    assert.equal(toBalanceState(leaf({ monthly: 10, rolling: 'x' })), null, '5h 窗出现但非法 → 整拍跳过');
    assert.equal(toBalanceState(leaf({ monthly: 10, monthlyCapUsd: 'x' })), null);
  });

  test('告急窗口：满额度齐全 → 绝对口径（剩余额度最少者），与 opencode 同一规则', () => {
    // 5h 剩 12.6 / 周 剩 8.75 / 月 剩 56（USD）→ 周最告急
    const rows = balanceBubbleView({
      provider: 'commandcode',
      shape: 'windows',
      ok: true,
      rolling: 10,
      rollingCapUsd: 14,
      weekly: 75,
      weeklyCapUsd: 35,
      monthly: 20,
      monthlyCapUsd: 70,
    });
    assert.equal(rows[0]?.text, '周额度已用 75%');
  });

  test('告急窗口：有窗口给不出满额度 → 退化为百分比口径（不硬比绝对剩余）', () => {
    // 月度池为 0（无额度、无消耗）时算不出 cap：此时 5h 10% 只剩 12.6 USD，比周 50% 的 17.5 USD 更"少"，
    // 但硬按绝对口径会报「5h 已用 10%」——规则是缺额度就走百分比：周 50% 更告急
    const rows = balanceBubbleView({
      provider: 'commandcode',
      shape: 'windows',
      ok: true,
      rolling: 10,
      rollingCapUsd: 14,
      weekly: 50,
      weeklyCapUsd: 35,
      monthly: 0,
    });
    assert.equal(rows[0]?.text, '周额度已用 50%');
  });

  test('balancePercent：三窗口取最大（档位动画与 opencode 同一条数学）', () => {
    assert.equal(
      balancePercent({ provider: 'commandcode', shape: 'windows', ok: true, rolling: 10, weekly: 75, monthly: 20 }),
      75,
    );
  });
});

describe('money —— 档位基准由数据带出（展示层不再写死任何服务商的额度）', () => {
  const view = (fullBalance?: string, total = '10.00'): BalanceView => ({
    provider: 'some-wallet',
    shape: 'money',
    ok: true,
    total,
    fullBalance,
  });

  test('基准 20：余额 20 → 0%，10 → 50%，0 → 100%，负数按已用完', () => {
    assert.equal(balancePercent(view('20', '20.00')), 0);
    assert.equal(balancePercent(view('20', '10.00')), 50);
    assert.equal(balancePercent(view('20', '0.00')), 100);
    assert.equal(balancePercent(view('20', '-0.02')), 100, '透支与 0 等价');
  });

  test('基准换一个值：同一余额算出不同百分比（证明基准真的来自数据）', () => {
    assert.equal(balancePercent(view('10', '5.00')), 50);
    assert.equal(balancePercent(view('100', '5.00')), 95);
  });

  test('没有基准 / 基准非法 / 金额非法 → undefined（不播档位动画，不替服务商猜）', () => {
    assert.equal(balancePercent(view(undefined)), undefined);
    assert.equal(balancePercent(view('0')), undefined);
    assert.equal(balancePercent(view('-5')), undefined);
    assert.equal(balancePercent(view('abc')), undefined);
    assert.equal(balancePercent(view('20', 'abc')), undefined);
  });

  test('toBalanceState：money 叶子带出基准与档位装饰；非法档位值视为没给', () => {
    const s = toBalanceState({
      ok: true,
      provider: 'some-wallet',
      shape: 'money',
      data: { currency: 'CNY', total: '8.79', fullBalance: '20', tier: 'peak' },
    });
    assert.ok(s && s.ok && s.shape === 'money');
    assert.equal(s.fullBalance, '20');
    assert.equal(s.tier, 'peak');
    const bad = toBalanceState({
      ok: true,
      provider: 'some-wallet',
      shape: 'money',
      data: { currency: 'CNY', total: '8.79', tier: '???', fullBalance: 20 },
    });
    assert.ok(bad && bad.ok && bad.shape === 'money');
    assert.equal(bad.tier, undefined, '不认识的档位值 → 不渲染峰谷');
    assert.equal(bad.fullBalance, undefined, '非字符串基准 → 视为没给');
  });
});
