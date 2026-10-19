// Pure JS VM/DOM/IPC mocks: never starts Electron or reads user configuration.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const dir = fileURLToPath(new URL('../../runtime/electron-helper/', import.meta.url));
const spriteSource = fs.readFileSync(path.join(dir, 'sprite.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8');
// Build current shared sources in memory: no generated shared-core.js prerequisite.
const bundle = await rolldown({
  input: fileURLToPath(new URL('../../src/shared/index.ts', import.meta.url)),
  platform: 'browser',
});
let sharedSource;
try {
  const { output } = await bundle.generate({ format: 'iife', name: 'PetShared' });
  sharedSource = output[0].code;
} finally {
  await bundle.close();
}
const { decideWindowIgnore } = createRequire(import.meta.url)(path.join(dir, 'pointer-target.js'));

class Target {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn, options = {}) {
    const handlers = this.listeners.get(type) || new Set();
    handlers.add(fn);
    this.listeners.set(type, handlers);
    options.signal?.addEventListener('abort', () => handlers.delete(fn), { once: true });
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
}
class Element extends Target {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.style = {
      setProperty(k, v) {
        this[k] = v;
      },
    };
    const classes = new Set();
    this.classList = {
      add: (...xs) => xs.forEach((x) => classes.add(x)),
      remove: (...xs) => xs.forEach((x) => classes.delete(x)),
      toggle: (x, on) => (on ? classes.add(x) : classes.delete(x)),
      contains: (x) => classes.has(x),
    };
  }
  appendChild(el) {
    this.children.push(el);
    return el;
  }
  setAttribute(k, v) {
    this[k] = v;
  }
  setPointerCapture(id) {
    this.capture = id;
  }
  releasePointerCapture(id) {
    if (this.capture === id) {
      this.capture = null;
      this.emit('lostpointercapture', { pointerId: id });
    }
  }
  remove() {
    this.removed = true;
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}
function setup({ scale = 1, store = new Map(), storageThrows = false, font, size = 400 } = {}) {
  const window = new Target();
  const rootEl = new Element('root');
  const document = {
    body: new Element('body'),
    head: new Element('head'),
    createElement: (tag) => new Element(tag),
    querySelectorAll: () => [],
  };
  const calls = { bounds: [], busy: [], regions: [], interactive: [], cancelled: [] };
  window.__dshPetDebug = {};
  window.localStorage = {
    getItem(k) {
      if (storageThrows) throw Error('disabled');
      return store.get(k) ?? null;
    },
    setItem(k, v) {
      if (storageThrows) throw Error('quota');
      store.set(k, v);
    },
  };
  window.petBridge = {
    setBounds: (...args) => calls.bounds.push(args),
    setInputBusy: (v) => calls.busy.push(v),
    setInputRegions: (v) => calls.regions.push(v),
    setInteractive: (v) => calls.interactive.push(v),
  };
  window.matchMedia = () => ({ matches: false });
  const observer = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const ctx = vm.createContext({
    window,
    document,
    rootEl,
    console,
    AbortController,
    ResizeObserver: observer,
    MutationObserver: observer,
    localStorage: window.localStorage,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 99,
    cancelAnimationFrame: (id) => calls.cancelled.push(id),
    setTimeout: () => 1,
    CONFIG: { scale, topInsetRatio: 0 },
    VIEW: { x: -100, y: 20, w: 1920, h: 1080 },
    PRIMARY_AREA: null,
    AREAS: [{ x: 0, y: 0, width: 1920, height: 1080 }],
    PANELS: [],
    WORK_AREAS: [],
    BASE: 'mock://pet',
    config: { physics: {} },
    WINDOW_MARGIN_RATIO: 0.5,
    toLocal: (v) => v / scale,
    toScreen: (v) => v * scale,
  });
  vm.runInContext(sharedSource, ctx, { filename: 'shared-core.js' });
  ctx.S = ctx.PetShared || window.PetShared;
  vm.runInContext(spriteSource + '\nglobalThis.Sprite = PetSprite;', ctx, { filename: 'sprite.js' });
  const pet = {
    id: 'main',
    name: 'Mock pet',
    size,
    font,
    position: { corner: 'bottom-right', marginX: 10, marginY: 10 },
    animations: { idle: ['idle'], drag: [], clicks: [], turn: [], moves: { actions: [] } },
    animationWeights: {},
  };
  const sprite = new ctx.Sprite(pet);
  const event = (override = {}) => ({
    button: 0,
    pointerId: 7,
    isPrimary: true,
    screenX: 1500,
    screenY: 900,
    clientX: 1,
    clientY: 1,
    buttons: 1,
    preventDefault() {},
    stopPropagation() {},
    ...override,
  });
  const begin = () => sprite.resizeHandle.emit('pointerdown', event());
  const grow = (factor = 1.5, overrides = {}) => {
    const d = sprite.resizeState;
    window.emit(
      'pointermove',
      event({
        screenX: (d.sx + d.bodyW * (factor - 1)) * scale,
        screenY: (d.sy + d.bodyH * (factor - 1)) * scale,
        ...overrides,
      }),
    );
  };
  return { ctx, window, sprite, pet, event, calls, store, begin, grow };
}
const near = (actual, expected, epsilon = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('visible small handle, initial geometry, native passthrough and untouched body listeners', () => {
  const { sprite: s, calls, event } = setup();
  assert.equal(s.resizeHandle.className, 'pet-resize-handle');
  assert.equal(s.handleRect.w, 18);
  assert.equal(s.handleRect.h, 18);
  assert.notEqual(s.resizeHandle, s.hit);
  assert.ok(s.hit.listeners.has('click') && s.hit.listeners.has('pointerdown'));
  assert.equal(calls.regions.at(-1).rects.length, 1);
  assert.equal(calls.regions.at(-1).dragging, false);
  const b = calls.bounds.at(-1),
    h = calls.regions.at(-1).rects[0];
  const bounds = { x: b[0], y: b[1], width: b[2], height: b[3] };
  assert.equal(
    decideWindowIgnore(bounds, { x: b[0] + h.x + 9, y: b[1] + h.y + 9 }, true, false, 1000, calls.regions.at(-1)),
    false,
  );
  s.onMouseMove(event({ clientX: s.margin.l + s.handleRect.x + 9, clientY: s.margin.t + s.handleRect.y + 9 }));
  assert.equal(calls.interactive.at(-1), true);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /\.pet-resize-handle\s*\{[^}]*width: 18px;[^}]*height: 18px;[^}]*pointer-events: auto;/s);
});

test('live resize updates all geometry, CSS, bounds and collision state, preserving body anchor', () => {
  const { sprite: s, calls, begin, grow, pet } = setup({ scale: 1.5 });
  s.moveRef = 1;
  s.throwRef = 2;
  s.dragFollow = 3;
  s.squashRef = 4;
  s.posFollow = 5;
  s.pendingMove = {};
  s.pendingSquash = true;
  s.throwState = { vx: 10, vy: 20 };
  s.videoA.style.transform = 'scaleY(0.5)';
  const anchor = { x: s.pos.x + s.hitRect.x, y: s.pos.y + s.hitRect.y };
  begin();
  assert.equal(s.resizing, true);
  assert.equal(s.resizeHandle.capture, 7);
  assert.equal(s.inputBusy(), true);
  assert.equal(calls.regions.at(-1).dragging, true);
  assert.deepEqual(calls.cancelled, [1, 5, 2, 3, 4]);
  assert.equal(s.posFollow, null);
  assert.equal(s.pendingMove, null);
  assert.equal(s.pendingSquash, false);
  assert.equal(s.videoA.style.transform, '');
  grow();
  near(s.size, 600);
  near(s.height, 337.5);
  near(s.halfW, 300);
  near(s.halfH, 168.75);
  near(s.bottomPad, 28.125);
  near(s.winH, 365.625);
  near(s.hitRect.x, 187.5);
  near(s.hitRect.y, 75);
  near(s.hitRect.w, 225);
  near(s.hitRect.h, 267.1875);
  near(s.sideAllow, 187.5);
  near(s.margin.l, 300);
  assert.equal(s.space, null);
  near(s.pos.x + s.hitRect.x, anchor.x, 0.5);
  near(s.pos.y + s.hitRect.y, anchor.y, 0.5);
  assert.equal(s.el.style['--pet-size'], '600px');
  assert.equal(s.el.style.left, '300px');
  assert.equal(s.stage.style.transform, 'translateY(28.125px)');
  const b = calls.bounds.at(-1);
  near(b[2], 1800);
  near(b[3], (365.625 + 600) * 1.5);
  near(b[6], 900);
  near(b[7], 42.1875);
  assert.equal(b[8], 0);
  assert.equal(b[9], 0);
  near(b[4], s.pos.x * 1.5);
  near(b[5], s.pos.y * 1.5);
  const h = calls.regions.at(-1).rects[0];
  near(h.x, (s.margin.l + s.handleRect.x) * 1.5);
  near(h.width, 27);
  assert.equal(pet.size, 400);
  const lastSize = s.size,
    lastPos = { ...s.pos };
  grow(1.5, { clientX: -99999, clientY: 99999 }); // moving window/client coordinates cannot feed back
  near(s.size, lastSize);
  assert.deepEqual({ ...s.pos }, lastPos);
  const bounds = { x: b[0], y: b[1], width: b[2], height: b[3] };
  assert.equal(decideWindowIgnore(bounds, { x: -99999, y: -99999 }, true, true, 999, calls.regions.at(-1)), false);
});

test('resizing preserves upstream fixed-font top margin and recomputes following font pixels', () => {
  for (const followPet of [true, false]) {
    const font = { family: 'system', size: 36, followPet };
    const { ctx, sprite: s, begin, grow, calls } = setup({ font });
    const initialFont = s.el.style['--dsh-pet-font-bubble'];
    begin();
    grow(0.3);
    const px = ctx.S.resolveFontPx(font, s.size);
    const top = Math.max(s.size * 0.5, ctx.S.bubbleTopMarginPx(font, s.size));
    near(s.margin.t, top);
    assert.equal(s.el.style.top, top + 'px');
    assert.equal(s.el.style['--dsh-pet-font-bubble'], px.bubble + 'px');
    assert.equal(s.el.style['--dsh-pet-font-tip'], px.tip + 'px');
    if (followPet) assert.notEqual(s.el.style['--dsh-pet-font-bubble'], initialFont);
    else {
      assert.equal(s.el.style['--dsh-pet-font-bubble'], initialFont);
      assert.ok(top > s.margin.l);
    }
    near(calls.bounds.at(-1)[3], s.winH + s.margin.t + s.margin.b);
  }
});

test('limits and DPI-independent diagonal projection', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const { sprite: s, begin, grow } = setup({ scale });
    begin();
    grow(2);
    near(s.size, 800);
    grow(100);
    assert.equal(s.size, 1200);
    grow(-100);
    assert.equal(s.size, 120);
    grow(1.5);
    near(s.size, 600);
  }
});

test('pointerup/cancel/lostcapture/blur/buttons=0/dispose all clear capture and native input lease', () => {
  for (const finish of [
    'pointerup',
    'pointercancel',
    'lostpointercapture',
    'blur',
    'buttons0',
    'moveButtons0',
    'dispose',
  ]) {
    const { sprite: s, window, begin, grow, calls, event } = setup();
    begin();
    grow();
    if (finish === 'lostpointercapture') s.resizeHandle.emit(finish, event({ buttons: 0 }));
    else if (finish === 'buttons0') window.emit('mousemove', event({ buttons: 0 }));
    else if (finish === 'moveButtons0') window.emit('pointermove', event({ buttons: 0 }));
    else if (finish === 'dispose') s.dispose();
    else window.emit(finish, finish === 'blur' ? {} : event({ buttons: 0 }));
    assert.equal(s.resizing, false, finish);
    assert.equal(s.resizeState, null, finish);
    assert.equal(s.resizeHandle.capture, null, finish);
    assert.equal(s.inputBusy(), false, finish);
    assert.equal(calls.busy.at(-1), false, finish);
    assert.equal(calls.regions.at(-1).dragging, false, finish);
  }
});

test('only owning primary left pointer can resize or end; mouseleave preserves capture', () => {
  const { sprite: s, window, calls, begin, grow, event } = setup();
  s.onResizeDown(event({ button: 2 }));
  assert.equal(s.resizing, false);
  s.onResizeDown(event({ isPrimary: false }));
  assert.equal(s.resizing, false);
  begin();
  const initial = s.size;
  window.emit('pointermove', event({ pointerId: 8, screenX: 99999 }));
  near(s.size, initial);
  window.emit('pointerup', event({ pointerId: 8 }));
  assert.equal(s.resizing, true);
  window.emit('mouseleave', {});
  assert.equal(s.resizing, true);
  assert.equal(calls.busy.at(-1), true);
  s.onDeskHit(100, 100);
  assert.equal(s.throwRef, null);
  assert.equal(s.tryMove(), true);
  assert.equal(s.pendingMove, null);
  grow();
  s.endResize();
});

test('local-only saved size restores per pet+configured size, invalid or unavailable storage is safe', () => {
  const store = new Map();
  const a = setup({ store });
  a.begin();
  a.grow();
  a.sprite.endResize();
  assert.equal(store.get('dsh-pet:size:main:400'), '600');
  assert.equal(a.pet.size, 400);
  const b = setup({ store });
  assert.equal(b.sprite.size, 600);
  assert.equal(b.pet.size, 400);
  const newPet = { ...b.pet, size: 450 };
  assert.equal(new b.ctx.Sprite(newPet).size, 450);
  assert.equal(new b.ctx.Sprite({ ...b.pet, id: 'second' }).size, 400);
  for (const bad of ['broken', '', 'NaN', 'Infinity', '-1', '119', '1201', '{}']) {
    const c = setup({ store: new Map([['dsh-pet:size:main:400', bad]]) });
    assert.equal(c.sprite.size, 400, bad);
  }
  const disabled = setup({ storageThrows: true });
  disabled.begin();
  disabled.grow();
  assert.doesNotThrow(() => disabled.sprite.endResize());
});

test('configured sizes outside gesture limits stay unchanged until a resize gesture', () => {
  for (const size of [80, 1500]) {
    const { sprite: s, pet, begin, grow, store } = setup({ size });
    assert.equal(s.size, size);
    assert.equal(s.el.style['--pet-size'], size + 'px');
    assert.equal(s.height, (size * 9) / 16);
    begin();
    assert.equal(s.size, size);
    grow(1);
    const expected = size === 80 ? 120 : 1200;
    assert.equal(s.size, expected);
    s.endResize();
    assert.equal(pet.size, size);
    assert.equal(store.get(`dsh-pet:size:main:${size}`), String(expected));
    assert.equal(setup({ size, store }).sprite.size, expected);
  }
});

test('animation ending during resize resumes after release, but not during dispose', () => {
  for (const dispose of [false, true]) {
    const { sprite: s, begin } = setup();
    let played = 0;
    s.anim = 'click';
    s.animations.clicks = ['click'];
    s.playOnce = () => played++;
    begin();
    s.videoA.ended = true;
    s.handleEnded();
    assert.equal(played, 0);
    if (dispose) s.dispose();
    else s.endResize();
    assert.equal(played, dispose ? 0 : 1);
  }
});

test('deferred ended commits turn direction once and does not repeat external receipts', () => {
  const { sprite: s, begin } = setup();
  s.anim = 'turn';
  s.animations.turn = ['turn'];
  const receipts = [];
  const directions = [];
  s.reportPlayback = (...args) => receipts.push(args);
  s.playIdle = () => directions.push(s.facing);
  s.playback = 'request-1';
  begin();
  s.videoA.ended = true;
  s.handleEnded();
  assert.equal(s.facing, 'left');
  assert.deepEqual(receipts, [['request-1', 'ended']]);
  s.endResize();
  assert.equal(s.facing, 'right');
  assert.deepEqual(directions, ['right']);
  assert.deepEqual(receipts, [['request-1', 'ended']]);
  s.endResize();
  assert.deepEqual(directions, ['right']);
});

test('deferred ended is discarded after generation/front changes or disposal', () => {
  for (const stale of ['generation', 'front', 'dispose']) {
    const { sprite: s, begin } = setup();
    s.anim = 'turn';
    s.animations.turn = ['turn'];
    let played = 0;
    s.playIdle = () => played++;
    begin();
    s.handleEnded();
    if (stale === 'generation') s.gen++;
    if (stale === 'front') s.front = 1;
    if (stale === 'dispose') s.dispose();
    else s.endResize();
    assert.equal(s.facing, 'left', stale);
    assert.equal(played, 0, stale);
  }
});

test('window resize avoids position feedback while resizing and settles at the new custom position', () => {
  const { sprite: s, ctx, window, begin, grow } = setup();
  // Evaluate the real renderer resize listener, without boot/fetch/injecting any app.
  const start = rendererSource.indexOf("window.addEventListener('resize',");
  const end = rendererSource.indexOf('\n});', start) + 4;
  ctx.sprites = [s];
  vm.runInContext(rendererSource.slice(start, end), ctx);
  const position = s.position.bind(s);
  let count = 0;
  s.position = () => {
    count++;
    position();
  };
  begin();
  grow();
  const current = { ...s.pos };
  window.emit('resize', {});
  assert.equal(count, 0);
  assert.deepEqual({ ...s.pos }, current);
  s.endResize();
  window.emit('resize', {});
  assert.equal(count, 1);
  assert.deepEqual({ ...s.pos }, current);
  s.posFollow = 5;
  window.emit('resize', {});
  assert.equal(count, 1);
  s.posFollow = null;
  window.emit('resize', {});
  assert.equal(count, 2);
});
