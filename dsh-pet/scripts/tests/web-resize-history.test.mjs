// Portable, isolated hook/DOM model: no DSH server, installed package, or user storage.
// Run: node --test scripts/tests/web-resize-history.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/client/pet.ts', import.meta.url), 'utf8');
const compile = (text) =>
  ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    .outputText;
const petCode = compile(source.replace('return PetMulti;', 'return PetCard;'));
const helperCode = Object.fromEntries(
  ['resize', 'action-history'].map((name) => [
    '../shared/' + name,
    compile(readFileSync(new URL(`../../src/shared/${name}.ts`, import.meta.url), 'utf8')),
  ]),
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

function fixture() {
  const storage = new Map(),
    listeners = new Map(),
    raf = new Map(),
    reports = [],
    plays = [],
    menus = [];
  const hooks = [],
    pendingEffects = [];
  let cursor = 0,
    dirty = false,
    root,
    nextRaf = 0,
    alive = true;
  const cls = () => {
    const set = new Set();
    return {
      add: (v) => set.add(v),
      remove: (v) => set.delete(v),
      contains: (v) => set.has(v),
      reset: (v) => {
        set.clear();
        v.split(' ').forEach((s) => set.add(s));
      },
    };
  };
  function dom(type) {
    const events = new Map(),
      captures = new Set();
    return {
      type,
      style: {},
      classList: cls(),
      ended: false,
      currentTime: 0,
      duration: 2,
      addEventListener(name, fn) {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(fn);
      },
      removeEventListener(name, fn) {
        events.get(name)?.delete(fn);
      },
      fire(name) {
        for (const fn of [...(events.get(name) ?? [])]) fn();
      },
      load() {
        this.fire('loadeddata');
      },
      play() {
        const d = deferred();
        plays.push({ el: this, ...d });
        return d.promise;
      },
      pause() {},
      getBoundingClientRect() {
        return { left: 100, top: 100, width: 240, height: 135, right: 340, bottom: 235 };
      },
      setPointerCapture(id) {
        if (this.captureError) throw new Error('capture failed');
        captures.add(id);
      },
      hasPointerCapture: (id) => captures.has(id),
      releasePointerCapture: (id) => captures.delete(id),
    };
  }
  const rt = {
    h(type, props) {
      const node = { type, props };
      if (props.ref) {
        props.ref.current ??= dom(type);
        if (props.className) props.ref.current.classList.reset(props.className);
        Object.assign(props.ref.current.style, props.style);
        node.el = props.ref.current;
      }
      return node;
    },
    useState(init) {
      const i = cursor++;
      hooks[i] ??= { value: typeof init === 'function' ? init() : init };
      return [
        hooks[i].value,
        (value) => {
          const next = typeof value === 'function' ? value(hooks[i].value) : value;
          if (!Object.is(next, hooks[i].value)) {
            hooks[i].value = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(value) {
      const i = cursor++;
      hooks[i] ??= { current: value };
      return hooks[i];
    },
    useEffect(fn, deps) {
      const i = cursor++,
        old = hooks[i];
      if (!old || !deps || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        hooks[i] = { deps, cleanup: old?.cleanup };
        pendingEffects.push(() => {
          hooks[i].cleanup?.();
          hooks[i].cleanup = fn();
        });
      }
    },
  };
  const mocks = {
    '../shared/pickers': {
      pick: (pool) => pool[0],
      rollKind: () => 'idle',
      pickSlot: (v) => (Array.isArray(v) ? v[0] : v),
      isEventAnim: () => false,
      poolIncludes: () => false,
      nextWorkStatusAnim: () => null,
    },
    '../shared/motion': { planMove: () => ({ startRatio: 0.3, startYRatio: 0.3, targetRatio: 0.5, totalRatio: 0.2 }) },
    '../shared/constants': {
      CANVAS_H: 360,
      FEET_Y: 330,
      HIT_BOX: { x0: 160, x1: 480, y0: 60, y1: 330 },
      DRAG_THRESHOLD: 8,
      PET_REF_WIDTH: 462,
      ANIMATION_EXT: '.webm',
    },
    '../shared/fonts': { resolveFontPx: () => ({ bubble: 16, tip: 12 }) },
    '../shared/menu': {
      MENU_CSS: '',
      isNoMirrorAnimation: () => false,
      buildMenuTree: () => [],
      displayMenuBranch: () => ({ label: '显示位置' }),
      mountContextMenu: (options) => {
        menus.push(options);
        return { close() {} };
      },
    },
    '../shared/tooltip': {
      TOOLTIP_CSS: '',
      TOOLTIP_CLASS: 'tip',
      TOOLTIP_GAP_RATIO: 0.1,
      tooltipPlacement: () => ({ x: 0, y: 0 }),
    },
    '../shared/state': {
      postAction: (url, body) => {
        reports.push({ url, ...body });
        return Promise.resolve(true);
      },
    },
    './bubble': { makeBalanceBubble: () => () => null, makeWhisperBubble: () => () => null },
    './settings': { petBridge: {} },
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    AbortController,
    Date,
    Promise,
    performance,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { querySelector: () => ({}), documentElement: { clientWidth: 1000, clientHeight: 800 } },
    window: {
      innerWidth: 1000,
      innerHeight: 800,
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
      addEventListener: (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
      },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: async () => ({ ok: true, blob: async () => ({}) }),
    requestAnimationFrame: (fn) => {
      const id = ++nextRaf;
      raf.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => raf.delete(id),
    setTimeout,
    clearTimeout,
  });
  function requireMock(name) {
    if (helperCode[name]) {
      const mod = { exports: {} };
      vm.runInContext(`(function(require,module,exports){${helperCode[name]}\n})`, context)(
        requireMock,
        mod,
        mod.exports,
      );
      return mod.exports;
    }
    return mocks[name] ?? {};
  }
  const mod = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${petCode}\n})`, context)(requireMock, mod, mod.exports);
  const PetCard = mod.exports.makePetUI(rt);
  const props = {
    cfg: {
      id: 'test',
      size: 240,
      name: 'Test',
      font: {},
      position: { corner: 'top-left', marginX: 0, marginY: 0 },
      physics: {},
      animations: {
        idle: ['idle'],
        turn: [],
        clicks: ['click'],
        drag: ['drag'],
        events: {},
        categories: [],
        moves: { default: {}, actions: [{ name: 'walk' }] },
      },
      animationWeights: {},
    },
    arena: { current: { slots: {} } },
  };
  function render() {
    if (!alive) return;
    for (let i = 0; i < 20; i++) {
      dirty = false;
      cursor = 0;
      root = PetCard(props);
      pendingEffects.splice(0).forEach((run) => run());
      if (!dirty) return;
    }
    throw new Error('hook model did not settle');
  }
  async function flush() {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
  }
  const walk = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat()) {
      const found = walk(child, predicate);
      if (found) return found;
    }
    return null;
  };
  const node = (name) => walk(root, (n) => n.props?.className === name);
  const button = dom('button');
  const event = (extra = {}) => ({
    button: 0,
    pointerId: 1,
    clientX: 300,
    clientY: 200,
    currentTarget: button,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  });
  render();
  return {
    storage,
    plays,
    reports,
    menus,
    raf,
    props,
    event,
    node,
    button,
    render,
    flush,
    rows: () => JSON.parse(storage.get('dsh-pet:action-history:v1:test') ?? '[]'),
    front: () => walk(root, (n) => n.type === 'video' && n.el.classList.contains('is-front'))?.el,
    async cue(name, playbackId) {
      props.animCue = { name, playbackId, seq: (props.animCue?.seq ?? 0) + 1 };
      props.animCueTick = (props.animCueTick ?? 0) + 1;
      render();
      await flush();
    },
    start() {
      node('dsh-pet-resize').props.onPointerDown(event());
    },
    finish(kind = 'onPointerUp') {
      node('dsh-pet-resize').props[kind](event());
    },
    blur() {
      for (const fn of listeners.get('blur') ?? []) fn();
    },
    unmount() {
      alive = false;
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
}

test('history records only successful, mounted, current-generation foreground playback', async () => {
  const f = fixture();
  await f.flush();
  assert.equal(f.rows().length, 0, 'loadeddata alone is not playback');
  f.plays[0].resolve();
  await f.flush();
  assert.deepEqual(
    f.rows().map((r) => r.name),
    ['idle'],
  );
  await f.cue('reject');
  f.plays.at(-1).reject(new Error('blocked'));
  await f.flush();
  assert.equal(f.rows().length, 1);
  await f.cue('stale');
  const stale = f.plays.at(-1);
  await f.cue('new');
  const current = f.plays.at(-1);
  stale.resolve();
  await f.flush();
  assert.equal(f.rows().length, 1);
  current.resolve();
  await f.flush();
  assert.equal(f.rows().at(-1).name, 'new');
  await f.cue('unmounted');
  const last = f.plays.at(-1);
  f.unmount();
  last.resolve();
  await f.flush();
  assert.equal(f.rows().length, 2);
});

test('successful external URL playback stores only a safe history label and preserves receipts', async () => {
  const f = fixture();
  await f.flush();
  f.plays[0].resolve();
  await f.flush();
  const url = 'https://example.invalid/animation.webm?token=private-history-regression-secret';
  f.props.animCue = { url, playbackId: 'external-receipt', seq: 1 };
  f.props.animCueTick = 1;
  f.render();
  await f.flush();
  assert.equal(f.rows().length, 1, 'external loadeddata alone is not playback');
  f.plays.at(-1).resolve();
  await f.flush();
  assert.deepEqual(
    f.rows().map((r) => r.name),
    ['idle', '外部动画'],
  );
  const persisted = JSON.stringify([...f.storage]);
  assert.equal(persisted.includes(url), false);
  assert.equal(persisted.includes('private-history-regression-secret'), false);
  const front = f.front();
  front.onended({ currentTarget: front });
  f.render();
  await f.flush();
  assert.deepEqual(
    f.reports.filter((r) => r.url.endsWith('/external-receipt/report')).map((r) => r.status),
    ['playing', 'ended'],
  );
  f.unmount();
});

test('rapid real replays remain separate and right-click history preserves display menu', async () => {
  const f = fixture();
  await f.flush();
  f.plays[0].resolve();
  await f.flush();
  for (let i = 0; i < 2; i++) {
    const front = f.front();
    front.onended({ currentTarget: front });
    f.render();
    await f.flush();
    f.plays.at(-1).resolve();
    await f.flush();
  }
  assert.deepEqual(
    f.rows().map((r) => r.name),
    ['idle', 'idle', 'idle'],
  );
  f.node('dsh-pet-hit').props.onContextMenu(f.event());
  const tree = f.menus[0].tree;
  assert.ok(tree.some((n) => n.label === '显示位置'));
  const history = tree.find((n) => n.label.startsWith('动作历史'));
  assert.equal(history.children.length, 3);
  assert.ok(history.children.every((n) => n.disabled && !n.anim && !n.action));
  f.unmount();
});

test('resize clamps and persists only on finish, keeping body top-left anchored', async () => {
  const f = fixture();
  await f.flush();
  f.plays[0].resolve();
  await f.flush();
  f.start();
  f.node('dsh-pet-resize').props.onPointerMove(f.event({ clientX: 2000, clientY: 2000 }));
  f.render();
  assert.equal(f.node('dsh-pet-root').props.style['--dsh-pet-size'], '1200px');
  assert.equal(f.storage.has('dsh-pet:size:test:240'), false);
  const style = f.node('dsh-pet-root').props.style;
  assert.equal(parseFloat(style.left) + (1200 * 160) / 640, 100 + (240 * 160) / 640);
  assert.equal(parseFloat(style.top) + (1200 * 90) / 640, 100 + (240 * 90) / 640);
  f.finish();
  assert.equal(f.storage.get('dsh-pet:size:test:240'), '1200');
  f.start();
  f.node('dsh-pet-resize').props.onPointerMove(f.event({ clientX: -2000, clientY: -2000 }));
  f.render();
  f.finish();
  assert.equal(f.storage.get('dsh-pet:size:test:240'), '120');
  f.unmount();
});

for (const ending of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture', 'blur']) {
  test(`resize ${ending} resumes a suppressed ended without losing playback receipt`, async () => {
    const f = fixture();
    await f.flush();
    f.plays[0].resolve();
    await f.flush();
    await f.cue('external', 'receipt');
    f.plays.at(-1).resolve();
    await f.flush();
    f.start();
    const front = f.front();
    const count = f.plays.length;
    front.onended({ currentTarget: front });
    f.render();
    await f.flush();
    assert.equal(f.plays.length, count);
    assert.equal(f.reports.filter((r) => r.status === 'ended').length, 1);
    if (ending === 'blur') f.blur();
    else f.finish(ending);
    f.render();
    await f.flush();
    assert.ok(f.plays.length > count, 'animation chain resumes');
    assert.equal(f.reports.filter((r) => r.status === 'ended').length, 1);
    assert.equal(f.reports.filter((r) => r.status === 'cancelled').length, 0);
    f.unmount();
  });
}

test('capture failure exits resize; finishing live playback does not restart/cancel it', async () => {
  const f = fixture();
  await f.flush();
  f.plays[0].resolve();
  await f.flush();
  await f.cue('external', 'receipt');
  f.plays.at(-1).resolve();
  await f.flush();
  const count = f.plays.length;
  f.button.captureError = true;
  f.start();
  f.render();
  await f.flush();
  assert.equal(f.plays.length, count);
  assert.equal(f.reports.filter((r) => r.status === 'cancelled').length, 0);
  f.button.captureError = false;
  f.start();
  f.finish();
  f.render();
  await f.flush();
  assert.equal(f.plays.length, count);
  f.node('dsh-pet-hit').props.onClick();
  f.render();
  await f.flush();
  assert.ok(f.plays.length > count, 'capture failure did not leave the resize lock held');
  f.unmount();
});

test('resize blocks walking, all position modes, throw commands, collision and feedback', async () => {
  const f = fixture();
  await f.flush();
  f.plays[0].resolve();
  await f.flush();
  f.start();
  await f.cue('walk');
  for (const mode of ['instant', 'spring', 'line']) {
    f.props.posCue = { x: 0.9, y: 0.9, mode, duration: 500, seq: (f.props.posCue?.seq ?? 0) + 1 };
    f.props.posCueTick = (f.props.posCueTick ?? 0) + 1;
    f.render();
  }
  f.props.throwCue = { angle: 30, power: 2, seq: 1 };
  f.props.throwCueTick = 1;
  f.render();
  f.props.arena.current.slots.test.onHit(1000, -1000);
  const count = f.plays.length;
  f.node('dsh-pet-hit').props.onPointerDown(f.event());
  f.node('dsh-pet-hit').props.onPointerMove(f.event({ clientX: 700 }));
  f.node('dsh-pet-hit').props.onClick();
  f.node('dsh-pet-hit').props.onPointerEnter(f.event());
  f.render();
  await f.flush();
  assert.equal(f.raf.size, 0);
  assert.equal(f.plays.length, count);
  assert.equal(f.node('dsh-pet-root').props.style.left, undefined);
  assert.ok(f.node('tip'), 'hover feedback stays hidden');
  f.finish();
  f.unmount();
});
