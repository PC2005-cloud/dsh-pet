/**
 * 自播动画链（src/client/pet/animation/animation.ts）的契约测试：假 video、假素材加载器、假 fetch。
 *
 * 四条契约：防重命中仍回 playing；换源会丢弃被新切换覆盖的迟到加载；
 * 首帧就位才翻前台并上报 playing；冻结与打断如实回 cancelled（且只回一次）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createOwnAnimation, type OwnAnimation, type OwnAnimationDeps } from './animation.ts';
import type { AssetHandlers, AssetLoader } from './asset-loader.ts';
import type { EndedCue } from './cues.ts';
import type { ReportableStatus } from '../../../shared/playback.ts';
import type { Animations } from '../../../shared/types.ts';

/** 假 video：只实现动画链用到的成员。 */
class FakeVideo {
  loop = true;
  muted = false;
  autoplay = false;
  playsInline = false;
  src = '';
  onended: ((event: Event) => void) | null = null;
  onerror: (() => void) | null = null;
  style: Record<string, string> = {};
  paused = true;
  listeners = new Map<string, Array<(event: Event) => void>>();
  playCalls = 0;
  loadCalls = 0;
  private readonly classes = new Set<string>();

  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  /** 触发一次事件（模拟浏览器派发）。 */
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ currentTarget: this } as unknown as Event);
    }
  }

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    this.loadCalls += 1;
  }
}

/** 假素材加载器：手动决定每次 load 的结局。 */
class FakeLoader implements AssetLoader {
  requests: Array<{ url: string; handlers: AssetHandlers }> = [];
  released: string[] = [];
  aborts = 0;

  load(url: string, handlers: AssetHandlers): void {
    this.requests.push({ url, handlers });
  }

  abortAll(): void {
    this.aborts += 1;
  }

  release(objectUrl: string): void {
    this.released.push(objectUrl);
  }
}

const animations = {
  idle: ['idle1'],
  turn: ['turn1'],
  drag: ['drag1'],
  clicks: ['click1'],
  moves: { default: {}, actions: [] },
  categories: [],
  events: { workStatus: [['ws-run-a', 'ws-run-b']], balance: ['bal1'] },
} as unknown as Animations;

/** 装配一套依赖：两只假 video、假加载器、记录回执与判定。 */
function harness(overrides: Partial<OwnAnimationDeps> = {}) {
  const videoA = new FakeVideo();
  const videoB = new FakeVideo();
  const loader = new FakeLoader();
  const reports: Array<{ id: string; status: ReportableStatus; reason?: string }> = [];
  const ended: EndedCue[] = [];
  const ready: HTMLVideoElement[] = [];
  const started: string[] = [];
  let currentAnim = 'idle1';
  let workState: string | null = null;
  let dragging = false;
  let cleared = 0;
  const deps: OwnAnimationDeps = {
    videoA: () => videoA as unknown as HTMLVideoElement,
    videoB: () => videoB as unknown as HTMLVideoElement,
    cfg: () => ({ id: 'pet-1', assetRoot: 'duck', animations }),
    currentAnim: () => currentAnim,
    workStatus: () => (workState === null ? null : ({ state: workState } as never)),
    facing: () => 'left',
    report: (id, status, reason) => reports.push({ id, status, reason }),
    clearCuePlayback: () => {
      cleared += 1;
    },
    onFrontReady: (el) => ready.push(el),
    onStarted: (name) => started.push(name),
    onEnded: (cue) => ended.push(cue),
    isDragging: () => dragging,
    initiallyFrozen: false,
    loader,
  };
  const anim: OwnAnimation = createOwnAnimation({ ...deps, ...overrides });
  return {
    anim,
    videoA,
    videoB,
    loader,
    reports,
    ended,
    ready,
    started,
    get cleared() {
      return cleared;
    },
    setCurrentAnim: (name: string) => {
      currentAnim = name;
    },
    setWorkState: (state: string | null) => {
      workState = state;
    },
    setDragging: (value: boolean) => {
      dragging = value;
    },
  };
}

describe('createOwnAnimation —— 换源与回执', () => {
  test('普通换源：目标槽位挂上 blob 地址并 load', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, null);
    const [request] = h.loader.requests;
    assert.ok(request.url.includes('/thumb/duck/idle1'), request.url);
    request.handlers.onObjectUrl('blob:1');
    // 首次换源写的是后台槽位 B。
    assert.equal(h.videoB.src, 'blob:1');
    assert.equal(h.videoB.loadCalls, 1);
  });

  test('首帧就位：翻前台、开始播放并回 playing', async () => {
    const h = harness();
    h.anim.switchTo('idle1', true, 'pb-1');
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    h.videoB.fire('loadeddata');
    // playing 回执挂在 play() 的微任务上：只有兑现才代表确实开始出画。
    await Promise.resolve();
    assert.equal(h.videoB.classList.contains('is-front'), true);
    assert.equal(h.videoB.playCalls, 1);
    assert.deepEqual(h.reports, [{ id: 'pb-1', status: 'playing', reason: undefined }]);
    assert.equal(h.ready.length, 1, '就位后要通知组件补 Q 弹与走位');
    assert.equal(h.anim.frontVideo(), h.videoB);
  });

  test('防重命中：上一次换源还挂着时重复请求，不重新取素材但如实回 playing', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, 'pb-1');
    // 首帧还没到就又来了同一条请求（点播编号随 state 变化会再驱动一次 effect）。
    h.reports.length = 0;
    h.anim.switchTo('idle1', true, 'pb-2');
    assert.equal(h.loader.requests.length, 1, '同一段已在播，不该再取一次素材');
    assert.deepEqual(h.reports, [{ id: 'pb-2', status: 'playing', reason: undefined }]);
  });

  test('被新切换覆盖的迟到加载：拿到的地址立即释放，不写进元素', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, null);
    const first = h.loader.requests[0];
    h.anim.switchTo('turn1', true, null);
    const second = h.loader.requests[1];
    first.handlers.onObjectUrl('blob:stale');
    assert.deepEqual(h.loader.released, ['blob:stale'], '迟到的那份必须释放');
    second.handlers.onObjectUrl('blob:fresh');
    assert.equal(h.videoB.src, 'blob:fresh');
  });

  test('素材加载失败：点播回 failed，且释放挂起的换源', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, 'pb-1');
    h.loader.requests[0].handlers.onError(new Error('HTTP 404'));
    assert.deepEqual(h.reports, [{ id: 'pb-1', status: 'failed', reason: 'asset-load' }]);
    // 释放后再切同一段不会被防重挡住。
    h.anim.switchTo('idle1', true, null);
    assert.equal(h.loader.requests.length, 2);
  });

  test('点播编号消费一次：switchTo 会通知组件清掉它', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, 'pb-1');
    assert.equal(h.cleared, 1);
    h.anim.switchTo('idle1', true, null);
    assert.equal(h.cleared, 1, '没有点播编号就不该再清');
  });

  test('url 形态：一次性交接，用完整地址而不拼路由', () => {
    const h = harness();
    h.anim.setCueUrl('https://example.com/a.webm');
    h.anim.switchTo('https://example.com/a.webm', true, null);
    assert.equal(h.loader.requests[0].url, 'https://example.com/a.webm');
  });
});

describe('createOwnAnimation —— 播完与冻结', () => {
  test('播完先回 ended，再按动画池给判定', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, 'pb-1');
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    h.videoB.fire('loadeddata');
    h.setCurrentAnim('idle1');
    const cue = h.anim.handleEnded({ currentTarget: h.videoB } as unknown as Event);
    assert.deepEqual(h.reports[h.reports.length - 1], { id: 'pb-1', status: 'ended', reason: undefined });
    assert.deepEqual(cue, { kind: 'random' });
  });

  test('后台元素的 ended 一律丢弃', () => {
    const h = harness();
    const cue = h.anim.handleEnded({ currentTarget: h.videoA } as unknown as Event);
    assert.deepEqual(cue, { kind: 'ignore' });
  });

  test('拖拽中不推进动画链（但回执照旧）', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, 'pb-1');
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    h.videoB.fire('loadeddata');
    h.setDragging(true);
    const cue = h.anim.handleEnded({ currentTarget: h.videoB } as unknown as Event);
    assert.deepEqual(cue, { kind: 'ignore' });
    assert.deepEqual(h.reports[h.reports.length - 1], { id: 'pb-1', status: 'ended', reason: undefined });
  });

  test('冻结：暂停前台并如实回 cancelled；解冻只翻转状态', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, 'pb-1');
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    h.videoB.fire('loadeddata');
    const frozen = h.anim.setFrozen(true);
    assert.deepEqual(frozen, { kind: 'frozen' });
    assert.equal(h.videoB.paused, true, '冻结要把前台暂停');
    assert.deepEqual(h.reports[h.reports.length - 1], { id: 'pb-1', status: 'cancelled', reason: 'frozen' });
    assert.equal(h.anim.isFrozen(), true);
    assert.deepEqual(h.anim.setFrozen(false), { kind: 'resumed' });
    assert.equal(h.anim.setFrozen(false), null, '没翻转就不该再报');
  });

  test('冻结期间播完不推进', () => {
    const h = harness();
    h.anim.setFrozen(true);
    assert.deepEqual(h.anim.handleEnded(undefined), { kind: 'ignore' });
  });

  test('dispose：中断在途素材并释放已建地址', () => {
    const h = harness();
    h.anim.switchTo('idle1', true, null);
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    h.anim.dispose();
    assert.equal(h.loader.aborts, 1);
    assert.deepEqual(h.loader.released, ['blob:1']);
  });
});

describe('createOwnAnimation —— 开始出画回调（动作音效挂在这里）', () => {
  test('首帧就位才回调一次，带上动画名', () => {
    const h = harness();
    h.anim.switchTo('click1', true, null);
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    assert.deepEqual(h.started, []);
    h.videoB.fire('loadeddata');
    assert.deepEqual(h.started, ['click1']);
  });

  test('被新切换覆盖的那一段不回调：只响真正出画的动画', () => {
    const h = harness();
    h.anim.switchTo('click1', true, null);
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    // 两次换源落在同一后台槽位：首帧到达时只有后发的那一段真正翻到前台。
    h.anim.switchTo('drag1', false, null);
    h.loader.requests[1].handlers.onObjectUrl('blob:2');
    h.videoB.fire('loadeddata');
    assert.deepEqual(h.started, ['drag1']);
  });

  test('循环动画只在开始时回调，不随循环重复', () => {
    const h = harness();
    h.anim.switchTo('drag1', false, null);
    h.loader.requests[0].handlers.onObjectUrl('blob:1');
    h.videoB.fire('loadeddata');
    h.videoB.fire('ended');
    assert.deepEqual(h.started, ['drag1']);
  });
});
