import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPetSize, readPetSize, savePetSize } from './resize';

function storage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

test('size clamp handles bounds, rounding and nonfinite input', () => {
  assert.equal(clampPetSize(0), 120);
  assert.equal(clampPetSize(9999), 1200);
  assert.equal(clampPetSize(462.6), 463);
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(clampPetSize(value), 120);
});

test('local sizes are isolated by pet and configured base size', () => {
  const s = storage();
  assert.equal(readPetSize('main', 462, s), 462);
  savePetSize('main', 462, 600, s);
  assert.equal(readPetSize('main', 462, s), 600);
  assert.equal(readPetSize('other', 462, s), 462);
  assert.equal(readPetSize('main', 500, s), 500);
  savePetSize('main', 462, 2000, s);
  assert.equal(readPetSize('main', 462, s), 1200);
  savePetSize('main', 462, NaN, s);
  assert.equal(readPetSize('main', 462, s), 1200);
});

test('corrupt or denied storage does not break pet initialization or resizing', () => {
  for (const raw of ['', ' ', 'bad', 'NaN', 'Infinity', '0', '119', '1201']) {
    assert.equal(readPetSize('main', 462, { getItem: () => raw, setItem() {} }), 462);
  }
  const denied = {
    getItem(): string | null {
      throw Error('denied');
    },
    setItem() {
      throw Error('full');
    },
  };
  assert.equal(readPetSize('main', 462, denied), 462);
  assert.doesNotThrow(() => savePetSize('main', 462, 600, denied));
  assert.equal(readPetSize('main', 462, null), 462);
  assert.doesNotThrow(() => savePetSize('main', 462, 600, null));
});
