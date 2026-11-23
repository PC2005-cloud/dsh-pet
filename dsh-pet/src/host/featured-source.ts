/**
 * 精选插件生态的宿主半接入：向跨插件服务 `featured-plugins` 登记本插件推荐源，
 * 并在第一个激活的接入方上挂聚合路由（拉远程集中目录 + 汇总各接入方的条目）。
 *
 * 接入边界：只提供入口，不代表上榜——目标插件是否出现在精选列表由
 * skillpie.cn 收录流程决定，因此 FEATURED_SOURCE.entries 恒为空。
 * 完整约定见 https://github.com/skillpie/dsh-plugins/blob/main/dsh-featured/AI-INTEGRATION.md 。
 *
 * 多插件同时接入：服务与路由由最先激活的一方持有，其余只贡献数据；任何失败只降级，
 * 绝不影响桌宠本体（standalone / 桌面模式的伪 ctx 没有 inject，本模块直接不跑）。
 * @module dsh-pet/src/host/featured-source
 */

/** 单条推荐条目（对外形态；富字段由远程集中目录回填）。 */
export interface FeaturedEntry {
  package: string;
  title: string;
  source: string;
  description?: string;
  version?: string;
  icon?: string;
  homepage?: string;
  author?: string;
  category?: string;
  screenshots?: string[];
  stars?: number;
  downloads?: number;
  tags?: string[];
}

/** 一个推荐源：接入插件登记的单位。 */
export interface FeaturedSource {
  id: string;
  title: string;
  entries: FeaturedEntry[];
}

/** 本插件作为推荐源的登记信息：只声明入口，不推荐任何条目（含自己）。 */
export const FEATURED_SOURCE: FeaturedSource = { id: 'dsh-pet', title: 'dsh-pet', entries: [] };

/** 聚合路由路径（生态约定：所有接入方共用同一条，由宿主方注册）。 */
export const ROUTE = '/dsh-plugins-plugin/featured';
/** 跨插件服务名（生态约定：先激活的接入方 provide，后来者只登记）。 */
export const SERVICE = 'featured-plugins';

/* ── 推荐源/条目规范化 ──────────────────────────────────────────────── */

// 单条推荐：package 必填（npm 包名），title 必填；其余可选。
// 富字段（author/stars/downloads/screenshots 等）由远程集中目录集中维护。
function normalizeEntry(raw: unknown, sourceId: string): FeaturedEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const pkg = String(record.package || record.name || '').trim();
  const title = String(record.title || '').trim();
  if (!pkg || !title) return null;
  const entry: FeaturedEntry = { package: pkg, title, source: sourceId };
  for (const key of ['description', 'version', 'icon', 'homepage', 'author', 'category'] as const) {
    const v = String(record[key] || '').trim();
    if (v) entry[key] = v;
  }
  if (Array.isArray(record.screenshots)) {
    const shots = record.screenshots
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 4);
    if (shots.length) entry.screenshots = shots;
  }
  if (typeof record.stars === 'number' && record.stars >= 0) entry.stars = record.stars;
  if (typeof record.downloads === 'number' && record.downloads >= 0) entry.downloads = record.downloads;
  if (Array.isArray(record.tags)) {
    const tags = record.tags
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 8);
    if (tags.length) entry.tags = tags;
  }
  return entry;
}

// 一个推荐源：接入插件登记的单位；id 缺失直接抛错（登记失败等于没接）。
function normalizeSource(raw: unknown): FeaturedSource {
  if (!raw || typeof raw !== 'object') throw new Error('featured source must be an object');
  const record = raw as Record<string, unknown>;
  const id = String(record.id || '').trim();
  if (!id) throw new Error('featured source needs an id (the integrating package name)');
  const title = String(record.title || id).trim();
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries: FeaturedEntry[] = [];
  for (const item of rawEntries) {
    const entry = normalizeEntry(item, id);
    if (entry) entries.push(entry);
  }
  return { id, title, entries };
}

/* ── HTTP helpers ───────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 宿主 webServer 的 req/res 无静态类型
function json(res: any, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// 同源校验：浏览器必带 Origin；curl 无 Origin 放行（宿主属主角色已限定）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 宿主 webServer 的 req 无静态类型
function sameOrigin(req: any): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* ── 嵌入入口 ───────────────────────────────────────────────────────── */

/**
 * 接入点：在目标插件 apply 里调用一次；ctx 是接入插件自己的 cordis 上下文。
 * 职责：登记推荐源（effect 挂子上下文，插件停用即注销）+ 首个激活方挂聚合路由。
 * @param ctx - 接入插件的 apply 第一参；缺 get/inject 的桩环境（standalone 等）直接跳过。
 * @param source - 推荐源信息，通常是本模块导出的 FEATURED_SOURCE。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx 无静态类型
export function integrateFeaturedPlugins(ctx: any, source: FeaturedSource): void {
  // 桩守卫：伪 ctx（standalone / 测试桩）没有 inject，直接不跑——精选入口是宿主专属。
  if (!ctx || typeof ctx.get !== 'function' || typeof ctx.inject !== 'function') return;

  // ── 推荐源注册表（跨插件服务，先激活者提供） ──
  let owner = false;
  let registry: {
    register(rawSource: unknown): () => void;
    list(): FeaturedSource[];
  } | null = null;
  try {
    registry = ctx.get(SERVICE);
  } catch {
    /* get 不可用时按未提供处理 */
  }
  if (!registry) {
    const sources = new Map<string, FeaturedSource>();
    registry = {
      register(rawSource: unknown) {
        const normalized = normalizeSource(rawSource);
        sources.set(normalized.id, normalized);
        return () => {
          if (sources.get(normalized.id) === normalized) sources.delete(normalized.id);
        };
      },
      list() {
        return [...sources.values()];
      },
    };
    try {
      ctx.effect(() => ctx.provide(SERVICE, registry), 'dsh-plugins-plugin: registry service');
      owner = true;
    } catch {
      /* 已被并行提供 → 退化为纯登记方 */
    }
  }

  // 登记本插件推荐源（effect 挂子上下文，插件停用即注销）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cordis 注入的 child 无静态类型
  ctx.inject([], (child: any) => {
    child.effect(() => registry!.register(source), 'featured-plugins source: ' + String(source && source.id));
  });

  if (!owner) return; // 非宿主：只贡献数据

  // ── 宿主职责：远程集中目录（5 分钟内存缓存，node fetch，无浏览器缓存/CORS） ──
  const REMOTE_CATALOG_URLS = [
    'https://cdn.jsdelivr.net/gh/skillpie/dsh-plugins@main/dsh-plugins-plugin/plugins.json',
    'https://raw.githubusercontent.com/skillpie/dsh-plugins/main/dsh-plugins-plugin/plugins.json',
  ];
  const REMOTE_TTL_MS = 5 * 60_000;
  let remoteCache: { at: number; doc: { entries: unknown[]; updated?: string } | null } = { at: 0, doc: null };

  // 多源并发拉取，取「最新」的那份。单源「先到先用」会被 CDN 缓存坑：
  // jsdelivr 的 @main 有数分钟到数小时的延迟，raw.githubusercontent 通常更快，
  // 谁先返回就用谁会让旧数据长期遮住新数据。
  //
  // 判新三要素（优先级从高到低）：
  //   1. updated 日期（仓库写入时的时间戳）
  //   2. 条目数 —— plugins.json 只会增不会减，多的一定更新
  //   3. 版本号总和 —— 同一条目升级时条目数不变，靠这个比出来
  const catalogScore = (doc: { entries: unknown[]; updated?: string } | null) => {
    const t = Date.parse(String(doc?.updated || ''));
    const entries = Array.isArray(doc?.entries) ? doc.entries : [];
    let versions = 0;
    for (const e of entries) {
      const rec = e as Record<string, unknown>;
      const parts = String(rec?.version || '0.0.0')
        .split('.')
        .map((n) => Number.parseInt(n, 10) || 0);
      versions += (parts[0] || 0) * 1_000_000 + (parts[1] || 0) * 1_000 + (parts[2] || 0);
    }
    return { at: Number.isFinite(t) ? t : 0, count: entries.length, versions };
  };

  const newerCatalog = (
    a: { at: number; count: number; versions: number },
    b: { at: number; count: number; versions: number },
  ) => {
    // a 是否比 b 新
    if (a.at !== b.at) return a.at > b.at;
    if (a.count !== b.count) return a.count > b.count;
    return a.versions > b.versions;
  };

  async function fetchRemoteCatalog(): Promise<{ entries: unknown[]; updated?: string } | null> {
    const now = Date.now();
    if (remoteCache.doc && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.doc;
    const results = await Promise.all(
      REMOTE_CATALOG_URLS.map(async (url) => {
        try {
          const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
            cache: 'no-store',
          });
          if (!res.ok) return null;
          const doc = await res.json();
          return Array.isArray(doc?.entries) ? doc : null;
        } catch {
          return null;
        }
      }),
    );
    const docs = results.filter(Boolean);
    if (docs.length === 0) return null;
    // 三要素比较；完全相同时保留并发顺序靠前者（jsdelivr 在前）。
    const best = docs.reduce((a, b) => (newerCatalog(catalogScore(b), catalogScore(a)) ? b : a));
    remoteCache = { at: now, doc: best };
    return best;
  }

  // ── 已安装列表（host 侧轮询 pluginManager，独立 inject 作用域防回滚） ──
  let installedMap: Record<string, string> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cordis 注入的 child 无静态类型
    ctx.inject(['pluginManager'], (child: any) => {
      child.effect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const refresh = async () => {
          try {
            const bundles = await child.pluginManager.listBundles();
            const map: Record<string, string> = {};
            for (const b of bundles) {
              if (b && b.name && b.installed) map[b.name] = b.version || '';
            }
            installedMap = map;
          } catch {
            /* 保留上一次结果 */
          }
        };
        refresh();
        timer = setInterval(refresh, 30_000);
        if (timer && typeof timer.unref === 'function') timer.unref(); // 不阻塞宿主退出
        return () => clearInterval(timer);
      }, 'dsh-plugins-plugin: installed bundles watcher');
    });
  } catch {
    /* pluginManager 不可用 → 无已安装徽标，不影响板块 */
  }

  // ── 聚合：远程目录（主）+ 登记源（补充），按包名去重，先到者优先；富字段回填 ──
  const RICH_KEYS = ['author', 'homepage', 'category', 'icon', 'screenshots', 'stars', 'downloads'] as const;
  const aggregate = async () => {
    const remoteRaw = Array.isArray(remoteCache.doc?.entries) ? remoteCache.doc!.entries : [];
    const remoteIndex = new Map<string, Record<string, unknown>>();
    for (const raw of remoteRaw) {
      const rec = raw as Record<string, unknown>;
      const pkg = String(rec?.package || rec?.name || '').trim();
      if (pkg && !remoteIndex.has(pkg)) remoteIndex.set(pkg, rec);
    }
    const seen = new Set<string>();
    const entries: FeaturedEntry[] = [];
    const push = (normalized: FeaturedEntry | null) => {
      if (!normalized || seen.has(normalized.package)) return;
      seen.add(normalized.package);
      const rich = remoteIndex.get(normalized.package);
      if (rich && normalized.source !== 'plugins.json') {
        for (const key of RICH_KEYS) {
          if (normalized[key] === undefined && rich[key] !== undefined) {
            (normalized as unknown as Record<string, unknown>)[key] = rich[key];
          }
        }
      }
      entries.push(normalized);
    };
    for (const raw of remoteRaw) push(normalizeEntry(raw, 'plugins.json'));
    for (const src of registry.list()) {
      for (const entry of src.entries) push(entry);
    }
    return {
      entries,
      sources: registry.list().map((s) => ({ id: s.id, title: s.title, count: s.entries.length })),
      installed: installedMap,
      remote: remoteCache.doc ? { fetchedAt: new Date(remoteCache.at).toISOString(), count: entries.length } : null,
    };
  };

  // ── 聚合路由（重复注册会抛错 → try/catch 静默，已有宿主持有） ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cordis 注入的 child 无静态类型
  ctx.inject(['webServer'], (child: any) => {
    child.effect(() => {
      let dispose: (() => void) | null = null;
      try {
        dispose = child.webServer.register({
          kind: 'exact',
          path: ROUTE,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 宿主 webServer 的 req/res 无静态类型
          handler: async (req: any, res: any) => {
            try {
              if (!sameOrigin(req)) {
                json(res, 403, { ok: false, error: 'cross-origin request rejected' });
                return;
              }
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                json(res, 405, { ok: false, error: 'method not allowed' });
                return;
              }
              await fetchRemoteCatalog().catch(() => null);
              json(res, 200, { ok: true, data: await aggregate() });
            } catch (err) {
              json(res, 200, { ok: false, error: String((err as Error)?.message || err) });
            }
          },
        });
      } catch {
        /* 路由已存在（另一接入方先注册）→ 本方只作数据方 */
      }
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    }, 'dsh-plugins-plugin: featured route');
  });
}
