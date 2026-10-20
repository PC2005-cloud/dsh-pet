/**
 * dsh-cordis-probe 的浏览器半侧 —— 模拟「第三方客户端插件」消费 Cordis 服务。
 *
 * ## 它解决什么
 *
 * dsh-pet 给页面内第三方插件开了一个只读服务 `petApi7340`（`ctx.get('petApi7340').pose(id)`），
 * 但它是 Cordis 服务、不是 HTTP 接口：跑在 DSH web 那一页的模块作用域里，另开标签页、
 * 另起进程、用 curl 都碰不到它。这个插件就是那个「第三方」：以普通客户端插件的身份
 * 装进同一个页面，用 `ctx.get()` 现场探测服务，把读到的东西画在屏幕上。
 *
 * 所以它是 tools/api-tester.html 的**另一半**：
 *   · api-tester.html  → 测 HTTP 接口（`/state`、`/anim`、`/pose` …），跨进程，走网络；
 *   · 本插件            → 测 Cordis 服务（`petApi7340` 以及以后每一个页面内服务），同页，零请求。
 *
 * ## 为什么不是「独立页面」
 *
 * 客户端插件注册不了浏览器路由：DSH 客户端只提供插槽（`shell.overlay`、
 * `settings.section` 之类），DSH web 本身是单页、没有前端路由。而服务是**页面实例**
 * 绑定的，换个 URL 就是换一个 window、换一个 Cordis 容器，`ctx.get('petApi7340')` 必然是
 * 空。所以面板**直接常驻**在页面右下角：不挂路由、不用 hash 触发，装上刷新即可见。
 *
 * ## 为什么「dsh-pet 以后新增的服务」也自动测得了
 *
 * 不写死服务名。`ctx.reflect.props` 里每个服务都能顺 `Impl.fiber.name` 反查提供者，
 * 只保留 dsh-pet（`name: 'pet'`）provide 的那些 —— 所以 dsh-pet 以后再加只读服务，
 * 面板刷新一下就自动出现，本插件不用改。成员的调用参数用逗号分隔、逐段 `JSON.parse`，
 * `petApi7340.pose("main")` 这种带参方法也能直接调。
 *
 * 顺带把 DSH 平台那几十个服务（locale / connection / jobs …）挡在外面：它们是平台的，
 * 不是 dsh-pet 的，混在一起只会让面板没法看。
 *
 * 拿不到 `reflect`（DSH 改实现）时降级为手写清单，面板照常可用，只是列表变成一行。
 *
 * ## 契约
 *
 * 必须是**经典脚本**（无顶层 import/export），整份包一层 IIFE：DSH 把 `lib/client.js`
 * 当经典脚本加载，bundle 重建 / combo 重试时同一文件会在同一页面再执行一次，顶层
 * `const` 会直接 SyntaxError。重复执行时下面按 `ROOT_ID` 摘掉旧面板再建新的。
 */

;(() => {
  'use strict';

  /** 插件 id：与 package.json 的 name 一致，DSH 模块系统按它去重。 */
  const PLUGIN_ID = 'dsh-cordis-probe';

  /** 面板根节点 id，用于重复执行时摘掉旧面板。 */
  const ROOT_ID = 'cordis-probe-root';

  /** 样式表去重标记（与 dsh-pet 同一套 `data-plugin-css` 约定）。 */
  const STYLE_TAG = 'dsh-cordis-probe/probe.css';

  /** 探测不到服务归属时的兜底服务名（保持面板永远可用）。 */
  const FALLBACK_SERVICES = ['petApi7340'];

  /**
   * dsh-pet 客户端插件注册时用的 `name`（见 dsh-pet/src/client/app.ts 的 `const name = 'pet'`）。
   *
   * 用来把「本插件提供的服务」从 DSH 平台那几十个服务里挑出来：`Fiber.name` 会从最近的
   * 有名祖先继承，所以 dsh-pet 里 `ctx.provide()` 出来的服务，其 fiber.name 就是它。
   */
  const OWNER_NAMES = ['pet', 'dsh-pet'];

  /**
   * 面板样式。
   *
   * 固定右下角、浅底深字，`prefers-color-scheme: dark` 时翻成深底 —— DSH 主题切了
   * 这块也不会糊成一片。`z-index` 取 32 位上限的 1/10，压在宠物 overlay（1000）之上，
   * 但不至于把 DSH 自己的模态框挤下去。
   */
  const CSS = [
    '.cp-root{position:fixed;right:16px;bottom:16px;width:440px;max-height:72vh;overflow:auto;',
    'z-index:214748300;box-sizing:border-box;background:#fff;color:#18181b;',
    'border:1px solid #d4d4d8;border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.18);',
    'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:10px 12px}',
    '.cp-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
    '.cp-title{font-weight:700;font-size:13px;flex:1}',
    '.cp-btn{font:inherit;cursor:pointer;padding:1px 7px;border:1px solid #d4d4d8;',
    'border-radius:5px;background:#fafafa;color:inherit}',
    '.cp-btn:hover{background:#f0f0f1}',
    '.cp-note{color:#71717a;margin-bottom:8px;word-break:break-all}',
    '.cp-in{font:inherit;flex:1;min-width:0;padding:2px 6px;border:1px solid #d4d4d8;border-radius:5px}',
    '.cp-list{border-top:1px solid #e4e4e7}',
    '.cp-row{display:flex;align-items:center;gap:7px;padding:3px 0;cursor:pointer;',
    'border-bottom:1px solid #f1f1f2}',
    '.cp-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#a1a1aa}',
    '.cp-dot.on{background:#16a34a}',
    '.cp-name{flex:1;word-break:break-all}',
    '.cp-type{color:#71717a;font-size:11px}',
    '.cp-members{padding:4px 0 6px 14px;border-bottom:1px solid #f1f1f2}',
    '.cp-member{display:flex;align-items:center;gap:6px;padding:1px 0}',
    '.cp-key{flex:1;word-break:break-all}',
    '.cp-out{margin-top:8px;padding-top:8px;border-top:1px solid #e4e4e7;',
    'white-space:pre-wrap;word-break:break-all;color:#3f3f46;max-height:32vh;overflow:auto}',
    '.cp-err{color:#b91c1c}',
    '@media (prefers-color-scheme: dark){',
    '.cp-root{background:#18181b;color:#e4e4e7;border-color:#3f3f46;box-shadow:0 10px 32px rgba(0,0,0,.5)}',
    '.cp-btn{background:#27272a;border-color:#3f3f46}',
    '.cp-btn:hover{background:#3f3f46}',
    '.cp-note,.cp-type{color:#a1a1aa}',
    '.cp-in{background:#27272a;color:inherit;border-color:#3f3f46}',
    '.cp-list,.cp-members,.cp-out{border-color:#3f3f46}',
    '.cp-row,.cp-member{border-color:#27272a}',
    '.cp-out{color:#d4d4d8}',
    '.cp-err{color:#fca5a5}',
    '}',
  ].join('');

  /** 注入样式表（只注入一次）。 */
  function injectCss() {
    const doc = document;
    if (doc.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return;
    const tag = doc.createElement('style');
    tag.dataset.plugin = 'cordis-probe';
    tag.dataset.pluginCss = STYLE_TAG;
    tag.textContent = CSS;
    doc.head.appendChild(tag);
  }

  /** 建一个元素，可选 className 与文本。 */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** 异常 → 单行文案。 */
  function describe(error) {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 判断一个服务是不是 dsh-pet 提供的。
   *
   * 服务名是裸词（`petApi7340`），没有命名空间，所以只能顺着 `Impl.fiber.name` 反查提供者。
   * `_getImpl` 是 cordis 的内部方法（reflect.js:766），拿不到 fiber 名时退化为固定清单
   * ——宁可少列，也不把 DSH 平台的服务混进来。
   *
   * @param reflect - `ctx.reflect`。
   * @param serviceName - 待判断的服务名。
   * @returns 是否属于 dsh-pet。
   */
  function isOurs(reflect, serviceName) {
    try {
      const impl = reflect && typeof reflect._getImpl === 'function' ? reflect._getImpl(serviceName, false) : undefined;
      const owner = impl && impl.fiber ? impl.fiber.name : undefined;
      if (owner !== undefined) return OWNER_NAMES.indexOf(owner) >= 0;
    } catch (error) {
      // 拿不到归属就靠清单
    }
    return FALLBACK_SERVICES.indexOf(serviceName) >= 0;
  }

  /**
   * 把服务枚举成 `{ name, value }`。
   *
   * `ctx.reflect.props` 是这一页全部已声明的上下文属性（service + accessor），先按
   * `type === 'service'` 筛，再按**提供者**筛 —— 面板只关心 dsh-pet 自己的服务。
   *
   * @param ctx - DSH 注入的 Cordis ctx。
   * @returns 服务清单。
   */
  function listServices(ctx) {
    let reflect;
    try {
      // reflect 是核心服务，直接挂在 ctx 上；ctx.get('reflect') 不保证查得到它
      reflect = ctx.reflect !== undefined ? ctx.reflect : ctx.get('reflect', false);
    } catch (error) {
      reflect = undefined;
    }
    const props = reflect && reflect.props;
    let names;
    if (props && typeof props === 'object') {
      names = [];
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop && prop.type === 'service' && isOurs(reflect, key)) names.push(key);
      }
      names.sort();
    } else {
      names = FALLBACK_SERVICES.slice();
    }
    return names.map((serviceName) => ({ name: serviceName, value: readService(ctx, serviceName) }));
  }

  /**
   * 读一个服务。
   *
   * `strict = false`：即使提供者的 fiber 正在卸载也要拿到值 —— 探针要的是「这里到底
   * 有没有这个东西」，而不是「此刻能否安全依赖它」。取不到返回 `undefined`（不抛）。
   */
  function readService(ctx, serviceName) {
    try {
      return ctx.get(serviceName, false);
    } catch (error) {
      return undefined;
    }
  }

  /** 值 → 面板上的一行类型描述。 */
  function typeOf(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array[' + value.length + ']';
    return typeof value;
  }

  /** 取值的自有可枚举键（Proxy / 宿主对象取不到时返回空数组）。 */
  function keysOf(value) {
    if (value === null || typeof value !== 'object') return [];
    try {
      return Object.keys(value);
    } catch (error) {
      return [];
    }
  }

  /**
   * 解析调用参数：逗号分隔，逐段 `JSON.parse`。
   *
   * 解析失败的段**原样当字符串**（不报错）—— 省得为了传个 `main` 还要写引号。
   *
   * @param text - 输入框内容。
   * @returns 参数数组；空输入返回空数组。
   */
  function parseArgs(text) {
    const trimmed = text.trim();
    if (trimmed === '') return [];
    return trimmed.split(',').map((part) => {
      const piece = part.trim();
      try {
        return JSON.parse(piece);
      } catch (error) {
        return piece;
      }
    });
  }

  /** 结果 → 可读文本（循环引用 / 不可序列化时不炸）。 */
  function stringify(value) {
    if (value === undefined) return 'undefined';
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    factory(require) {
      const name = 'cordis-probe';
      const inject = [];

      /**
       * @param ctx - DSH 注入的 Cordis ctx。
       * @returns disposer：摘掉面板与 hash 监听。
       */
      function apply(ctx) {
        if (typeof document === 'undefined' || document.body === null) {
          console.warn('[cordis-probe] 缺少 document，跳过（无面板）');
          return () => {};
        }
        // 重复执行防护：bundle 重建 / combo 重试会再跑一遍本文件
        const stale = document.getElementById(ROOT_ID);
        if (stale !== null) stale.remove();

        injectCss();

        const root = el('div', 'cp-root');
        root.id = ROOT_ID;

        // —— 头部 ——
        const head = el('div', 'cp-head');
        head.appendChild(el('span', 'cp-title', 'Cordis 服务探针'));
        const refreshBtn = el('button', 'cp-btn', '刷新');
        const closeBtn = el('button', 'cp-btn', '×');
        head.appendChild(refreshBtn);
        head.appendChild(closeBtn);
        root.appendChild(head);

        root.appendChild(el('div', 'cp-note', 'dsh-pet 提供的 Cordis 服务，同页直读，不发请求'));

        // —— 服务清单 ——
        const list = el('div', 'cp-list');
        root.appendChild(list);

        // —— 输出区 ——
        const out = el('div', 'cp-out', '待探测。');
        root.appendChild(out);

        /** 往输出区写一段结果（`isError` 时染红）。 */
        const write = (text, isError) => {
          out.className = isError === true ? 'cp-out cp-err' : 'cp-out';
          out.textContent = text;
        };

        /**
         * 当前正在「跟随」的方法的停止函数（`null` = 没在跟随）。
         *
         * 跟随 = 每帧调一次。调用按钮只读一次，看不出 `progress` 这类会变的量；跟随才能看到
         * 数值在动。同一时间只保留一个跟随，再点同一个按钮即停。
         */
        let stopFollow = null;

        /** 重建服务清单（保留折叠状态靠重扫，不做额外状态机）。 */
        const render = () => {
          // 重建会把旧按钮一起丢掉，跟随循环必须先停，否则它会继续往输出区写
          if (stopFollow !== null) {
            stopFollow();
            stopFollow = null;
          }
          list.textContent = '';
          const services = listServices(ctx);
          if (services.length === 0) {
            list.appendChild(el('div', 'cp-type', '没有扫描到 dsh-pet 提供的服务（插件可能没启用）'));
          }
          for (const service of services) {
            const on = service.value !== undefined;

            const row = el('div', 'cp-row');
            const dot = el('span', on ? 'cp-dot on' : 'cp-dot');
            row.appendChild(dot);
            row.appendChild(el('span', 'cp-name', service.name));
            row.appendChild(el('span', 'cp-type', on ? typeOf(service.value) : '未提供'));
            list.appendChild(row);

            const members = el('div', 'cp-members');
            row.addEventListener('click', () => {
              members.style.display = members.style.display === 'none' ? 'block' : 'none';
            });

            if (on) {
              const keys = keysOf(service.value);
              if (keys.length === 0) {
                members.appendChild(el('div', 'cp-type', '（没有可枚举成员）'));
              }
              for (const key of keys) {
                let member;
                try {
                  member = service.value[key];
                } catch (error) {
                  members.appendChild(el('div', 'cp-member', key + ' — 读取失败'));
                  continue;
                }
                const line = el('div', 'cp-member');
                line.appendChild(el('span', 'cp-key', key));
                line.appendChild(el('span', 'cp-type', typeOf(member)));
                if (typeof member === 'function') {
                  const callBtn = el('button', 'cp-btn', '调用');
                  callBtn.addEventListener('click', (event) => {
                    // 别让点击冒泡到 row，把展开又收起来
                    event.stopPropagation();
                    const args = parseArgs(argsInput.value);
                    try {
                      const result = member.apply(service.value, args);
                      write(
                        service.name +
                          '.' +
                          key +
                          '(' +
                          args.map((a) => stringify(a)).join(', ') +
                          ') →\n' +
                          stringify(result),
                        false,
                      );
                    } catch (error) {
                      write(service.name + '.' + key + '() 抛错：' + describe(error), true);
                    }
                  });
                  line.appendChild(callBtn);

                  // 跟随：每帧调一次，专治 progress 这类"读一次看不出变化"的量
                  const followBtn = el('button', 'cp-btn', '跟随');
                  followBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (stopFollow !== null) {
                      stopFollow();
                      stopFollow = null;
                      followBtn.textContent = '跟随';
                      return;
                    }
                    const args = parseArgs(argsInput.value);
                    followBtn.textContent = '停止';
                    let handle = 0;
                    const tick = () => {
                      try {
                        const result = member.apply(service.value, args);
                        write(
                          service.name +
                            '.' +
                            key +
                            '(' +
                            args.map((a) => stringify(a)).join(', ') +
                            ') →\n' +
                            stringify(result),
                          false,
                        );
                      } catch (error) {
                        // 出错就自动停，别每帧刷同一条错误
                        window.cancelAnimationFrame(handle);
                        stopFollow = null;
                        followBtn.textContent = '跟随';
                        write(service.name + '.' + key + '() 抛错：' + describe(error), true);
                        return;
                      }
                      handle = window.requestAnimationFrame(tick);
                    };
                    handle = window.requestAnimationFrame(tick);
                    stopFollow = () => {
                      window.cancelAnimationFrame(handle);
                      followBtn.textContent = '跟随';
                    };
                  });
                  line.appendChild(followBtn);
                }
                members.appendChild(line);
              }

              const argsRow = el('div', 'cp-member');
              argsRow.appendChild(el('span', 'cp-type', '参数'));
              const argsInput = el('input', 'cp-in');
              argsInput.placeholder = '逗号分隔，如 main 或 "left",0.5';
              argsRow.appendChild(argsInput);
              members.insertBefore(argsRow, members.firstChild);
            } else {
              members.appendChild(el('div', 'cp-type', '这个页面没有提供该服务。'));
            }

            list.appendChild(members);
          }
        };

        refreshBtn.addEventListener('click', () => {
          render();
          write('已重新扫描。');
        });
        closeBtn.addEventListener('click', () => {
          root.style.display = 'none';
        });

        document.body.appendChild(root);
        render();

        // 服务是别的插件在**它自己的 apply 里** provide 的，加载顺序不保证：探针先 apply
        // 时 petApi7340 还不存在，那一刻扫出来必然是「未提供」。所以服务一上线就重扫。
        let off;
        try {
          off = ctx.on('internal/service', () => render());
        } catch (error) {
          off = undefined;
        }
        // 兜底：事件名若变了（或 events 不可用），前几秒补扫几次
        const timers = [500, 1500, 3000].map((ms) => window.setTimeout(render, ms));

        return () => {
          for (const timer of timers) window.clearTimeout(timer);
          if (typeof off === 'function') off();
          root.remove();
        };
      }

      return { name, inject, apply };
    },
  });
})();
