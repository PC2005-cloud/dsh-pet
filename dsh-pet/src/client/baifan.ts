/**
 * 内置玩法「吃白饭」的挂载点：覆盖层、样式、菜单项与点击分发。
 *
 * 由 app.ts 的 apply 直接挂载，不注册第二个客户端模块——DSH 的启动图按包声明，
 * 同一个 bundle 里第二次 load 的 factory 不会被任何行 materialize，apply 永远不会跑。
 * 菜单注册走 HTTP（/config 判断玩法、/menu/item 交给宿主），点击读页面内 Cordis 服务
 * `petApi7340.menuEvents`：同一份点击的本地读取，不必绕一圈长轮询。
 * @module dsh-pet/src/client/baifan
 */
import { activityAssets } from './baifan/assets.ts';
import { ACTIVITY, CSS, LABEL, OWNER, ROOT_ID, ROUTE, STYLE_TAG } from './baifan/constants.ts';
import { createScene } from './baifan/scene.ts';
import { createShow, type Show } from './baifan/show.ts';
import { createTransport } from './baifan/transport.ts';

/** 点击轮询间隔（毫秒）：读的是内存 Map，间隔只决定点击到响应的最大延迟。 */
const POLL_MS = 150;

/** 菜单注册失败后的重试间隔（毫秒）：DSH 重启会清掉宿主那份注册表。 */
const RETRY_MS = 5000;

/** 页面内点击源的最小形状：`ok: false` 表示这个 owner 在本页还没有菜单项。 */
interface MenuEventSource {
  /** 读取即消费：返回后所有标记清回 null。 */
  menuEvents?: (owner: string) => { ok: boolean; events?: Record<string, string | null> };
}

/** 本模块用到的客户端上下文子集。 */
export interface BaifanContext {
  /** 取页面内 Cordis 服务（服务名 → 实例）；缺失返回 undefined。 */
  get: (name: string) => unknown;
}

/**
 * 调一次 HTTP 接口。
 *
 * 业务失败一律 HTTP 200 + `ok: false`，所以这里不抛；只有网络层失败才抛给调用方。
 *
 * @param method - HTTP 方法。
 * @param path - 含查询串的路径。
 * @param body - 有则按 JSON 发。
 * @param signal - 取消信号；卸载时用它掐断还挂着的那次请求。
 * @returns 解析后的响应体；解析失败时 `ok: false`。
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const init: RequestInit = { method };
  if (signal !== undefined) init.signal = signal;
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(ROUTE + path, init);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'bad-response' };
  }
}

/**
 * 注入样式表（只注入一次）。
 *
 * @returns 本次新插入的标签；已存在时返回 null（卸载时不删别人的）。
 */
function injectCss(): HTMLStyleElement | null {
  if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return null;
  const tag = document.createElement('style');
  tag.dataset.plugin = OWNER;
  tag.dataset.pluginCss = STYLE_TAG;
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return tag;
}

/**
 * 挂载「吃白饭」：建覆盖层、注册菜单、按拍读取页面内的点击。
 *
 * @param ctx - 客户端上下文；只用来取 `petApi7340` 这个只读服务。
 * @returns 卸载钩子：撤菜单、停轮询、清覆盖层。
 */
export function mountBaifan(ctx: BaifanContext): () => void {
  let disposed = false;
  let timer: number | null = null;
  let registeredAt = 0;
  const abort = new AbortController();

  const style = injectCss();
  const layer = document.createElement('div');
  layer.id = ROOT_ID;
  const toastEl = document.createElement('div');
  toastEl.className = 'bf-toast';
  layer.appendChild(toastEl);
  document.body.appendChild(layer);

  const scene = createScene(layer, toastEl);
  const transport = createTransport(ctx);
  const show: Show = createShow({ transport, scene });

  /** 读一次页面内点击；服务缺失（老版本 dsh-pet）或 owner 还没进快照都返回 null。 */
  function readMarks(): Record<string, string | null> | null {
    const api = ctx.get('petApi7340') as MenuEventSource | undefined;
    const read = api?.menuEvents;
    if (typeof read !== 'function') return null;
    const result = read.call(api, OWNER);
    return result.ok === true && result.events ? result.events : null;
  }

  /** 只有 main 条目配置了 animations.baifan 才注册，否则这只宠物没有这个玩法。 */
  async function ensureMenu(): Promise<void> {
    const cfg = await call('GET', '/config', undefined, abort.signal);
    const main = cfg.main;
    if (!main || typeof main !== 'object') return;
    const animations = (main as Record<string, unknown>).animations;
    if (!animations || typeof animations !== 'object') return;
    if ((animations as Record<string, unknown>)[ACTIVITY] === undefined) return;
    const r = await call('POST', '/menu/item', { owner: OWNER, labels: [LABEL], target: 'web' }, abort.signal);
    if (r.ok === true) registeredAt = performance.now();
  }

  /** 一拍：读点击；owner 还不在快照里就按间隔补注册。 */
  function tick(): void {
    if (disposed) return;
    const marks = readMarks();
    if (marks === null) {
      // 没项 = 还没注册上，或 DSH 重启后宿主注册表空了；按间隔重试，不必等下次点击。
      if (performance.now() - registeredAt > RETRY_MS) {
        registeredAt = performance.now();
        void ensureMenu().catch(() => {});
      }
      return;
    }
    const pet = marks[LABEL];
    if (typeof pet === 'string') void launch(pet);
  }

  /**
   * 按被点宠物所属条目算素材地址并开演；找不到配置就不演。
   *
   * 素材根是条目 key（与 /thumb 的归属规则一致），5 个动画名来自该条目的 animations.baifan——
   * 不同宠物可以用不同的动作，这是配置项存在的意义。
   */
  async function launch(petId: string): Promise<void> {
    try {
      const cfg = await call('GET', '/config', undefined, abort.signal);
      for (const [entry, raw] of Object.entries(cfg)) {
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
        show.start(petId, activityAssets(slots, entry, petId));
        return;
      }
    } catch (error) {
      console.warn('[dsh-pet] 吃白饭启动失败 ' + String(error));
    }
  }

  void ensureMenu().catch((error: unknown) => console.warn('[dsh-pet] 吃白饭注册菜单失败 ' + String(error)));
  timer = window.setInterval(tick, POLL_MS);

  return () => {
    disposed = true;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    void show.halt('');
    // 先发 DELETE 再 abort：abort 会让这次删除立刻失败，留下一条到 TTL 才消失的菜单项。
    void fetch(ROUTE + '/menu/item?owner=' + encodeURIComponent(OWNER), { method: 'DELETE' }).catch(() => {});
    abort.abort();
    layer.remove();
    if (style !== null) style.remove();
  };
}
