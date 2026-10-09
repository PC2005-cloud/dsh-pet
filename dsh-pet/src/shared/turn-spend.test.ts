import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSpendBubble, spendBubblePlacement, type SpendPayload } from './turn-spend.ts';

for (const subscribed of [false, true])
  test('气泡生命周期及统一状态订阅：' + subscribed, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const nodes: Array<{ style: { cssText: string; display: string }; textContent: string; removed: boolean }> = [];
    const listeners = new Map<string, () => void>();
    const oldDocument = globalThis.document;
    const oldFetch = globalThis.fetch;
    globalThis.document = {
      createElement: () => {
        const node = {
          style: { cssText: '', display: 'none' },
          textContent: '',
          removed: false,
          setAttribute() {},
          getBoundingClientRect: () => ({ width: 180, height: 75 }),
          append() {},
          remove() {
            this.removed = true;
          },
        };
        nodes.push(node);
        return node;
      },
    } as unknown as Document;
    let count = 1;
    let currency = 'CNY';
    let enabled = true;
    let fetches = 0;
    let receive: ((data: SpendPayload) => void) | undefined;
    const payload = () => ({
      scope: 'A',
      enabled,
      spend: {
        count,
        amount: currency === 'CNY' ? 0.01234 : 0.001851,
        currency: currency as 'CNY' | 'USD',
        at: Date.now(),
      },
    });
    globalThis.fetch = async () => {
      fetches++;
      return { ok: true, json: async () => payload() } as Response;
    };
    t.after(() => {
      globalThis.document = oldDocument;
      globalThis.fetch = oldFetch;
    });
    const root = {
      appendChild() {},
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 200, top: 100 }),
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as HTMLElement;
    const stop = startSpendBubble(
      root,
      '/turn-spend?sessionId=A',
      462,
      'dsh-pet-bubble',
      () => ({
        x: 0,
        y: 0,
        w: 1200,
        h: 800,
      }),
      subscribed
        ? (callback) => {
            receive = callback;
            return () => {
              receive = undefined;
            };
          }
        : undefined,
    );
    const flush = async () => {
      receive?.(payload());
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };
    await flush();
    assert.equal(nodes[0].style.display, 'none');
    count++;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(nodes[0].style.display, 'block');
    assert.equal(nodes[2].textContent, 'CNY 0.0123');
    currency = 'USD';
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(nodes[2].textContent, 'USD 0.0019');
    assert.equal(nodes[0].style.display, 'block');
    t.mock.timers.tick(4000);
    await flush();
    assert.equal(nodes[0].style.display, 'none');
    currency = 'CNY';
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(nodes[0].style.display, 'none', '切换币种不重放已消失的气泡');
    count++;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(nodes[0].style.display, 'block');
    enabled = false;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(nodes[0].style.display, 'none', '关闭后收起正在展示的气泡');
    count++;
    t.mock.timers.tick(1000);
    await flush();
    enabled = true;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(nodes[0].style.display, 'none', '重新开启不补播关闭期间的结果');
    count++;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(nodes[0].style.display, 'block', '开启后正常提示新轮次');
    listeners.get('pointermove')!();
    assert.equal(nodes[0].style.display, 'none');
    if (subscribed) assert.equal(fetches, 0, '统一状态订阅不创建额外轮询');
    stop();
    assert.equal(nodes[0].removed, true);
    assert.equal(listeners.size, 0);
  });

test('费用气泡侧面定位：左右屏边、桌面局部可视区及窄屏', () => {
  const bounds = { x: 8, y: 8, w: 984, h: 784 };
  const body = { x: 400, y: 200, w: 160, h: 220 };
  assert.equal(spendBubblePlacement(body, bounds, 180, 75, 12).side, 'right');
  const right = spendBubblePlacement({ ...body, x: 820 }, bounds, 180, 75, 12);
  assert.equal(right.side, 'left');
  assert.equal(right.x + right.w, 808);
  const left = spendBubblePlacement({ ...body, x: 8 }, bounds, 180, 75, 12);
  assert.equal(left.side, 'right');
  assert.equal(left.x, 180);
  const desktop = spendBubblePlacement(
    { x: 375, y: 100, w: 170, h: 200 },
    { x: 200, y: 0, w: 350, h: 400 },
    180,
    75,
    12,
  );
  assert.equal(desktop.side, 'left');
  assert.equal(desktop.x, 200);
  assert.equal(desktop.w, 163);
  const bottom = spendBubblePlacement({ ...body, y: 760 }, bounds, 180, 75, 12);
  assert.equal(bottom.y, 717);
});
