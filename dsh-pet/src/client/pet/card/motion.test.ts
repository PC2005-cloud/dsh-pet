/** 运动装配的落位与重排契约：真实驱动配假 DOM、指针事件及可控帧时钟。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PHYSICS } from '../../../shared/physics/constants.ts';
import { derivePetMetrics, type Center } from '../motion/geometry.ts';
import { createCardMotion, type CardMotionRuntime } from './motion.ts';
import { createCardDrag } from './drag.ts';
import type { CardLive } from './live.ts';
import type { CardStateApi } from './state.ts';
import type { RuntimePet } from '../types.ts';
import type { PetCollisionSlot } from '../../../shared/physics.ts';
import type * as ReactNS from 'react';

/** 保留 ref，并在依赖变化与卸载时执行副作用清理。 */
function hookRuntime() {
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<{ deps?: ReactNS.DependencyList; cleanup?: () => void }> = [];
  let refIndex = 0;
  let effectIndex = 0;
  let pending: Array<() => void> = [];
  const runtime: CardMotionRuntime = {
    useRef: <T>(initial: T) => {
      const index = refIndex++;
      refs[index] ??= { current: initial };
      return refs[index] as ReactNS.MutableRefObject<T>;
    },
    useEffect: (effect, deps) => {
      const index = effectIndex++;
      const previous = effects[index];
      if (
        previous?.deps &&
        deps &&
        deps.length === previous.deps.length &&
        deps.every((dep, index) => Object.is(dep, previous.deps?.[index]))
      )
        return;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        effects[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    },
  };
  return {
    runtime,
    begin: () => {
      refIndex = 0;
      effectIndex = 0;
    },
    flush: () => {
      const due = pending;
      pending = [];
      due.forEach((effect) => effect());
    },
    unmount: () => {
      effects.forEach((effect) => effect.cleanup?.());
      effects.length = 0;
    },
  };
}

/** 安装视口、resize 监听与帧时钟；取消的回调仍可手动重放以验证迟到帧。 */
function browserEnvironment() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const previousNow = performance.now;
  const listeners = new Set<() => void>();
  const frames = new Map<number, () => void>();
  const canceled: Array<() => void> = [];
  let now = 100_000;
  let sequence = 0;
  const viewport = {
    innerWidth: 1000,
    innerHeight: 600,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'resize') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'resize') listeners.delete(listener);
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: viewport });
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++sequence;
    frames.set(id, () => callback(now));
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    const callback = frames.get(id);
    if (callback) canceled.push(callback);
    frames.delete(id);
  };
  performance.now = () => now;
  return {
    viewport,
    resize: (width: number, height: number) => {
      viewport.innerWidth = width;
      viewport.innerHeight = height;
      [...listeners].forEach((listener) => listener());
    },
    tick: (milliseconds: number) => {
      now += milliseconds;
      const due = [...frames.values()];
      frames.clear();
      due.forEach((callback) => callback());
    },
    replayCanceled: () => canceled.forEach((callback) => callback()),
    listenerCount: () => listeners.size,
    queuedFrames: () => frames.size,
    restore: () => {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      globalThis.requestAnimationFrame = previousRaf;
      globalThis.cancelAnimationFrame = previousCancel;
      performance.now = previousNow;
    },
  };
}

/** 创建真实的运动与拖拽装配；状态 setter 不代写 ref，以单独验证即时同步。 */
function harness(initial: Center | null = null, initialSize = 640) {
  const browser = browserEnvironment();
  const hooks = hookRuntime();
  const commits: Array<Center | null> = [];
  const classes = new Set<string>();
  let size = initialSize;
  let statePosition = initial;
  const element = {
    style: { left: '', top: '', right: '24px', bottom: '20px', transform: '' },
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    setPointerCapture: () => {},
    hasPointerCapture: () => true,
    releasePointerCapture: () => {},
    getBoundingClientRect: () => {
      const left = element.style.left ? parseFloat(element.style.left) : 200;
      const top = element.style.top ? parseFloat(element.style.top) : 100;
      const height = (size * 9) / 16;
      return { left, top, width: size, height, right: left + size, bottom: top + height };
    },
  };
  const root = element as unknown as HTMLDivElement;
  const setCustomPos: CardStateApi['actions']['setCustomPos'] = (next) => {
    statePosition = typeof next === 'function' ? next(statePosition) : next;
    commits.push(statePosition);
  };
  const card = {
    actions: { setCustomPos },
    animRef: { current: 'idle' },
    facingRef: { current: 'left' },
    customPosRef: { current: initial },
  } as CardStateApi;
  const cfgRef = {
    current: {
      id: 'main',
      physics: DEFAULT_PHYSICS,
      animations: { drag: ['drag'], clicks: ['click'], idle: ['idle'] },
    } as RuntimePet,
  };
  const live = {
    current: {
      drag: { isActive: () => false, stopFollow: () => {} },
      ownAnim: { frontVideo: () => null, isFrozen: () => false },
      flow: null,
      releaseLock: () => {},
      tipOn: () => false,
      placeTip: () => {},
    } as unknown as CardLive,
  };
  const arena = { current: { slots: {} as Record<string, PetCollisionSlot> } };
  const runMotion = createCardMotion(hooks.runtime);
  const runDrag = createCardDrag(hooks.runtime);
  const render = (nextSize = size) => {
    size = nextSize;
    hooks.begin();
    const motion = runMotion({
      arena,
      card,
      cfgRef,
      live,
      metrics: { size, ...derivePetMetrics(size) },
      moves: { default: {}, actions: [] },
      petId: 'main',
      root: () => root,
      setCustomPos,
      setAnim: () => {},
      setOnce: () => {},
    });
    const dragInput = {
      card,
      cfgRef,
      live,
      motion,
      root: () => root,
      stage: () => root,
      pendingSquash: { current: false },
      setAnim: () => {},
      setOnce: () => {},
      setDragging: () => {},
      setTipOn: () => {},
      bumpSeq: () => {},
      setCustomPos,
    };
    const drag = runDrag(dragInput);
    hooks.flush();
    return { motion, drag };
  };
  const first = render();
  return {
    ...first,
    browser,
    card,
    commits,
    root,
    arena,
    render,
    unmount: hooks.unmount,
    dispose: () => {
      first.drag.stopFollow();
      first.motion.stopMove();
      first.motion.flight.stop();
      hooks.unmount();
      browser.restore();
    },
  };
}

/** 鼠标处理器只读取指针位置、按键与捕获节点。 */
function pointer(root: HTMLDivElement, x: number, y: number): ReactNS.PointerEvent<HTMLDivElement> {
  return {
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    currentTarget: root,
  } as ReactNS.PointerEvent<HTMLDivElement>;
}

describe('createCardMotion —— 落位', () => {
  test('屏外落位：四边按身体夹取，DOM、碰撞盒与归一化位置同时更新', (context) => {
    const setup = harness();
    context.after(setup.dispose);
    setup.motion.place({ x: 2000, y: 2000 });
    assert.deepEqual(setup.motion.box(), { x: 560, y: 235 });
    assert.deepEqual(setup.arena.current.slots.main.getBox(), { x: 560, y: 235 });
    assert.equal(setup.root.style.left, '560px');
    assert.equal(setup.root.style.top, '235px');
    assert.equal(setup.root.style.right, 'auto');
    assert.equal(setup.root.style.bottom, 'auto');
    assert.deepEqual(setup.card.customPosRef.current, { rx: 0.88, ry: 415 / 600 });
    assert.deepEqual(setup.commits[setup.commits.length - 1], setup.card.customPosRef.current);

    setup.motion.place({ x: -2000, y: -2000 });
    assert.deepEqual(setup.motion.box(), { x: -200, y: -80 });
    assert.deepEqual(setup.card.customPosRef.current, { rx: 0.12, ry: 1 / 6 });
  });

  test('拖到窗口外停顿后松手：通过真实指针处理器恢复到可点击边缘', (context) => {
    const setup = harness();
    context.after(setup.dispose);
    setup.drag.onPointerDown(pointer(setup.root, 520, 280));
    setup.drag.onPointerMove(pointer(setup.root, 1800, 280));
    for (let index = 0; index < 120; index++) setup.browser.tick(16);
    assert.ok((setup.motion.box()?.x ?? 0) > 1000, '停顿前跟随应能进入屏外');
    setup.drag.onPointerUp(pointer(setup.root, 1800, 280));
    assert.equal(setup.motion.flight.isFlying(), false, '停顿后的松手应走原地放下');
    assert.equal(setup.motion.box()?.x, 560);
    assert.equal(setup.root.style.left, '560px');
    assert.equal(setup.card.customPosRef.current?.rx, 0.88);
    assert.deepEqual(setup.commits[setup.commits.length - 1], setup.card.customPosRef.current);
  });
});

describe('createCardMotion —— 视口与尺寸重排', () => {
  test('挂载时已有屏外位置：立即自愈并同步包围盒', (context) => {
    const setup = harness({ rx: 2, ry: -1 });
    context.after(setup.dispose);
    assert.deepEqual(setup.motion.box(), { x: 560, y: -80 });
    assert.equal(setup.root.style.top, '-80px');
    assert.deepEqual(setup.card.customPosRef.current, { rx: 0.88, ry: 1 / 6 });
  });

  test('resize：先按比例重排，缩窗越界时同步夹取 DOM 与碰撞盒', (context) => {
    const setup = harness();
    context.after(setup.dispose);
    setup.motion.place({ x: 500, y: 200 });
    setup.browser.resize(500, 300);
    assert.deepEqual(setup.motion.box(), { x: 60, y: -65 });
    assert.deepEqual(setup.arena.current.slots.main.getBox(), { x: 60, y: -65 });
    assert.equal(setup.root.style.left, '60px');
    assert.equal(setup.root.style.top, '-65px');
    assert.deepEqual(setup.card.customPosRef.current, { rx: 0.76, ry: 115 / 300 });
    setup.browser.resize(1000, 600);
    assert.equal(setup.motion.box()?.x, 440);
    assert.ok(Math.abs((setup.motion.box()?.y ?? Infinity) - 50) < 1e-9);
  });

  test('尺寸变化：无需 resize 即按最新尺寸重排，监听只保留一份', (context) => {
    const setup = harness({ rx: 0.5, ry: 0.5 }, 320);
    context.after(setup.dispose);
    assert.deepEqual(setup.motion.box(), { x: 340, y: 210 });
    const latest = setup.render(640);
    assert.deepEqual(latest.motion.box(), { x: 180, y: 120 });
    assert.equal(setup.browser.listenerCount(), 1);
    setup.browser.resize(600, 400);
    assert.deepEqual(latest.motion.box(), { x: -20, y: 20 });
  });

  test('角落定位：挂载与 resize 均不创建自定义位置', (context) => {
    const setup = harness();
    context.after(setup.dispose);
    setup.browser.resize(500, 300);
    assert.equal(setup.motion.box(), null);
    assert.equal(setup.card.customPosRef.current, null);
    assert.deepEqual(setup.commits, []);
    assert.equal(setup.root.style.right, '24px');
    assert.equal(setup.root.style.bottom, '20px');
  });

  test('位置跟随途中 resize：按实时进度重排，不跳回上次落点', (context) => {
    const setup = harness({ rx: 0.5, ry: 0.5 });
    context.after(setup.dispose);
    setup.motion.posFollow.apply(0.8, 0.7, 'line', 1000);
    setup.browser.tick(500);
    assert.deepEqual(setup.motion.box(), { x: 330, y: 180 });
    assert.deepEqual(setup.card.customPosRef.current, { rx: 0.5, ry: 0.5 }, '运动尚未收尾，ref 仍是旧停点');

    setup.browser.resize(800, 500);
    assert.deepEqual(setup.motion.box(), { x: 200, y: 120 });
    assert.equal(setup.root.style.left, '200px');
    assert.equal(setup.root.style.top, '120px');
    assert.deepEqual(setup.card.customPosRef.current, { rx: 0.65, ry: 0.6 });
    assert.equal(setup.browser.queuedFrames(), 0);
  });

  test('首次从角落发起位置跟随：中心尚未提交也能按运动中的盒重排', (context) => {
    const setup = harness();
    context.after(setup.dispose);
    setup.motion.posFollow.apply(0.6, 0.5, 'line', 1000);
    setup.browser.tick(500);
    assert.equal(setup.card.customPosRef.current, null);
    assert.equal(setup.root.style.left, '280px');

    setup.browser.resize(800, 500);
    assert.deepEqual(setup.motion.box(), { x: 160, y: 70 });
    assert.equal(setup.root.style.left, '160px');
    assert.equal(setup.root.style.top, '70px');
    assert.deepEqual(setup.card.customPosRef.current, { rx: 0.6, ry: 0.5 });
    assert.equal(setup.browser.queuedFrames(), 0);
  });

  test('回到初始角落后 resize：忽略遗留运动盒，不恢复旧的自定义位置', (context) => {
    const setup = harness({ rx: 0.5, ry: 0.5 });
    context.after(setup.dispose);
    setup.motion.place({ x: 400, y: 200 });
    const staleBox = setup.motion.box();
    setup.card.customPosRef.current = null;
    setup.root.style.left = '';
    setup.root.style.top = '';
    setup.root.style.right = '24px';
    setup.root.style.bottom = '20px';
    const commits = setup.commits.length;

    setup.browser.resize(800, 500);
    assert.deepEqual(setup.motion.box(), staleBox, '初始角落不需要从旧盒恢复归一化位置');
    assert.equal(setup.card.customPosRef.current, null);
    assert.equal(setup.root.style.left, '');
    assert.equal(setup.root.style.top, '');
    assert.equal(setup.root.style.right, '24px');
    assert.equal(setup.root.style.bottom, '20px');
    assert.equal(setup.commits.length, commits);
  });

  test('按住拖拽：resize 不改写手势中的位置或提交状态', (context) => {
    const setup = harness({ rx: 0.5, ry: 0.5 });
    context.after(setup.dispose);
    setup.drag.onPointerDown(pointer(setup.root, 500, 300));
    const before = { box: setup.motion.box(), style: { ...setup.root.style }, commits: setup.commits.length };
    setup.browser.resize(500, 300);
    assert.deepEqual(setup.motion.box(), before.box);
    assert.deepEqual(setup.root.style, before.style);
    assert.equal(setup.commits.length, before.commits);
    assert.equal(setup.drag.isActive(), true);
  });

  test('重排取消旧飞行与位置跟随，迟到帧不能覆盖新位置', (context) => {
    const setup = harness({ rx: 0.5, ry: 0.5 });
    context.after(setup.dispose);
    setup.motion.posFollow.apply(0.8, 0.7, 'line', 1000);
    setup.browser.resize(800, 500);
    assert.equal(setup.browser.queuedFrames(), 0, 'resize 应取消位置跟随');
    setup.motion.startThrow(80, 80, 300, -100);
    setup.browser.tick(16);
    assert.equal(setup.motion.flight.isFlying(), true);
    setup.browser.resize(500, 300);
    const placed = { ...setup.root.style };
    const box = setup.motion.box();
    const commits = setup.commits.length;
    assert.equal(setup.motion.flight.isFlying(), false);
    assert.equal(setup.browser.queuedFrames(), 0);
    setup.browser.replayCanceled();
    assert.deepEqual(setup.root.style, placed);
    assert.deepEqual(setup.motion.box(), box);
    assert.equal(setup.commits.length, commits);
  });

  test('卸载：移除 resize 监听与碰撞槽，之后窗口变化不再提交', (context) => {
    const setup = harness({ rx: 0.5, ry: 0.5 });
    context.after(setup.dispose);
    assert.equal(setup.browser.listenerCount(), 1);
    setup.unmount();
    const commits = setup.commits.length;
    setup.browser.resize(500, 300);
    assert.equal(setup.browser.listenerCount(), 0);
    assert.deepEqual(setup.arena.current.slots, {});
    assert.equal(setup.commits.length, commits);
  });
});
