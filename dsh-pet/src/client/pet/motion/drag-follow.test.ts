/**
 * 拖拽跟随（src/client/pet/motion/drag-follow.ts）的契约测试：默认走弹簧所以一帧追不到目标；
 * physics.dragSpring 为 false（或缺键的相反面）时每帧直接贴住目标；stop 之后迟到的帧不再写样式。
 * 用假 rAF / performance.now 驱动，结果由包围盒与写入的 style 断言。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createDragFollow, type DragFollowDeps } from './drag-follow.ts';
import type { BoxPoint } from './geometry.ts';

/** 假根节点：只留被写的四个 style 字段。 */
function fakeRoot() {
  return { style: { left: '', top: '', right: '', bottom: '' } } as unknown as HTMLDivElement;
}

/** 装假时钟与 rAF。 */
function withFakeFrames() {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const previousNow = performance.now;
  let now = 0;
  let pending: Array<{ id: number; cb: () => void }> = [];
  let seq = 0;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => {
    const id = ++seq;
    pending.push({ id, cb });
    return id;
  };
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: number) => {
    pending = pending.filter((entry) => entry.id !== id);
  };
  performance.now = () => now;
  return {
    tick(ms: number): void {
      now += ms;
      const due = pending;
      pending = [];
      for (const entry of due) entry.cb();
    },
    get queued(): number {
      return pending.length;
    },
    restore(): void {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = previousRaf;
      (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = previousCancel;
      performance.now = previousNow;
    },
  };
}

/** 造一套依赖：盒子从原点出发，物理参数按用例覆盖。 */
function harness(physics: { throwPower: number; dragSpring?: boolean }) {
  const root = fakeRoot();
  let box: BoxPoint | null = { x: 0, y: 0 };
  const deps: DragFollowDeps = {
    card: () => ({
      box: () => box,
      setBox: (next) => {
        box = next;
      },
      physics,
    }),
  };
  return {
    root,
    deps,
    get box() {
      return box;
    },
  };
}

describe('createDragFollow —— 拖拽跟随', () => {
  test('缺键默认弹簧：一帧只追到途中，不是直接到位', () => {
    const frames = withFakeFrames();
    try {
      const h = harness({ throwPower: 1 });
      const follow = createDragFollow(h.deps);
      follow.aim({ x: 100, y: 50 });
      follow.start(h.root);
      frames.tick(16);
      assert.ok(h.box !== null && h.box.x > 0, '应该已经动了一点');
      assert.ok(h.box !== null && h.box.x < 100, '一帧追不到目标，这就是跟手延迟');
      assert.ok(frames.queued > 0, '弹簧模式继续排帧');
    } finally {
      frames.restore();
    }
  });

  test('关闭弹簧：一帧直接贴住目标并写 DOM', () => {
    const frames = withFakeFrames();
    try {
      const h = harness({ throwPower: 1, dragSpring: false });
      const follow = createDragFollow(h.deps);
      follow.aim({ x: 100, y: 50 });
      follow.start(h.root);
      frames.tick(16);
      assert.deepEqual(h.box, { x: 100, y: 50 }, '刚性模式目标即位置');
      assert.equal(h.root.style.left, '100px');
      assert.equal(h.root.style.top, '50px');
      assert.equal(h.root.style.right, 'auto');
      assert.equal(h.root.style.bottom, 'auto');
    } finally {
      frames.restore();
    }
  });

  test('关闭弹簧：目标移动后下一帧立刻跟上，不留残余速度', () => {
    const frames = withFakeFrames();
    try {
      const h = harness({ throwPower: 1, dragSpring: false });
      const follow = createDragFollow(h.deps);
      follow.aim({ x: 100, y: 50 });
      follow.start(h.root);
      frames.tick(16);
      follow.aim({ x: 0, y: 0 });
      frames.tick(16);
      assert.deepEqual(h.box, { x: 0, y: 0 }, '反向也不该有惯性冲过目标');
    } finally {
      frames.restore();
    }
  });

  test('stop 之后迟到的帧不再写样式', () => {
    const frames = withFakeFrames();
    try {
      const h = harness({ throwPower: 1 });
      const follow = createDragFollow(h.deps);
      follow.aim({ x: 100, y: 50 });
      follow.start(h.root);
      frames.tick(16);
      const frozen = h.root.style.left;
      follow.stop();
      frames.tick(200);
      assert.equal(h.root.style.left, frozen, '停止后不再写');
      assert.equal(frames.queued, 0);
    } finally {
      frames.restore();
    }
  });
});
