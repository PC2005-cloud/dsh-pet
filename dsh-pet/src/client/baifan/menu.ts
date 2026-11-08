/**
 * 「吃白饭」的菜单与点播触发：注册宿主菜单项、按拍读点击、按配置开演。
 *
 * 点击源是页面内 Cordis 服务 `petApi7340.menuEvents`（读即消费），不绕 HTTP 长轮询；
 * 只有菜单注册走 HTTP。DSH 重启会清空宿主那份注册表，所以 owner 不在快照里时按间隔补注册。
 * @module dsh-pet/src/client/baifan/menu
 */
import { activityAssets } from './assets.ts';
import { ACTIVITY, LABEL, OWNER } from './constants.ts';
import type { Show } from './show.ts';
import type { Transport } from './transport.ts';

/** 页面内点击源的最小形状：`ok: false` 表示这个 owner 在本页还没有菜单项。 */
interface MenuEventSource {
  /** 读取即消费：返回后所有标记清回 null。 */
  menuEvents?: (owner: string) => { ok: boolean; events?: Record<string, string | null> };
}

/** 菜单与点播的依赖。 */
export interface MenuDeps {
  /** 取页面内 Cordis 服务（服务名 → 实例）；缺失返回 undefined。 */
  get: (name: string) => unknown;
  /** 传输层；调接口走它的 `call`，带超时与信号转发。 */
  transport: Transport;
  /** 演出；找到归属条目后开演。 */
  show: Show;
  /** 挂载级取消信号：菜单注册不该被单场演出收场取消。 */
  signal: AbortSignal;
  /** 补注册间隔（毫秒）：owner 不在快照里时按它重试。 */
  retryMs: number;
}

/**
 * 造菜单控制器。
 *
 * @param deps - 见 {@link MenuDeps}。
 * @returns 一拍入口、首次注册与卸载钩子。
 */
export function createMenu(deps: MenuDeps) {
  /** 上次尝试注册的时刻（`performance.now()`）；与 `retryMs` 比较决定要不要补。 */
  let registeredAt = 0;
  let disposed = false;

  /** 读一次页面内点击；服务缺失（老版本 dsh-pet）或 owner 还没进快照都返回 null。 */
  function readMarks(): Record<string, string | null> | null {
    const api = deps.get('petApi7340') as MenuEventSource | undefined;
    const read = api?.menuEvents;
    if (typeof read !== 'function') return null;
    const result = read.call(api, OWNER);
    return result.ok === true && result.events ? result.events : null;
  }

  /** 只有 main 条目配置了 animations.baifan 才注册，否则这只宠物没有这个玩法。 */
  async function ensureMenu(): Promise<void> {
    const cfg = await deps.transport.call('GET', '/config', undefined, deps.signal);
    const main = cfg.main;
    if (!main || typeof main !== 'object') return;
    const animations = (main as Record<string, unknown>).animations;
    if (!animations || typeof animations !== 'object') return;
    if ((animations as Record<string, unknown>)[ACTIVITY] === undefined) return;
    const r = await deps.transport.call(
      'POST',
      '/menu/item',
      { owner: OWNER, labels: [LABEL], target: 'web' },
      deps.signal,
    );
    if (r.ok === true) registeredAt = performance.now();
  }

  /** 一拍：读点击；owner 还不在快照里就按间隔补注册。 */
  function tick(): void {
    if (disposed) return;
    const marks = readMarks();
    if (marks === null) {
      // 没项 = 还没注册上，或 DSH 重启后宿主注册表空了；按间隔重试，不必等下次点击。
      if (performance.now() - registeredAt > deps.retryMs) {
        registeredAt = performance.now();
        void ensureMenu().catch(() => {});
      }
      return;
    }
    const pet = marks[LABEL];
    if (typeof pet === 'string') void launch(pet);
  }

  /**
   * 按被点宠物所属条目取五段动画名并开演；找不到配置就不演。
   *
   * 5 个动画名来自该条目的 animations.baifan——不同宠物可以用不同的动作，这是配置项存在的意义；
   * 素材地址由各端渲染器按宠物的素材根拼，客户端这里只传名字。
   */
  async function launch(petId: string): Promise<void> {
    try {
      const cfg = await deps.transport.call('GET', '/config', undefined, deps.signal);
      for (const raw of Object.values(cfg)) {
        if (!raw || typeof raw !== 'object') continue;
        const conf = raw as Record<string, unknown>;
        const pets = conf.pets;
        if (!Array.isArray(pets)) continue;
        const owns = pets.some(
          (item) => item !== null && typeof item === 'object' && (item as Record<string, unknown>).id === petId,
        );
        if (!owns) continue;
        const animations = conf.animations;
        const names =
          animations && typeof animations === 'object' ? (animations as Record<string, unknown>)[ACTIVITY] : undefined;
        if (!Array.isArray(names)) return;
        const slots = names.filter((name): name is string => typeof name === 'string');
        deps.show.start(petId, activityAssets(slots));
        return;
      }
    } catch (error) {
      console.warn('[dsh-pet] 吃白饭启动失败 ' + String(error));
    }
  }

  return {
    /** 一拍：读点击、必要时补注册。 */
    tick,
    /** 首次注册菜单项；配置里没有这个玩法时什么都不做。 */
    ensureMenu,
    /** 停掉后续拍；已发出的请求由 `signal` 收尾。 */
    dispose: (): void => {
      disposed = true;
    },
  };
}
