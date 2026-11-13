/**
 * 有丝分裂的容器状态（src/client/pet/mitosis/use-mitosis.ts）的契约测试。
 *
 * 四条契约：
 *   1. 连点够 5 下才生，每生一次总数翻倍，且封顶后不再增殖；
 *   2. 分身身份键只增不复用，删除与清除都不碰本体那一只；
 *   3. 切模式顺手把超出新上限的分身从尾部收掉，模式写进 sessionStorage；
 *   4. 存储不可用（隐私模式）只是不落盘，分裂照常。
 *
 * 不引 jsdom：用一个按调用序发放槽位的假 runtime，`step()` 相当于 React 重渲染一次。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createUseMitosis } from './use-mitosis.ts';
import { MITOSIS_CAP, MITOSIS_TAP_TIMES } from './rules.ts';
import type { Mitosis } from './use-mitosis.ts';

/** 按调用序发放槽位的极简 hook 运行器：够跑 useState/useRef，不模拟并发。 */
function makeRuntime() {
  const slots: unknown[] = [];
  let cursor = 0;
  const useState = <T>(init: T): [T, (next: T | ((prev: T) => T)) => void] => {
    const at = cursor++;
    if (slots.length <= at) slots.push(init);
    const set = (next: T | ((prev: T) => T)): void => {
      slots[at] = typeof next === 'function' ? (next as (prev: T) => T)(slots[at] as T) : next;
    };
    return [slots[at] as T, set];
  };
  const useRef = <T>(init: T) => {
    const at = cursor++;
    if (slots.length <= at) slots.push({ current: init });
    return slots[at] as { current: T };
  };
  const useMitosis = createUseMitosis({ useState, useRef });
  /** 假组件体：游标复位后跑一遍 hook，`render()` 就是 React 的那一帧。 */
  function MitosisProbe(): Mitosis {
    cursor = 0;
    return useMitosis();
  }
  return { render: MitosisProbe, useState, useRef };
}

/** 连点够一次分裂；每次都重渲染，等价于「点完这一下 React 又排了一帧」。 */
function tapUntilSplit(rt: ReturnType<typeof makeRuntime>, petId: string, at = 0): Mitosis {
  let mitosis = rt.render();
  for (let i = 0; i < MITOSIS_TAP_TIMES; i++) {
    mitosis.tap(petId, at + i * 10);
    mitosis = rt.render();
  }
  return mitosis;
}

/** 一份可替换的 sessionStorage 桩：`blocked` 模拟隐私模式下一碰就抛。 */
function stubStorage(): { store: Map<string, string>; blocked: { value: boolean }; restore: () => void } {
  const store = new Map<string, string>();
  const blocked = { value: false };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => {
        if (blocked.value) throw new Error('SecurityError');
        return store.has(key) ? (store.get(key) as string) : null;
      },
      setItem: (key: string, value: string) => {
        if (blocked.value) throw new Error('QuotaExceededError');
        store.set(key, value);
      },
    },
  });
  return {
    blocked,
    restore: () => {
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
      else Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    },
    store,
  };
}

describe('useMitosis —— 连点与名单', () => {
  test('第 5 下生 1 只，再 5 下生 2 只：现有总数翻倍', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      let mitosis = rt.render();
      for (let i = 0; i < MITOSIS_TAP_TIMES - 1; i++) {
        mitosis.tap('p1', i * 10);
        mitosis = rt.render();
        assert.equal(mitosis.clones.length, 0, `第 ${i + 1} 下不该生`);
      }
      mitosis.tap('p1', 100);
      mitosis = rt.render();
      assert.equal(mitosis.clones.length, 1);
      mitosis = tapUntilSplit(rt, 'p1', 1000);
      assert.equal(mitosis.clones.length, 3, '总数 2 → 4，分身应是 3 只');
    } finally {
      storage.restore();
    }
  });

  test('慢慢点：跨窗口的 5 下不会凑成一次分裂', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      let mitosis = rt.render();
      for (let i = 0; i < MITOSIS_TAP_TIMES; i++) {
        mitosis.tap('p1', i * 5000);
        mitosis = rt.render();
      }
      assert.equal(mitosis.clones.length, 0);
    } finally {
      storage.restore();
    }
  });

  test('封顶：普通模式最多 63 只分身（含本体 64 只）', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      let mitosis = rt.render();
      for (let round = 0; round < 10; round++) {
        mitosis = tapUntilSplit(rt, 'p1', round * 100000);
      }
      assert.equal(mitosis.clones.length, MITOSIS_CAP.normal - 1);
    } finally {
      storage.restore();
    }
  });

  test('两只本体各生各的：名单按宠物 id 分组', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      const first = tapUntilSplit(rt, 'p1', 0);
      const second = tapUntilSplit(rt, 'p2', 100000);
      assert.equal(second.clonesOf('p1').length, 1);
      assert.equal(second.clonesOf('p2').length, 1);
      assert.equal(second.clones.length, 2, '平铺列表是两家的合计');
      assert.equal(first.clonesOf('p2').length, 0, '旧那一拍的视图不该看到后来者（只为说明返回值是当帧快照）');
    } finally {
      storage.restore();
    }
  });
});

describe('useMitosis —— 删除、清除与序号', () => {
  test('分身删自己：只掉那一只，本体的名单还在', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      let mitosis = tapUntilSplit(rt, 'p1');
      mitosis = tapUntilSplit(rt, 'p1', 10000);
      const [a, b, c] = mitosis.clonesOf('p1');
      assert.ok(a && b && c);
      mitosis.remove('p1', b.instanceKey);
      mitosis = rt.render();
      assert.deepEqual(
        mitosis.clonesOf('p1').map((x) => x.instanceKey),
        [a.instanceKey, c.instanceKey],
      );
    } finally {
      storage.restore();
    }
  });

  test('序号只增：清掉再生不会复用旧的身份键', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      let mitosis = tapUntilSplit(rt, 'p1');
      const before = mitosis.clonesOf('p1')[0]?.instanceKey;
      mitosis.clear('p1');
      mitosis = rt.render();
      assert.equal(mitosis.clonesOf('p1').length, 0);
      mitosis = tapUntilSplit(rt, 'p1', 10000);
      const after = mitosis.clonesOf('p1')[0]?.instanceKey;
      assert.notEqual(after, before, 'React key 复用会让旧卡片的物理状态跟着复活');
    } finally {
      storage.restore();
    }
  });

  test('清除只动自己那一组：别只本体的分身留着', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      tapUntilSplit(rt, 'p1', 0);
      let mitosis = tapUntilSplit(rt, 'p2', 100000);
      mitosis.clear('p1');
      mitosis = rt.render();
      assert.equal(mitosis.clonesOf('p1').length, 0);
      assert.equal(mitosis.clonesOf('p2').length, 1);
    } finally {
      storage.restore();
    }
  });
});

describe('useMitosis —— 模式与存储', () => {
  test('切到碰撞模式：超出 32 的分身从尾部收掉，模式落盘', () => {
    const storage = stubStorage();
    try {
      const rt = makeRuntime();
      let mitosis = rt.render();
      for (let round = 0; round < 10; round++) mitosis = tapUntilSplit(rt, 'p1', round * 100000);
      assert.equal(mitosis.clones.length, MITOSIS_CAP.normal - 1);
      mitosis.setMode('collide');
      mitosis = rt.render();
      assert.equal(mitosis.mode, 'collide');
      assert.equal(mitosis.clones.length, MITOSIS_CAP.collide - 1, '留的是编号最前的那些');
      assert.equal(mitosis.clones[MITOSIS_CAP.collide - 2]?.seq, MITOSIS_CAP.collide - 1);
      assert.equal(storage.store.get('dsh-pet/mitosisMode'), 'collide');
    } finally {
      storage.restore();
    }
  });

  test('挂载时读回本标签页存过的模式', () => {
    const storage = stubStorage();
    try {
      storage.store.set('dsh-pet/mitosisMode', 'collide');
      assert.equal(makeRuntime().render().mode, 'collide');
      storage.store.set('dsh-pet/mitosisMode', 'billiard');
      assert.equal(makeRuntime().render().mode, 'normal', '脏值回普通，不拿它当模式用');
    } finally {
      storage.restore();
    }
  });

  test('存储一碰就抛（隐私模式）：分裂与模式照常，只是不落盘', () => {
    const storage = stubStorage();
    storage.blocked.value = true;
    try {
      const rt = makeRuntime();
      let mitosis = rt.render();
      assert.equal(mitosis.mode, 'normal');
      mitosis = tapUntilSplit(rt, 'p1');
      assert.equal(mitosis.clones.length, 1);
      mitosis.setMode('collide');
      mitosis = rt.render();
      assert.equal(mitosis.mode, 'collide');
      assert.equal(storage.store.size, 0, '写失败不该冒出一份脏数据');
    } finally {
      storage.restore();
    }
  });
});
