/**
 * 内置玩法「吃白饭」的挂载点：覆盖层、样式、菜单项与点击分发。
 *
 * 由 app.ts 的 apply 直接挂载，不注册第二个客户端模块——DSH 的启动图按包声明，
 * 同一个 bundle 里第二次 load 的 factory 不会被任何行 materialize，apply 永远不会跑。
 * 覆盖层由 shell.overlay 槽承载（见 baifan/layer.ts），不自己往 body 上挂。
 * 菜单注册走 HTTP（/config 判断玩法、/menu/item 交给宿主），点击读页面内 Cordis 服务
 * `petApi7340.menuEvents`：同一份点击的本地读取，不必绕一圈长轮询。
 * @module dsh-pet/src/client/baifan
 */
import { CSS, OWNER, ROOT_ID, ROUTE, STYLE_TAG } from './baifan/constants.ts';
import { createMenu } from './baifan/menu.ts';
import { createScene } from './baifan/scene.ts';
import { createShow, type Show } from './baifan/show.ts';
import { createTransport } from './baifan/transport.ts';

/** 点击轮询间隔（毫秒）：读的是内存 Map，间隔只决定点击到响应的最大延迟。 */
const POLL_MS = 150;

/** 菜单注册失败后的重试间隔（毫秒）：DSH 重启会清掉宿主那份注册表。 */
const RETRY_MS = 5000;

/** 本模块用到的客户端上下文子集。 */
export interface BaifanContext {
  /** 取页面内 Cordis 服务（服务名 → 实例）；缺失返回 undefined。 */
  get: (name: string) => unknown;
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
 * @param host - 覆盖层容器，由 shell.overlay 槽提供；不能传 `document.body`。
 * @returns 卸载钩子：撤菜单、停轮询、清覆盖层。
 */
export function mountBaifan(ctx: BaifanContext, host: HTMLElement): () => void {
  const abort = new AbortController();

  const style = injectCss();
  const layer = document.createElement('div');
  layer.id = ROOT_ID;
  const toastEl = document.createElement('div');
  toastEl.className = 'bf-toast';
  layer.appendChild(toastEl);
  host.appendChild(layer);

  const scene = createScene(layer, toastEl);
  const transport = createTransport(ctx);
  const show: Show = createShow({ transport, scene });
  const menu = createMenu({
    get: (name) => ctx.get(name),
    transport,
    show,
    signal: abort.signal,
    retryMs: RETRY_MS,
  });

  void menu.ensureMenu().catch((error: unknown) => console.warn('[dsh-pet] 吃白饭注册菜单失败 ' + String(error)));
  const timer = window.setInterval(menu.tick, POLL_MS);

  return () => {
    menu.dispose();
    window.clearInterval(timer);
    void show.halt('');
    // 先发 DELETE 再 abort：abort 会让这次删除立刻失败，留下一条到 TTL 才消失的菜单项。
    void fetch(ROUTE + '/menu/item?owner=' + encodeURIComponent(OWNER), { method: 'DELETE' }).catch(() => {});
    abort.abort();
    layer.remove();
    if (style !== null) style.remove();
  };
}
