/**
 * dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
 *
 * 职责：在 DSH Web 服务器上注册 `/dsh-pet-7340/` 前缀路由，把宠物动画 WebM / 配置 JSONC
 * 流式返回给浏览器。源文件（src/host/index.ts）由 tsdown 构建为 lib/index.js。
 *
 * 路由：
 *   /dsh-pet-7340/thumb/<动画名>.<ext>  → 按扩展名分流：.webm→$DSH_HOME/dsh-pet/main-animation/webm（用户目录，优先）→ 包内 assets/webm；
 *                                       .mov → $DSH_HOME/dsh-pet/main-animation/mov（用户目录，优先）→ 包内 assets/mov
 *   /dsh-pet-7340/config.jsonc        → 插件包内 assets/config.jsonc（默认值，只读）
 *   /dsh-pet-7340/config              → 用户覆盖配置（pets / animations / animationWeights，JSON）
 *                                GET 读取、PUT 保存、DELETE 恢复默认（删除用户层）
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径（设置页展示用）
 *   /dsh-pet-7340/balance             → 当前服务商余额（client 轮询）
 *   /dsh-pet-7340/balance/trigger     → 手动触发计数（/balance 命令）
 *   /dsh-pet-7340/turn-spend          → 最近一轮对话的余额消耗（client 轮询）
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内。
 *
 * TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
 *             依赖可解析后替换为 DSH 官方类型。
 */
import { createReadStream, existsSync } from 'node:fs';
import { readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { queryBalance, type BalanceResult } from './balance';
import { createPricingManager, DEFAULT_PRICING, type Pricing } from './pricing';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ commands（/balance 斜杠命令） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'commands'];

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 路由前缀 */
const ROUTE_PREFIX = '/dsh-pet-7340';

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/** 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。 */
async function sendFile(res: ServerResponse, file: string, contentType: string): Promise<void> {
  const { size } = await stat(file);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': size,
    'cache-control': 'public, max-age=3600',
  });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** 支持的角落白名单（与 client 端一致） */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * DeepSeek 峰谷计价档位（北京时间）——与 client/balance.ts 的 deepseekPricingTier 同逻辑，
 * 用于 token 成本估算的峰谷倍率。官方规则：工作日 9:00–12:00、14:00–18:00 为高峰；
 * 其余为空闲（低谷）；周六/周日全天按低谷价计费（自 2026-08-23 起周末不分峰谷）。
 */
function isDeepseekPeakNow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 收集请求体（文本） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 校验并归一化用户配置：只接受 { pets: [...] }，可选顶层 notificationsEnabled（布尔） */
function sanitizeUserConfig(raw: unknown): { pets: unknown[]; notificationsEnabled?: boolean } | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(o.pets) ? o.pets : null;
  if (!arr || !arr.length) return null;
  const out: unknown[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null;
    const pp = p as Record<string, unknown>;
    const id = String(pp.id ?? '');
    // 有意过滤文件名非法字符（Windows 保留符 + 控制字符），防止配置值逃逸 main-config.json 路径
    // eslint-disable-next-line no-control-regex
    if (!id || id.length > 64 || /[\\/:\x00-\x1f]/.test(id)) return null;
    const size = Number(pp.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    const balanceEnabled = pp.balanceEnabled;
    if (typeof balanceEnabled !== 'boolean') return null;
    const pos = pp.position && typeof pp.position === 'object' ? (pp.position as Record<string, unknown>) : {};
    const corner = String(pos.corner ?? '');
    if (!CORNERS.includes(corner)) return null;
    const marginX = Number(pos.marginX);
    const marginY = Number(pos.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    out.push({ id, size, balanceEnabled, position: { corner, marginX, marginY } });
  }
  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;
  const outConfig: { pets: unknown[]; notificationsEnabled?: boolean } = { pets: out };
  if (ne !== undefined) outConfig.notificationsEnabled = ne;
  return outConfig;
}

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const userRoot = join(resolveDshHome(), 'dsh-pet');
  // 用户覆盖配置（pets / animations / animationWeights 覆盖片段）
  const userConfigPath = join(userRoot, 'main-config.json');
  // 用户动画目录（thumb 播放时优先于包内素材；按扩展名在 webm/mov 子目录分流）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 手动触发计数：/balance 命令 +1，client 轮询变化后立即刷新余额并播动画（进程内内存态，重启归零）
  let balanceTriggerCount = 0;

  // ---- 每轮对话余额消耗统计（turn-spend）----
  // 双数据源（取可靠者）：
  //   1) token 用量（精确）：监听 assistant/message 的 usage，按 DeepSeek 官方单价折算每轮成本。
  //      单价从官方定价文档 https://api-docs.deepseek.com/quick_start/pricing/ 爬取（PricingManager），
  //      启动抓取一次 + 每 6 小时刷新；失败回落内置默认。用户可在 main-config.json 的 pricing 段覆盖。
  //   2) 余额差值（真实）：turn/start 与 turn/end(completed) 各查一次余额，差值作为真实消耗。
  //      余额接口精度 0.01 元，单轮消耗通常 < 0.005 元 → 差值法常失效，token 法是主数据源。
  // 内存态：进程重启归零；多会话按 sessionId 独立记账，互不串扰。
  // 定价管理器：从官网爬取 deepseek-v4-flash 单价（用户配置 pricing 覆盖优先）。
  const pricingManager = createPricingManager('deepseek-v4-flash');
  // 用户配置覆盖：main-config.json 顶层 "pricing"（元/百万，若用户提供则优先于官网人民币价）
  // 注意：官网中文价为人民币（CNY），与余额币种 CNY 对齐；用户覆盖同样按 CNY。
  let pricingOverride: Pricing | null = null;
  void (async () => {
    try {
      const raw = await readFile(userConfigPath, 'utf8');
      const parsed = JSON.parse(raw) as { pricing?: Record<string, unknown> };
      const p = parsed?.pricing;
      if (p && typeof p === 'object') {
        const num = (v: unknown, fallback: number): number =>
          typeof v === 'number' && Number.isFinite(v) ? v : fallback;
        pricingOverride = {
          input: num(p.input, DEFAULT_PRICING.input),
          output: num(p.output, DEFAULT_PRICING.output),
          cacheRead: num(p.cacheRead, DEFAULT_PRICING.cacheRead),
          peakMultiplier: num(p.peakMultiplier, DEFAULT_PRICING.peakMultiplier),
          currency: typeof p.currency === 'string' && p.currency ? String(p.currency) : DEFAULT_PRICING.currency,
        };
      }
    } catch {
      /* 无用户配置或解析失败：回落官网/默认 */
    }
  })();
  // 启动官网定价抓取（失败回落默认，不阻塞）
  pricingManager.start();
  const getPricing = (): Pricing => pricingOverride ?? pricingManager.current();
  const turnBaselines = new Map<string, Promise<number | null>>();
  // 每轮 token 用量（按 turn 累加；assistant/message 的 usage 是本步用量）
  const turnTokenUsage = new Map<string, { input: number; output: number; cacheRead: number }>();
  let turnSpendCount = 0;
  let lastTurnSpend: { count: number; amount: number; currency: string; at: number } | null = null;
  // 诊断：记录最近收到的会话事件样本与结算情况（通过 /turn-spend/debug 查看，定位监听是否生效）
  const eventDiag: { at: number; sessionId: string; type: string; turn?: number; reasonKind?: string }[] = [];
  const diagAppend = (sessionId: string, type: string, data?: { turn?: number; reason?: { kind?: string } }) => {
    eventDiag.push({ at: Date.now(), sessionId, type, turn: data?.turn, reasonKind: data?.reason?.kind });
    if (eventDiag.length > 60) eventDiag.shift();
  };

  /** 按当前时段（峰/谷）+ token 数计算成本（币种 CNY：官网人民币价）；
   *  仅 deepseek 服务商启用 */
  const estimateCostByTokens = (
    usage: { input: number; output: number; cacheRead: number },
    isPeak: boolean,
  ): { amount: number; currency: string } => {
    const p = getPricing();
    const m = p.peakMultiplier > 0 ? p.peakMultiplier : 1;
    const mult = isPeak ? m : 1;
    const cost =
      ((usage.input * p.input + usage.cacheRead * p.cacheRead + usage.output * p.output) / 1_000_000) * mult;
    return { amount: cost, currency: p.currency };
  };

  /** 查询当前 DeepSeek 余额（数字金额 + 币种）；非 deepseek 服务商 / 失败 → null */
  const queryBalanceNow = async (): Promise<{ total: number; currency: string } | null> => {
    try {
      const sel = ctx.agentDefaultModel.currentSelection();
      const result = await queryBalance(sel.provider, async (ref) => {
        const rc = await ctx.credentials.resolve(credentialRef(ref));
        return rc?.value;
      });
      if (result.ok && result.kind === 'deepseek') {
        const total = Number(result.data.total);
        if (!Number.isFinite(total)) return null;
        return { total, currency: result.data.currency };
      }
      return null;
    } catch {
      return null;
    }
  };

  // 会话事件监听：turn/start 记基线 → assistant/message 累加 token → turn/end(completed) 结算
  ctx.on(
    'session/event',
    (
      session: { id: unknown },
      event: {
        type: string;
        data?: {
          turn?: number;
          reason?: { kind?: string };
          usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
        };
      },
    ) => {
      const sessionId = String((session as { id?: unknown })?.id ?? 'unknown');
      diagAppend(sessionId, event.type, event.data as { turn?: number; reason?: { kind?: string } });
      if (event.type === 'turn/start') {
        turnBaselines.set(sessionId, queryBalanceNow().then((r) => (r ? r.total : null)));
        turnTokenUsage.set(sessionId, { input: 0, output: 0, cacheRead: 0 });
        return;
      }
      if (event.type === 'assistant/message') {
        const u = event.data?.usage;
        if (u && (u.inputTokens || u.outputTokens || u.cacheReadTokens)) {
          const acc = turnTokenUsage.get(sessionId) ?? { input: 0, output: 0, cacheRead: 0 };
          acc.input += u.inputTokens ?? 0;
          acc.output += u.outputTokens ?? 0;
          acc.cacheRead += u.cacheReadTokens ?? 0;
          turnTokenUsage.set(sessionId, acc);
        }
        return;
      }
      if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') {
        const baselineP = turnBaselines.get(sessionId);
        turnBaselines.delete(sessionId);
        const usage = turnTokenUsage.get(sessionId);
        turnTokenUsage.delete(sessionId);
        void (async () => {
          const [baseline, current] = await Promise.all([baselineP ?? Promise.resolve(null), queryBalanceNow()]);
          // 数据源 1：token 用量估算（精确，主数据源）
          let amount: number | null = null;
          let currency = 'CNY';
          if (usage && (usage.input + usage.output + usage.cacheRead) > 0) {
            const isPeak = isDeepseekPeakNow();
            const est = estimateCostByTokens(usage, isPeak);
            amount = est.amount;
            currency = est.currency;
            if (amount < 0.0001) amount = null; // token 数太少（几乎 0）：不显示
          }
          // 数据源 2：余额差值（真实消耗，覆盖 token 估算——余额确实变了就以余额为准）
          if (baseline !== null && current !== null && baseline - current.total >= 0.005) {
            amount = baseline - current.total;
            currency = current.currency;
          }
          if (amount === null || amount <= 0) {
            console.warn(
              '[dsh-pet] turn-spend 跳过结算 session=' +
                sessionId +
                ' tokens=' +
                (usage ? usage.input + 'i/' + usage.output + 'o/' + usage.cacheRead + 'c' : 'none') +
                ' balanceDiff=' +
                (baseline !== null && current !== null ? (baseline - current.total).toFixed(4) : 'n/a'),
            );
            return;
          }
          turnSpendCount += 1;
          lastTurnSpend = { count: turnSpendCount, amount, currency, at: Date.now() };
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' turn-spend session=' +
              sessionId +
              ' amount=' +
              amount.toFixed(4) +
              ' ' +
              currency +
              ' tokens=' +
              (usage ? usage.input + 'i/' + usage.output + 'o/' + usage.cacheRead + 'c' : 'n/a'),
          );
        })();
      }
    },
  );

  /** 包内动画素材根：按扩展名分格式存放（assets/webm 或 assets/mov）。 */
  const assetRootFor = (ext: string): string =>
    ext === '.mov' ? join(PACKAGE_ROOT, 'assets', 'mov') : join(PACKAGE_ROOT, 'assets', 'webm');

  /** 用户动画根：同扩展名分流（main-animation/webm 或 main-animation/mov）。 */
  const userRootFor = (ext: string): string =>
    ext === '.mov' ? join(thumbUserRoot, 'mov') : join(thumbUserRoot, 'webm');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));

          // 用户覆盖配置：/dsh-pet-7340/config（GET / PUT / DELETE）
          if (rest === 'config') {
            if (req.method === 'GET') {
              try {
                const raw = await readFile(userConfigPath, 'utf8');
                sendJson(res, 200, JSON.parse(raw));
              } catch {
                sendJson(res, 200, {}); // 无覆盖配置 → 空对象，client 回落默认
              }
              return;
            }
            if (req.method === 'PUT') {
              try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const clean = sanitizeUserConfig(parsed);
                if (!clean) {
                  sendJson(res, 400, {
                    error:
                      'invalid pet config: expected { pets:[{id,size,balanceEnabled,position:{corner,marginX,marginY}}] }（可选顶层 notificationsEnabled 布尔）',
                  });
                  return;
                }
                await mkdir(userRoot, { recursive: true });
                await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
                sendJson(res, 200, { ok: true });
              } catch {
                sendJson(res, 400, { error: 'invalid JSON body' });
              }
              return;
            }
            if (req.method === 'DELETE') {
              try {
                await rm(userConfigPath, { force: true });
              } catch {
                /* 不存在也视为成功 */
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }

          // 配置文件路径（设置页「高级配置」展示用）
          if (rest === 'config/meta') {
            sendJson(res, 200, {
              user: userConfigPath,
              default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
              animations: thumbUserRoot,
            });
            return;
          }

          // 余额查询（client 定时/手动拉取；结果由 host 侧完成全部抓取与校验，client 不接触 key）
          if (rest === 'balance') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              const sel = ctx.agentDefaultModel.currentSelection();
              const result: BalanceResult = await queryBalance(sel.provider, async (ref) => {
                const rc = await ctx.credentials.resolve(credentialRef(ref));
                return rc?.value;
              });
              // 余额必须实时：显式 no-store，禁止浏览器/代理缓存（4s 高频轮询依赖此保证）
              const body = JSON.stringify(result);
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-cache, no-store',
                'content-length': Buffer.byteLength(body),
              });
              res.end(body);
            } catch (e) {
              // 意外异常（如注入服务缺失）：显式 500，不静默
              sendJson(res, 500, {
                ok: false,
                provider: 'unknown',
                reason: 'fetch-error',
                message: e instanceof Error ? e.message : String(e),
              });
            }
            return;
          }

          // 手动触发计数：/dsh-pet-7340/balance/trigger（no-cache，client 轻量轮询；/balance 命令写入）
          if (rest === 'balance/trigger') {
            const body = JSON.stringify({ count: balanceTriggerCount });
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache, no-store', // 触发计数必须实时，禁止任何缓存层介入
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
          }

          // 每轮对话余额消耗：/dsh-pet-7340/turn-spend（no-cache，client 轻量轮询）
          // 返回最近一次结算的「本轮消耗」；count 递增供 client 检测新值（首轮 -1 仅记基线）
          if (rest === 'turn-spend') {
            const body = JSON.stringify(
              lastTurnSpend ? { ok: true, count: lastTurnSpend.count, amount: lastTurnSpend.amount, currency: lastTurnSpend.currency, at: lastTurnSpend.at } : { ok: true, count: 0, amount: 0, currency: '', at: 0 },
            );
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache, no-store',
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
          }

          // 诊断端点（仅调试用）：/dsh-pet-7340/turn-spend/debug
          if (rest === 'turn-spend/debug') {
            sendJson(res, 200, {
              turnSpendCount,
              lastTurnSpend,
              baselineCount: turnBaselines.size,
              tokenUsageCount: turnTokenUsage.size,
              pricing: getPricing(),
              pricingSource: pricingOverride ? 'user-override' : 'official-fetch',
              events: eventDiag,
            });
            return;
          }

          // 配置文件（JSONC）：/dsh-pet-7340/config.jsonc → 包内 assets/config.jsonc
          if (rest === 'config.jsonc') {
            const cfgFile = join(PACKAGE_ROOT, 'assets', 'config.jsonc');
            if (!existsSync(cfgFile)) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: config.jsonc not found');
              return;
            }
            await sendFile(res, cfgFile, MIME['.jsonc'] ?? 'application/octet-stream');
            return;
          }

          // 字体文件：/dsh-pet-7340/font/<file> → 包内 assets/fonts
          const [scope, ...nameParts] = rest.split('/');
          if (scope === 'font') {
            const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
            const fontFile = resolveExisting(fontRoot, nameParts.join('/'));
            if (fontFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: font not found');
              return;
            }
            const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, fontFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，通知 icon 用）
          if (scope === 'pic') {
            const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
            const picFile = resolveExisting(picRoot, nameParts.join('/'));
            if (picFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: pic not found');
              return;
            }
            const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, picFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 动画文件：/dsh-pet-7340/thumb/<file>，按扩展名分格式目录
          // （.webm → assets/webm，.mov → assets/mov），查找顺序 = 用户动画目录 → 包内素材
          if (scope !== 'thumb') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: expected /dsh-pet-7340/thumb/<file>');
            return;
          }
          const fileName = nameParts.join('/');
          const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
          if (ext !== '.webm' && ext !== '.mov') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: unsupported animation format (expected .webm or .mov)');
            return;
          }
          const file = resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName);
          if (file === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: asset not found');
            return;
          }
          await sendFile(res, file, MIME[ext] ?? 'application/octet-stream');
        },
      }),
    'dsh-pet: /dsh-pet-7340 asset route',
  );

  // /balance 斜杠命令：递增触发计数 → client 检测到变化后立即刷新余额并播动画（不进模型历史）
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'balance',
        description: '手动触发桌宠余额动画（立即显示余额气泡）',
        handler: () => {
          balanceTriggerCount += 1;
          return { kind: 'success', text: '已触发桌宠余额动画' };
        },
      }),
    'dsh-pet: /balance command',
  );

  // 插件卸载时停止官网定价周期刷新（清理定时器）
  ctx.effect(
    () => () => {
      pricingManager.dispose();
    },
    'dsh-pet: pricing manager dispose',
  );
}
