import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createActionHistory,
  buildActionHistoryMenu,
  ACTION_HISTORY_LIMIT,
  formatActionHistoryTime,
} from './action-history';

function storage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}
const base = new Date(2026, 9, 19, 11, 0, 0).getTime();

test('recent actual actions retain timestamps, newest first, persisted and isolated by pet id', () => {
  const s = storage(),
    a = createActionHistory('main', s);
  a.record('吃早餐', base);
  a.record('涮火锅', base + 5000);
  assert.deepEqual(a.entries(), [
    { name: '涮火锅', at: base + 5000 },
    { name: '吃早餐', at: base },
  ]);
  assert.deepEqual(createActionHistory('main', s).entries(), a.entries());
  assert.deepEqual(createActionHistory('other', s).entries(), []);
  assert.equal(s.map.size, 1);
});

test('bounded to latest 100, returned snapshots cannot mutate retained entries', () => {
  const s = storage(),
    h = createActionHistory('main', s);
  for (let i = 0; i < 150; i++) h.record('动作' + i, base + i * 2000);
  assert.equal(h.entries().length, ACTION_HISTORY_LIMIT);
  assert.equal(h.entries()[ACTION_HISTORY_LIMIT - 1]?.name, '动作50');
  const entries = h.entries();
  entries[0].name = 'changed';
  entries.pop();
  assert.equal(h.entries()[0].name, '动作149');
  assert.equal(JSON.parse([...s.map.values()][0]).length, 100);
});

test('real rapid replays and different actions are all retained', () => {
  const h = createActionHistory('main', null);
  h.record('吃早餐', base);
  h.record('吃早餐', base + 100);
  h.record('吃早餐', base + 2000);
  h.record('待机', base + 2001);
  assert.equal(h.entries().length, 4);
});

test('bad storage and unavailable storage fall back to live memory without breaking playback', () => {
  const h = createActionHistory('main', {
    getItem() {
      throw Error('disabled');
    },
    setItem() {
      throw Error('full');
    },
  });
  assert.doesNotThrow(() => h.record('吃午餐', base));
  assert.equal(h.entries()[0].name, '吃午餐');
  const corrupt = createActionHistory('main', { getItem: () => '{invalid', setItem() {} });
  assert.deepEqual(corrupt.entries(), []);
  assert.doesNotThrow(() => createActionHistory('main'));
});

test('malformed, huge, nonfinite and out-of-range input does not survive validation', () => {
  const s = storage();
  s.setItem(
    'dsh-pet:action-history:v1:main',
    JSON.stringify([null, {}, { name: 'ok', at: base }, { name: '', at: base }, { name: 'future', at: 9e15 }]),
  );
  const h = createActionHistory('main', s);
  assert.deepEqual(h.entries(), [{ name: 'ok', at: base }]);
  for (const n of [NaN, Infinity, -1, 9e15, 1.5]) h.record('invalid', n);
  h.record('', base);
  h.record('  ', base);
  h.record('x'.repeat(201), base);
  assert.equal(h.entries().length, 1);
  const huge = createActionHistory('main', { getItem: () => ' '.repeat(100001), setItem() {} });
  assert.deepEqual(huge.entries(), []);
});

test('history branch always available; items are read-only and never action/anim commands', () => {
  const empty = buildActionHistoryMenu([])[0];
  assert.equal(empty.label, '动作历史');
  assert.ok('children' in empty && empty.children[0].label.includes('暂无记录'));
  const tree = buildActionHistoryMenu([{ name: '涮火锅', at: base }])[0];
  assert.ok('children' in tree);
  const row = tree.children[0];
  assert.ok('disabled' in row && row.disabled);
  assert.ok(row.label.includes('10-19 11:00:00') && row.label.includes('涮火锅'));
  assert.ok(!('anim' in row) && !('action' in row));
  assert.equal(formatActionHistoryTime(base), '2026-10-19 11:00:00');
});
