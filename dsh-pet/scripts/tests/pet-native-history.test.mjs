// Pure JS VM/DOM mocks: never starts Electron or reads user configuration.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const spritePath = fileURLToPath(new URL('../../runtime/electron-helper/sprite.js', import.meta.url));
const source = fs.readFileSync(spritePath, 'utf8');

function harness() {
  let nextTimer = 1;
  const timers = new Map();
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.listeners = new Map();
      this.attrs = {};
      this.style = { setProperty() {} };
      const classes = new Set();
      this.classList = {
        add: (x) => classes.add(x),
        remove: (x) => classes.delete(x),
        contains: (x) => classes.has(x),
      };
      this.readyState = 0;
      this.playCalls = 0;
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    appendChild() {}
    addEventListener(k, fn) {
      if (!this.listeners.has(k)) this.listeners.set(k, new Set());
      this.listeners.get(k).add(fn);
    }
    removeEventListener(k, fn) {
      this.listeners.get(k)?.delete(fn);
    }
    dispatch(k) {
      for (const fn of [...(this.listeners.get(k) || [])]) fn();
    }
    load() {}
    play() {
      this.playCalls++;
      return this.playResult || Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }
  const histories = new Map();
  const created = [];
  let menuTree;
  const S = {
    DEFAULT_PHYSICS: {},
    HIT_BOX: { x0: 100, y0: 20, x1: 500, y1: 340 },
    CANVAS_H: 360,
    FEET_Y: 340,
    createActionHistory(id) {
      created.push(id);
      const list = [];
      histories.set(id, list);
      return {
        record(name) {
          list.push({ name, at: Date.now() });
        },
        entries() {
          return list.slice();
        },
      };
    },
    buildActionHistoryMenu(entries) {
      return [
        {
          label: '动作历史',
          children: entries.length
            ? entries.map((e) => ({ label: e.name, disabled: true }))
            : [{ label: '暂无动作历史', disabled: true }],
        },
      ];
    },
    DEFAULT_FONT: { size: 21, followPet: true },
    readPetSize(_id, size) {
      return size;
    },
    clampPetSize(size) {
      return Math.max(120, Math.min(1200, size));
    },
    savePetSize() {},
    bubbleTopMarginPx() {
      return 0;
    },
    resolveFontPx() {
      return { bubble: 21, tip: 12 };
    },
    displayMenuBranch() {
      return { label: '显示位置', children: [] };
    },
    isEventAnim() {
      return false;
    },
    pick(pool) {
      return pool[0];
    },
    buildMenuTree() {
      return [{ label: '动作', children: [{ label: 'idle', anim: 'idle' }] }];
    },
    mountContextMenu(options) {
      menuTree = options.tree;
      return { close() {} };
    },
  };
  const context = {
    console: { warn() {}, log() {} },
    AbortController,
    S,
    cfg: { animations: { idle: ['idle'], turn: [], drag: [], clicks: [] }, animationWeights: {} },
    config: {},
    CONFIG: {},
    WINDOW_MARGIN_RATIO: 0.5,
    BASE: 'http://test',
    OPEN_TARGET: 'desktop',
    document: { createElement: (tag) => new Element(tag), body: new Element('body') },
    rootEl: new Element('root'),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    window: {
      localStorage: {
        getItem() {
          return null;
        },
      },
      __dshPetDebug: {},
      addEventListener() {},
      setTimeout(fn) {
        const id = nextTimer++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  };
  vm.runInNewContext(source + '\nglobalThis.PetSprite = PetSprite;', context, { filename: spritePath });
  const P = context.PetSprite;
  for (const name of ['position', 'syncInputBusy', 'syncInputRegions', 'setInteractive', 'stopThrow', 'stopMove']) {
    P.prototype[name] = function () {};
  }
  P.prototype.visibleClampRect = () => null;
  return {
    sprite: (id = 'pet') => new P({ id, name: id, size: 462, balanceEnabled: true }),
    histories,
    created,
    S,
    timers,
    get menuTree() {
      return menuTree;
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const rightClick = { preventDefault() {}, clientX: 10, clientY: 20 };

test('native history setup, resize retention, menu branches and old-bundle fallback', async () => {
  const h = harness();
  const pet = h.sprite();
  assert.equal(h.created[0], 'pet');
  assert.equal(pet.size, 462);
  assert.equal(pet.height, (462 * 9) / 16);
  assert.equal(pet.resizeHandle.attrs['aria-label'], '拖动调整宠物大小');
  pet.onContextMenu(rightClick);
  assert(h.menuTree.some((n) => n.label === '动作历史' && n.children[0].label === '暂无动作历史'));
  assert(h.menuTree.some((n) => n.label === '动作'));
  assert(h.menuTree.some((n) => n.label === '显示位置'));
  assert(h.menuTree.some((n) => n.action === 'show-balance'));
  assert(h.menuTree.some((n) => n.action === 'reload'));
  h.sprite('other');
  assert.deepEqual(h.histories.get('other'), []);
  assert.deepEqual(h.created, ['pet', 'other']);
  delete h.S.createActionHistory;
  delete h.S.buildActionHistoryMenu;
  const legacy = h.sprite('legacy');
  assert.equal(legacy.actionHistory, null);
  legacy.switchTo('旧bundle动作', true);
  legacy.videoB.dispatch('loadeddata');
  await flush();
  legacy.onContextMenu(rightClick);
  assert(!h.menuTree.some((n) => n.label === '动作历史'));
});

test('native history records successful front playback, not intent, failures or stale callbacks', async () => {
  const h = harness();
  const pet = h.sprite();
  const names = () => h.histories.get('pet').map((x) => x.name);
  pet.playOnce('真实动作');
  assert.equal(names().length, 0);
  pet.videoB.dispatch('loadeddata');
  await flush();
  assert.deepEqual(names(), ['真实动作']);
  pet.videoB.dispatch('loadeddata');
  await flush();
  assert.equal(names().length, 1);
  pet.videoA.playResult = Promise.reject(new Error('blocked'));
  pet.switchTo('失败动作', true);
  pet.videoA.dispatch('loadeddata');
  await flush();
  assert.equal(names().length, 1);
  pet.videoA.playResult = null;
  pet.switchTo('素材错误', true);
  pet.videoB.onerror();
  pet.videoB.dispatch('loadeddata');
  await flush();
  assert.equal(names().length, 1);
  pet.switchTo('超时动作', true);
  [...h.timers.values()].at(-1)();
  pet.videoB.dispatch('loadeddata');
  await flush();
  assert.equal(names().length, 1);
  pet.switchTo('被替代请求', true);
  pet.switchTo('有效请求', true);
  pet.videoB.dispatch('loadeddata');
  await flush();
  assert.deepEqual(names(), ['真实动作', '有效请求']);
  let resolveOld;
  pet.videoA.playResult = new Promise((r) => {
    resolveOld = r;
  });
  pet.switchTo('迟到播放', true);
  pet.videoA.dispatch('loadeddata');
  pet.switchTo('当前播放', true);
  pet.videoB.dispatch('loadeddata');
  await flush();
  resolveOld();
  await flush();
  assert.deepEqual(names(), ['真实动作', '有效请求', '当前播放']);
  pet.onContextMenu(rightClick);
  assert.equal(h.menuTree.find((n) => n.label === '动作历史').children.length, 3);
});

test('history retains upstream external playback receipts, including ended while resizing', async () => {
  const h = harness();
  const pet = h.sprite();
  const receipts = [];
  pet.reportPlayback = (...args) => receipts.push(args);
  pet.playOnce('外部点播', 'request-1');
  pet.videoB.dispatch('loadeddata');
  await flush();
  assert.deepEqual(receipts, [['request-1', 'playing']]);
  assert.deepEqual(
    h.histories.get('pet').map((x) => x.name),
    ['外部点播'],
  );
  pet.resizing = true;
  pet.handleEnded();
  assert.deepEqual(receipts, [
    ['request-1', 'playing'],
    ['request-1', 'ended'],
  ]);
  assert.equal(pet.playback, null);
});

test('external URL playback records a safe label without losing playback receipts', async () => {
  const h = harness();
  const pet = h.sprite();
  const receipts = [];
  const url = 'https://media.example/clip.webm?token=secret-signature#private';
  pet.reportPlayback = (...args) => receipts.push(args);
  pet.playUrlOnce(url, 'url-request');
  assert.equal(pet.videoB.src, url);
  assert.deepEqual(h.histories.get('pet'), []);
  pet.videoB.dispatch('loadeddata');
  await flush();
  assert.deepEqual(
    h.histories.get('pet').map((x) => x.name),
    ['外部动画'],
  );
  pet.onContextMenu(rightClick);
  const history = h.menuTree.find((n) => n.label === '动作历史');
  assert.equal(history.children[0].label, '外部动画');
  assert.ok(!JSON.stringify(h.histories.get('pet')).includes(url));
  assert.ok(!JSON.stringify(history).includes('secret-signature'));
  pet.playIdle = () => {};
  pet.videoB.onended();
  assert.deepEqual(receipts, [
    ['url-request', 'playing'],
    ['url-request', 'ended'],
  ]);
});

test('native history suppresses readiness and play completion after disposal', async () => {
  const h = harness();
  const before = h.sprite('before');
  before.switchTo('unmounted-before-ready', true);
  before.ac.abort();
  before.videoB.dispatch('loadeddata');
  await flush();
  assert.deepEqual(h.histories.get('before'), []);
  assert.equal(before.front, 0);
  const after = h.sprite('after');
  let resolve;
  after.videoB.playResult = new Promise((r) => {
    resolve = r;
  });
  after.switchTo('unmounted-before-play', true);
  after.videoB.dispatch('loadeddata');
  after.ac.abort();
  resolve();
  await flush();
  assert.deepEqual(h.histories.get('after'), []);
});
