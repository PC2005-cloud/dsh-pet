/**
 * 「吃白饭」的演出导演：取锁 → 跑到底部 → 期待开饭 → 追着吃 → 收场。
 *
 * 一台单一状态机：相位、场次代次、锁与朝向都在同一份场次状态里，所以本文件不按行数再拆——
 * 播放、位移、相位三块共享同一份状态，切开只会让改一处仍要同时改另一处。
 * 不负责菜单与素材：菜单在 ../baifan.ts，米饭与分数在 ./scene，接口调用在 ./transport。
 * 所有等待都问回执或播放进度，不用「素材多长」的定时器——定时器在素材加载失败时照样会走到「播完」。
 * @module dsh-pet/src/client/baifan/show
 */
import { CFG, LINES } from './constants.ts';
import type { ActivityAssets } from './assets.ts';
import { bottomNormY, geometry, spriteBox, type Geometry, type Pose, type SpriteBox } from './geometry.ts';
import { createLock, Halted, type Lock } from './lock.ts';
import type { RiceItem, Scene } from './scene.ts';
import type { Transport } from './transport.ts';

/** 演出对外暴露的面：一个入口、一个收场。 */
export interface Show {
  /** 开一场；重复调用等于重开（先彻底收掉上一场）。 */
  start: (petId: string, assets: ActivityAssets) => void;
  /** 收场：停一切、清干净、放锁。幂等。 */
  halt: (reason?: string) => Promise<void>;
  /** 这一场是否在跑；菜单用它避免重复开演。 */
  isRunning: () => boolean;
}

/** 建演出的依赖。 */
export interface ShowDeps {
  /** 接口调用与点播回执。 */
  transport: Transport;
  /** 米饭、分数与提示条。 */
  scene: Scene;
}

/** 相位：没开演 / 跑向底部 / 期待 / 追饭 / 吃。 */
type Phase = 'idle' | 'walk' | 'expect' | 'chase' | 'eat';

/** 侧身跑的接力令牌：每次换朝向、开始吃、收场都 +1，旧的那轮在下一个 await 后自弃。 */
interface SideChain {
  /** 当前令牌。 */
  token: number;
  /** 接力是否还活着（吃、收场会停掉它，之后必须能重新拉起）。 */
  active: boolean;
}

/**
 * 造演出导演。
 *
 * @param deps - 传输层与视觉层。
 * @returns 开演与收场。
 */
export function createShow(deps: ShowDeps): Show {
  const { transport, scene } = deps;

  /** 当前指挥的宠物 id（由菜单点击带回来，不猜）。 */
  let petId = '';
  /** 相位。 */
  let phase: Phase = 'idle';
  /** 本场是否在跑。 */
  let running = false;
  /** 插件是否已卸载。 */
  let disposed = false;
  /** 占用锁；null = 没锁。 */
  let lock: Lock | null = null;
  /** 已经吃了几份。 */
  let eaten = 0;
  /** 当前朝向。 */
  let facing: 'left' | 'right' = 'left';
  /** 最近一次量到的精灵尺寸。 */
  let sprite: SpriteBox = { w: 0, h: 0 };
  /** 地面上跑的目标垂直坐标（归一化，宠物中心）。 */
  let groundNormY = 0.86;
  /** 没饭可追时的溜达目标（像素）；null = 该重新抽一个。 */
  let patrolX: number | null = null;
  /** 侧身跑接力。 */
  const side: SideChain = { token: 0, active: false };
  /** 吃满多少份吹一次牛。 */
  const FULL_EVERY = 5;

  /** 本场代次：每次开演 +1，旧场收尾时不能动新的一场。 */
  let showGen = 0;
  /** 这一场用的五段动画地址（按被点宠物所属条目的配置算出来）。 */
  let current: ActivityAssets = { chase: '', descend: '', eatBall: '', eatBowl: '', expect: '' };
  /** 掉饭定时器。 */
  let spawnTimer = 0;
  /** 跑动动画看门狗。 */
  let sideWatch = 0;

  /** 行为是否还该继续。 */
  const alive = (): boolean => running && !disposed && lock !== null && !lock.isLost();
  const enc = (s: string): string => encodeURIComponent(s);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
  const pickLine = (pool: readonly string[]): string => pool[Math.floor(Math.random() * pool.length)] ?? '';

  /** 让桌宠说一句：`anim: false` 必须给，否则渲染端会联动 whisper 动画把正在播的顶掉。 */
  function say(text: string, ms?: number): void {
    const lease = lock?.id() ?? null;
    if (!alive() || lease === null) return;
    void transport
      .call('POST', '/broadcast?pet=' + enc(petId) + '&surface=web&lock=' + enc(lease), {
        text,
        duration: ms !== undefined ? ms : CFG.bubbleMs,
        anim: false,
      })
      .catch(() => {});
  }

  /** 读一次实况；读不到返回 null。 */
  function pose(): Pose | null {
    return transport.pose(petId);
  }

  /** 读实况并换算几何量；读不到返回 null。 */
  function currentGeometry(): Geometry | null {
    const p = pose();
    if (p === null) return null;
    const box = measure(p);
    return geometry(p, box);
  }

  /** 量精灵盒子（量到就更新缓存）。 */
  function measure(p: Pose): SpriteBox {
    sprite = spriteBox(p.x * window.innerWidth, p.y * window.innerHeight, sprite);
    return sprite;
  }

  /** 点播一段玩法动画（按名字）；返回点播编号。 */
  async function playAnim(name: string, dir?: 'left' | 'right'): Promise<string | null> {
    const lease = lock?.id() ?? null;
    if (lease === null) throw new Halted();
    const body: Record<string, unknown> = { name };
    if (dir !== undefined) body.facing = dir;
    const r = await transport.call('POST', '/anim?pet=' + enc(petId) + '&surface=web&lock=' + enc(lease), body);
    if (r.ok !== true) {
      lock?.noteFailure(r.reason);
      throw new Error('点播失败：' + String(r.reason ?? 'unknown'));
    }
    return typeof r.playbackId === 'string' ? r.playbackId : null;
  }

  /** 读这次点播的真实片长（毫秒）；读不到用兜底。 */
  async function clipMs(id: string | null): Promise<number> {
    if (id !== null) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const p = transport.progress(petId);
        if (p !== null && p.playbackId === id && p.duration > 0.2) return p.duration * 1000;
        await sleep(60);
      }
    }
    return CFG.flyFallbackMs;
  }

  /**
   * 守着一段正在播的素材，等它快到尾巴时返回 true。
   *
   * 回执只说「结束了没有」，而 progress 有 currentTime / duration，能在还剩一点尾巴时就点下一段——
   * 锁占用期间宠物自己是静止的，一段播完到下一段开始之间的空档就是「在滑但没有跑步动画」。
   *
   * @param id - 要守的那一次的 playbackId。
   * @returns true = 该接下一段了；false = 这段已经不属于我们。
   */
  async function keepWarm(id: string | null): Promise<boolean> {
    if (id === null) return false;
    const start = performance.now();
    const deadline = start + CFG.waitBudgetMs;
    let seen = false;
    for (;;) {
      const p = transport.progress(petId);
      if (p !== null && p.playbackId === id) {
        seen = true;
        if (p.paused) return true;
        if (p.duration > 0.3 && p.currentTime >= p.duration - CFG.preRollSec) return true;
      } else if (seen) {
        return false;
      } else if (performance.now() - start > CFG.pollLatencyMs + 800) {
        // 一直没轮到我们播（被 busy 吞了 / 还没换源）：交给调用方重点一次
        return true;
      }
      if (performance.now() > deadline) return false;
      await sleep(90);
    }
  }

  /** 下发一次位置。 */
  async function movePet(xNorm: number, yNorm: number, mode: 'instant' | 'line', durationMs?: number): Promise<void> {
    const lease = lock?.id() ?? null;
    if (lease === null) return;
    const body: Record<string, unknown> = { x: clamp(xNorm), y: clamp(yNorm), mode };
    if (mode === 'line') body.duration = Math.max(0, durationMs ?? 0);
    const r = await transport.call('POST', '/position?pet=' + enc(petId) + '&surface=web&lock=' + enc(lease), body);
    if (r.ok !== true) lock?.noteFailure(r.reason);
  }

  /** 等宠物走到某个位置；渲染端对 /state 是每秒轮询，所以只负责「等到它到」。 */
  async function waitArrive(goalX: number | null, goalY: number | null, budgetMs: number): Promise<void> {
    const deadline = performance.now() + budgetMs;
    for (;;) {
      const p = transport.pose(petId);
      if (p === null) return;
      const okX = goalX === null || Math.abs(p.x * window.innerWidth - goalX) <= CFG.arrivePx;
      const okY = goalY === null || Math.abs(p.y - goalY) <= 0.02;
      if (okX && okY) return;
      if (!alive() || performance.now() > deadline) return;
      await sleep(100);
    }
  }

  /**
   * 把一段直线位移拆成几段依次下发。
   *
   * 目的不是画质，是抗单条指令失效：渲染端若把某一条 line 当成直接落位，拆开后那一下只丢 1/n 的距离。
   */
  async function glideTo(xNorm: number, yNorm: number, ms: number, steps: number): Promise<void> {
    const start = transport.pose(petId);
    if (start === null) return;
    const n = Math.max(1, Math.min(8, steps));
    const part = ms / n;
    for (let step = 1; step <= n; step += 1) {
      const t = step / n;
      await movePet(start.x + (xNorm - start.x) * t, start.y + (yNorm - start.y) * t, 'line', part);
      if (!alive()) return;
      await sleep(part + 60);
    }
  }

  /**
   * 原地挪 2 像素，把渲染端的「起点」喂给它。
   *
   * 进入页面后的第一条位置指令不做插值——那一刻还没有「上一个位置」，于是直接落到目标点，
   * 表现就是第一次点「吃白饭」时宠物瞬移到底部。先来一条几乎为零的位移把起点建立起来。
   */
  async function warmPosition(): Promise<void> {
    const p = transport.pose(petId);
    if (p === null) return;
    await movePet(p.x, clamp(p.y - 0.003), 'line', 140);
    await sleep(220);
  }

  /** 让侧身跑接力下去；返回第一遍的 playbackId（永远会 settle）。 */
  function runSide(dir: 'left' | 'right'): Promise<string | null> {
    facing = dir;
    side.token += 1;
    const token = side.token;
    side.active = true;
    const started = playAnim(current.chase, dir).catch(() => null);
    void (async () => {
      let id = await started;
      for (;;) {
        if (token !== side.token || !alive()) return;
        if (id === null) {
          // 被 busy 吞了 / 素材没拿到：缓一拍再点，别把节奏打散
          await sleep(400);
          if (token !== side.token) return;
          id = await playAnim(current.chase, dir).catch(() => null);
          continue;
        }
        if (!(await keepWarm(id))) {
          if (token === side.token) side.active = false;
          return;
        }
        if (token !== side.token || !alive()) return;
        id = await playAnim(current.chase, dir).catch(() => null);
      }
    })();
    return started;
  }

  /** 保证「往 dir 跑」这段动画在接力中；换朝向或接力断了都要重开。 */
  function ensureSide(dir: 'left' | 'right'): Promise<string | null> | null {
    if (dir === facing && side.active) return null;
    return runSide(dir);
  }

  /** 等这段动画真的开始播；位移一定要等它，否则就是「人先滑出去，动画才跟上」。 */
  async function waitPlayStarted(pending: Promise<string | null> | null, budgetMs: number): Promise<void> {
    if (pending === null) return;
    const id = await pending;
    if (id === null) return;
    const deadline = performance.now() + budgetMs;
    for (;;) {
      const p = transport.progress(petId);
      if (p !== null && p.playbackId === id) return;
      if (!alive() || performance.now() > deadline) return;
      await sleep(40);
    }
  }

  /** 前台现在播的是不是这一段侧身跑（兜底判据：位置写入会不会顶掉点播，文档没有保证）。 */
  function sidePlaying(): boolean {
    const p = transport.progress(petId);
    return p !== null && typeof p.anim === 'string' && p.anim === current.chase;
  }

  /** 追饭期间的看门狗：跑动动画掉了就补。 */
  function startSideWatch(): void {
    stopSideWatch();
    sideWatch = window.setInterval(() => {
      if (!alive() || phase !== 'chase' || sidePlaying()) return;
      side.active = false;
      void runSide(facing);
    }, CFG.sideWatchMs);
  }

  function stopSideWatch(): void {
    if (sideWatch !== 0) window.clearInterval(sideWatch);
    sideWatch = 0;
  }

  /** 跑一段；返回是否真的发了一段位移（已在目标点时为 false）。 */
  async function tripTo(goalPx: number, speed: number): Promise<boolean> {
    const p = transport.pose(petId);
    if (p === null) return false;
    const petPx = p.x * window.innerWidth;
    const distance = Math.abs(goalPx - petPx);
    if (distance <= CFG.arrivePx) return false;
    const dir = goalPx > petPx ? 'right' : 'left';
    const durationMs = Math.min(CFG.tripMaxMs, Math.max(180, (distance / speed) * 1000));
    await waitPlayStarted(ensureSide(dir), CFG.animLeadMs);
    await movePet(goalPx / window.innerWidth, groundNormY, 'line', durationMs);
    await waitArrive(goalPx, groundNormY, durationMs + CFG.pollLatencyMs + 600);
    return true;
  }

  /** 一阶段：跑到底部。蓄力 → 直线跑到随机落点（每次都不一样，是第一眼观感）。 */
  async function phaseWalk(): Promise<void> {
    phase = 'walk';
    const geom = currentGeometry();
    if (geom === null) throw new Error('这一页找不到这只宠物');
    groundNormY = bottomNormY(geom);
    const margin = Math.max(60, geom.w / 2);
    const targetPx = margin + Math.random() * Math.max(10, window.innerWidth - margin * 2);
    facing = targetPx >= geom.cx ? 'right' : 'left';
    say(pickLine(LINES.down), 2400);
    await warmPosition();
    await playAnim(current.descend, facing);
    await sleep(CFG.prepMs);
    if (!alive()) throw new Halted();
    await glideTo(targetPx / window.innerWidth, groundNormY, CFG.travelMs, 3);
    await waitArrive(targetPx, groundNormY, CFG.pollLatencyMs + 1500);
    if (!alive()) throw new Halted();
  }

  /** 二阶段：期待开饭；尾巴上就开始接侧身跑，免得播完站在那儿等。 */
  async function phaseExpect(): Promise<void> {
    phase = 'expect';
    say(pickLine(LINES.expect), 3000);
    await keepWarm(await playAnim(current.expect, facing));
    if (!alive()) throw new Halted();
  }

  /** 吃掉一份：飞到嘴边 → 随咀嚼变小 → 空碗落地 → 弹分数。 */
  async function eatOne(item: RiceItem, geom: Geometry): Promise<void> {
    phase = 'eat';
    // 先把侧身跑接力停掉，否则它会在吃动画开始时把这一段顶掉
    side.token += 1;
    side.active = false;
    scene.detach(item);
    const isBowl = item.type === 'bowl';

    const p = transport.pose(petId);
    const [, playId] = await Promise.all([
      p === null ? null : movePet(p.x, groundNormY, 'instant').catch(() => null),
      playAnim(isBowl ? current.eatBowl : current.eatBall, facing).catch(() => null),
    ]);
    const flyMs = await clipMs(playId);

    // 动画已经开播，这一刻的位置才是嘴的位置
    const settled = transport.pose(petId);
    const g = settled === null ? geom : geometry(settled, measure(settled));
    const mouthX = g.cx + CFG.mouthDx * g.w * (facing === 'right' ? -1 : 1);
    const mouthY = g.mouthY;
    scene.flyToMouth(item, mouthX, mouthY, flyMs);
    if (isBowl) window.setTimeout(() => scene.dropEmptyBowl(mouthX, mouthY, g.scale), Math.max(0, flyMs - 120));

    await transport.waitPlayback(playId);
    if (!running || disposed) return;

    eaten += 1;
    scene.popScore(eaten, item.type, g);
    say(pickLine(isBowl ? LINES.bowl : LINES.ball), 2400);
    // 吃到一定数量才吹牛，不然每口都来一句会烦
    if (eaten % FULL_EVERY === 0) window.setTimeout(() => say(pickLine(LINES.full), 2600), 1200);
    phase = 'chase';
  }

  /** 开刷：先掉一份，之后按间隔继续；场上满了就自然停下。 */
  function startSpawning(): void {
    if (spawnTimer !== 0) return;
    scene.spawn(scene.scaleOf(sprite.w));
    scene.kick();
    spawnTimer = window.setInterval(() => {
      if (phase !== 'chase' && phase !== 'eat') return;
      scene.spawn(scene.scaleOf(sprite.w));
      scene.kick();
    }, CFG.spawnMs);
  }

  /** 三阶段：追饭。一段一段地跑，跑到了才做下一个决定。 */
  async function phaseChase(gen: number): Promise<never> {
    phase = 'chase';
    startSpawning();
    startSideWatch();
    say(pickLine(LINES.drop), 2200);
    while (alive() && gen === showGen) {
      const geom = currentGeometry();
      if (geom === null) throw new Error('这一页找不到这只宠物');
      groundNormY = bottomNormY(geom);
      const target = scene.nearest(geom.cx, facing);
      const eatPx = CFG.eatPx * (geom.w / CFG.refWidth);
      if (target !== null && Math.abs(target.x - geom.cx) <= eatPx) {
        await eatOne(target, geom);
        continue;
      }
      const goalPx = target !== null ? target.x : patrolGoal(geom);
      const speed = target !== null ? CFG.runSpeed : CFG.runSpeed * CFG.patrolSpeedRatio;
      // 已经在目标点上（没发指令）就歇一拍，否则这段循环会空转成死循环
      if (!(await tripTo(goalPx, speed))) await sleep(CFG.idleMs);
    }
    throw new Halted();
  }

  /** 没饭可追时随便挑个地方跑过去，到了下一拍再挑。 */
  function patrolGoal(geom: Geometry): number {
    const margin = Math.max(80, geom.w * 0.4);
    const petPx = geom.cx;
    if (patrolX === null || Math.abs(patrolX - petPx) <= CFG.arrivePx) {
      patrolX = margin + Math.random() * Math.max(10, window.innerWidth - margin * 2);
    }
    return patrolX;
  }

  /** 跑完整场演出。 */
  async function runShow(): Promise<void> {
    running = true;
    eaten = 0;
    side.token += 1;
    side.active = false;
    patrolX = null;
    phase = 'idle';

    try {
      await lock?.acquire();
      lock?.startRenew();
      say(pickLine(LINES.start), 2200);
      await phaseWalk();
      await phaseExpect();
      await phaseChase(showGen);
    } catch (error) {
      if (error instanceof Halted) {
        // 正常收场（丢锁 / 卸载）
      } else if (lock?.isLost() === true) {
        scene.toast('锁丢了，表演结束');
      } else {
        scene.toast(error instanceof Error ? error.message : String(error));
        console.warn('[dsh-pet] 吃白饭异常', error);
      }
    } finally {
      await halt(lock?.isLost() === true ? '用户接管，已收场' : '');
    }
  }

  /** 收场：停一切、清干净、放锁；幂等，丢锁与卸载都会走到这儿。 */
  async function halt(reason?: string): Promise<void> {
    const wasRunning = running;
    running = false;
    phase = 'idle';
    // 把还挂在半路的请求切掉：不然它们会带着旧令牌回来继续动这只宠物
    transport.attach(null);
    if (spawnTimer !== 0) {
      window.clearInterval(spawnTimer);
      spawnTimer = 0;
    }
    stopSideWatch();
    side.token += 1;
    side.active = false;
    scene.clear();
    patrolX = null;
    const lease = lock?.id() ?? null;
    await lock?.release();
    if (reason !== undefined && reason !== '' && (wasRunning || lease !== null)) scene.toast(reason);
  }

  /** 开一场；先彻底收掉上一场（含放锁），再起新的。 */
  function start(nextPetId: string, assets: ActivityAssets): void {
    if (running || lock?.id() != null) {
      void halt('重新开始').then(() => begin(nextPetId, assets));
      return;
    }
    begin(nextPetId, assets);
  }

  /** 真正开演：重建这一场的锁、取消信号与素材地址。 */
  function begin(nextPetId: string, assets: ActivityAssets): void {
    petId = nextPetId;
    current = assets;
    showGen += 1;
    disposed = false;
    lock?.stopRenew();
    lock = createLock(transport, petId, alive, scene.toast);
    transport.attach(new AbortController());
    scene.toast('吃白饭 —— 开饭了');
    void runShow();
  }

  return {
    halt,
    isRunning: () => running,
    start,
  };
}

/** 归一化坐标夹到 0–1。 */
const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
