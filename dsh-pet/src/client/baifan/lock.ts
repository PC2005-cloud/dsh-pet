/**
 * 「吃白饭」的占用锁：取锁、心跳续期、刷新后的接管、收场放锁。
 *
 * 锁的语义是「这段时间这只宠物归我指挥」：拿到之后宿主的自主行为会停，第三方也不能抢。
 * 刷新页面时旧页面的 JS 被直接销毁、来不及放锁，所以锁号记在 sessionStorage 里——
 * 同一标签页刷新后还在，下次开演先拿它续期，续得上说明那本来就是我的。
 * @module dsh-pet/src/client/baifan/lock
 */
import { CFG } from './constants.ts';
import type { Transport } from './transport.ts';

/** sessionStorage 里记锁号的键前缀（按宠物分开）。 */
const LOCK_KEY = 'dsh-pet-baifan/lock/';

/** 锁被撤掉的原因：用户拖走 / 过期 / 被别的插件抢。 */
export type LockLoss = 'lock-lost' | 'lock-required' | null;

/** 「被用户打断」用这个异常跳出去，避免走「出错」那条路。 */
export class Halted extends Error {}

/** 读本标签页上次拿到的锁号。 */
function readStored(petId: string): string | null {
  try {
    return sessionStorage.getItem(LOCK_KEY + petId);
  } catch {
    return null;
  }
}

/** 写入 / 清除本标签页的锁号；隐私模式或禁用存储都不影响演出。 */
function writeStored(petId: string, lock: string | null): void {
  try {
    if (lock === null) sessionStorage.removeItem(LOCK_KEY + petId);
    else sessionStorage.setItem(LOCK_KEY + petId, lock);
  } catch {
    // 存不下就算了：丢的是「刷新后接管」这一层便利，锁本身照常工作
  }
}

/**
 * 造锁管理器。
 *
 * @param transport - 接口调用。
 * @param petId - 要占住哪只宠物。
 * @param alive - 本场演出是否还该继续（收场后重试循环要立刻退出）。
 * @param toast - 提示条。
 * @returns 取锁、续期、放锁与状态读取。
 */
export function createLock(transport: Transport, petId: string, alive: () => boolean, toast: (text: string) => void) {
  /** 当前锁号；null = 没锁。 */
  let lockId: string | null = null;
  /** 心跳发现锁没了。 */
  let lost = false;
  /** 心跳定时器。 */
  let timer = 0;

  /** 锁类失败统一在这里判一下，省得每个调用点各写一遍。 */
  function noteFailure(reason: unknown): void {
    if (reason === 'lock-lost' || reason === 'lock-required') lost = true;
  }

  /** 取锁：先试刷新留下的旧锁，再新建，被占着就等它过期。 */
  async function acquire(): Promise<void> {
    const path = '/lock?pet=' + encodeURIComponent(petId) + '&surface=web';

    // 1) 先试「我自己的旧锁」（刷新页面留下的）
    const stored = readStored(petId);
    if (stored !== null) {
      const renewed = await transport.call('POST', path, { lockId: stored });
      if (renewed.ok === true) {
        lockId = String(renewed.lockId);
        lost = false;
        return;
      }
      writeStored(petId, null);
    }

    // 2) 新建
    const created = await transport.call('POST', path, { ttl: CFG.lockTtl });
    if (created.ok === true) {
      lockId = String(created.lockId);
      lost = false;
      writeStored(petId, lockId);
      return;
    }

    const reason = created.reason;
    if (reason === 'pet-not-displayed') {
      throw new Error('这只宠物没显示在网页里（display=' + String(created.display) + '）');
    }
    if (reason !== 'locked') throw new Error('取锁失败：' + String(reason ?? 'unknown'));

    // 3) 被占着：可能是上一场还没过期。等一等，别直接判死。
    const expiresAt = typeof created.expiresAt === 'number' ? created.expiresAt : 0;
    const waitMs = Math.min(CFG.lockWaitMs, Math.max(0, expiresAt - Date.now()) + 2000);
    toast('上一场还没收干净，等它过期…');
    const deadline = performance.now() + waitMs;
    for (;;) {
      if (!alive()) throw new Halted();
      if (performance.now() > deadline) break;
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (!alive()) throw new Halted();
      const retry = await transport.call('POST', path, { ttl: CFG.lockTtl });
      if (retry.ok === true) {
        lockId = String(retry.lockId);
        lost = false;
        writeStored(petId, lockId);
        return;
      }
      if (retry.reason !== 'locked') throw new Error('取锁失败：' + String(retry.reason ?? 'unknown'));
    }
    throw new Error('宠物被别人占着，等会儿再试');
  }

  /** 心跳：续期顺带探活；丢了置 lost，追击循环下一拍自然收场。 */
  function startRenew(): void {
    stopRenew();
    timer = window.setInterval(() => {
      void (async () => {
        if (!alive() || lockId === null || lost) return;
        try {
          const r = await transport.call('POST', '/lock?pet=' + encodeURIComponent(petId) + '&surface=web', { lockId });
          // 续不上就是丢了（过期 / 被拖走 / 被抢）——不必等 TTL
          if (r.ok !== true) {
            noteFailure(r.reason);
            lost = true;
          }
        } catch {
          // 网络抖动不算丢锁：下一拍再试
        }
      })();
    }, CFG.renewMs);
  }

  /** 停心跳。 */
  function stopRenew(): void {
    if (timer !== 0) window.clearInterval(timer);
    timer = 0;
  }

  /** 放锁（收场用）；放不掉也没关系，TTL 到点自己失效。 */
  async function release(): Promise<void> {
    const lease = lockId;
    lockId = null;
    if (lease === null) return;
    try {
      await transport.call('POST', '/lock/release?pet=' + encodeURIComponent(petId), { lockId: lease });
    } catch {
      // 交给 TTL
    }
    writeStored(petId, null);
  }

  /**
   * 页面要走了（刷新 / 关标签页）时尽最大努力放锁。
   *
   * fetch 在这个时机大概率会被掐断，所以用 sendBeacon：它由浏览器接管发送，页面死了也会发完。
   * 放不掉还有 TTL 与下次开演的「接管旧锁」兜底。
   */
  function releaseOnPageHide(): void {
    const lease = lockId;
    if (lease === null) return;
    lockId = null;
    writeStored(petId, null);
    try {
      if (navigator.sendBeacon !== undefined) {
        const body = JSON.stringify({ lockId: lease });
        navigator.sendBeacon(
          '/dsh-pet-7340/lock/release?pet=' + encodeURIComponent(petId),
          new Blob([body], { type: 'application/json' }),
        );
        return;
      }
    } catch {
      // 退到 TTL
    }
  }

  return {
    acquire,
    /** 当前锁号；null = 没锁。 */
    id: (): string | null => lockId,
    /** 心跳发现锁丢了。 */
    isLost: (): boolean => lost,
    noteFailure,
    release,
    releaseOnPageHide,
    startRenew,
    stopRenew,
  };
}

/** 锁管理器的公开面。 */
export type Lock = ReturnType<typeof createLock>;
