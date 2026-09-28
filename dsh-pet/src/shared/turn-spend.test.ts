import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSpendBubble } from './turn-spend.ts';

test('气泡首次不重放、5 秒隐藏、鼠标移动收起、卸载清理', async (t) => {
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
  globalThis.fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        scope: 'A',
        spend: {
          count,
          amount: currency === 'CNY' ? 0.01234 : 0.001851,
          currency,
          at: Date.now(),
        },
      }),
    }) as Response;
  t.after(() => {
    globalThis.document = oldDocument;
    globalThis.fetch = oldFetch;
  });
  const root = {
    appendChild() {},
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as HTMLElement;
  const stop = startSpendBubble(root, '/turn-spend?sessionId=A', 462);
  const flush = async () => {
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
  listeners.get('pointermove')!();
  assert.equal(nodes[0].style.display, 'none');
  stop();
  assert.equal(nodes[0].removed, true);
  assert.equal(listeners.size, 0);
});
