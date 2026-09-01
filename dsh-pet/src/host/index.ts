/**
 * dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
 *
 * 职责：提供 `/dsh-pet-7340/` 前缀的**业务能力**（handlePetRoute 纯函数，路由与桌面管道共用）。
 * 全部配置（内置默认 + 用户主配置 + 文件宠物）由 ./config 的 readAllConfig 统一读取合并，
 * 本文件只消费它的返回值（绝对正确、零校验），不再接触任何配置文件。
 *
 * 两个入口消费同一份 handlePetRoute：
 *   - HTTP 路由：注册在 DSH WebServer 上（浏览器 overlay / 设置页 / 斜杠命令用）
 *   - 桌面 Helper 管道：helper-process.ts 的 bridgeHandler（DSH_PET_BRIDGE=1 时经
 *     dsh-pet-bridge:// scheme + stdout JSON 行 + 本地回调，**不走 HTTP**——
 *     DSH Desktop 2.0.3+ 的浏览器访问闸门会拦插件子进程的裸 HTTP 请求）
 * 两端行为严格一致（硬契约：浏览器/桌面功能/文案/配置完全对齐）。
 *
 * 路由：
 *   /dsh-pet-7340/config             → 合并后的**成品配置**（{ main:{...}, test1:{...}, ... }，
 *                                每条目字段已填满；浏览器/桌面/设置页的唯一配置入口）
 *                                GET 读取成品、PUT 保存用户层（白名单重建 main-config.json）、
 *                                DELETE 删除用户层（恢复内置默认）
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径（设置页展示用）
 *   /dsh-pet-7340/thumb/<素材根>/<动画名>.webm  → 素材按宠物归属：
 *       文件宠物 = $DSH_HOME/dsh-pet/pet/<素材根>-animation/（只查自己的，绝不回落）；
 *       主宠物   = $DSH_HOME/dsh-pet/main-animation/webm（用户目录，优先）→ 包内 assets/webm
 *   /dsh-pet-7340/whisper|whisper/trigger → 碎碎念周期/手动生成（按宠物独立，人设读成品）
 *   /dsh-pet-7340/chat                → 对话与记忆（GET 最近窗口 / POST 对话并写 memory.json）
 *   /dsh-pet-7340/broadcast            → /chat 命令触发的气泡广播（两端 1s 轻轮询）
 *   /dsh-pet-7340/balance|balance/trigger → 余额查询 / 手动触发计数（/balance 命令 +1）
 *   /dsh-pet-7340/font|pic             → 字体 / 通知图标素材
 *
 * 系统通知不属于宠物行为、不在这里：它是"监测 DSH 事件 → 弹系统 toast"的独立能力，
 * 天然只跟 DSH 网页端走（浏览器半侧 notify.ts，经 connection 事件流 + Web Notification API）。
 *
 * 桌面模式（Electron 透明窗）没有独立配置文件：宠物显示在哪全部由宠物条目的 display 决定
 * （web=仅浏览器 / desktop=仅桌面 / both=两者 / none=都不显示；缺失时合并器填内置默认值）。
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内；
 *         PUT 保存经 saveUserConfig 白名单重建，id 过滤文件名非法字符。
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
import { queryBalance } from './balance';
import { generateWhisper } from './whisper';
import { generateChat, type ChatMemoryMessage } from './chat';
import { findPetInstance, flattenPetList, readAllConfig, saveUserConfig, type ConfigPaths } from './config';
import { HelperProcess, defaultElectronExe, ensureElectronDownload, resolveElectronPath } from './helper-process';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ llm（对话模型调用）+ commands（/balance 斜杠命令） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands'];

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 路由前缀 */
const ROUTE_PREFIX = '/dsh-pet-7340';

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
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

// 配置的读取/校验/合并/保存全部收敛在 ./config（readAllConfig / saveUserConfig，host 自包含实现，
// 不 import src/shared —— DSH 单文件加载约束）。本文件不再保留任何配置逻辑，只消费成品返回值。

/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display: unknown): boolean => display === 'desktop' || display === 'both';

/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** 单次业务路由的应答（WebServer 注册与桌面 Helper 管道共用的同一契约；消费方各自落盘） */
type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string };

/** 收集请求体（文本） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 额外宠物（pet pack）说明：校验/扫描已收敛到 ./config（readAllConfig 内部逐字段合并），
// 这里不再有 host 侧拷贝——文件宠物与主宠物一样，统一从 readAllConfig 的成品读取。
// ---------------------------------------------------------------------------

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由 + 斜杠命令（/balance /pet /chat）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const userRoot = join(resolveDshHome(), 'dsh-pet');
  // 用户主配置（可编辑层）与文件宠物目录；配置读取/合并统一走 readAllConfig（./config）
  const userConfigPath = join(userRoot, 'main-config.json');
  const petConfigDir = join(userRoot, 'pet');
  // 配置路径集（readAllConfig 的唯一输入：内置默认 + 用户主配置 + 文件宠物目录）
  const configPaths: ConfigPaths = {
    defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
    userFile: userConfigPath,
    petDir: petConfigDir,
  };
  // 用户动画目录（thumb 播放时优先于包内素材；唯一格式 webm，素材放 main-animation/webm/）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 手动触发计数：/balance 命令 +1，两边（浏览器/桌面）同样的 1s 轮询检测变化后刷新余额（进程内内存态，重启归零）
  let balanceTriggerCount = 0;
  // 命令「当前桌宠」（/pet 选择、/chat 使用）：全局单值不分会话；进程内内存，重启回默认第一只
  let activePetId = '';
  // 命令触发的展示气泡缓存（/chat 命令写入；浏览器/桌面 1s 轮询 /broadcast 拉取，ts 变化即弹气泡）。
  // 与碎碎念周期缓存（whisperCache）独立：手动触发语义不受 whisperEnabled 门控（进程内，重启清空）
  const broadcastCache = new Map<string, { text: string; ts: number }>();
  // 碎碎念生成缓存（按宠物独立）：每只启用的宠物在自己的周期内返回同一句（ts 不变），
  // 同宠物的多个端共享一句、避免重复 LLM 调用（进程内内存态，重启清空）
  const whisperCache = new Map<string, { text: string; ts: number }>();

  // 对话记忆文件（唯一读写方 = 本进程；浏览器/桌面两端都只是客户端 → 同一实例天然共享同一份记忆）。
  // 结构双层：{ <种类桶 assetRoot ?? petId>: { <实例 id>: { messages: ChatMemoryMessage[] } } }
  const memoryPath = join(userRoot, 'memory.json');
  // 对话写操作串行队列：read-modify-write 排队执行，防两端同时对话时交错写盘
  let chatQueue: Promise<void> = Promise.resolve();

  /** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    let raw: string;
    try {
      raw = await readFile(memoryPath, 'utf8');
    } catch {
      return {}; // 文件不存在 = 尚无记忆
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      return parsed as Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;
    } catch (e) {
      console.error(
        `dsh-pet: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`,
      );
      try {
        await mkdir(userRoot, { recursive: true });
        await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, 'utf8');
      } catch {
        /* 备份失败仅告警，不阻断 */
      }
      return {};
    }
  };

  const writeMemory = async (mem: Record<string, Record<string, { messages: ChatMemoryMessage[] }>>): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(memoryPath, JSON.stringify(mem, null, 2), 'utf8');
  };

  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  const withMemoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---- 配置消费：唯一入口 readAllConfig（./config）——返回值绝对正确，这里只读字段，零校验 ----

  /** 某宠物的最终人设 system：所属条目（非文件宠物 → main 条目）的 whisperPrompt（合并器已填默认）
   *  + 无条件追加一句名字声明（name，缺失已按 id）——碎碎念与对话共用同一拼装。 */
  const petSystemPrompt = (petId: string, cfg: Record<string, Record<string, unknown>>): string => {
    const found = findPetInstance(cfg, petId);
    const conf = found ? found.conf : (cfg.main ?? {});
    const prompt = typeof conf.whisperPrompt === 'string' ? conf.whisperPrompt : '';
    const name = found ? String(found.pet.name || found.pet.id || petId) : petId;
    const nameLine = '你的名字是“' + name + '”。';
    return prompt ? prompt + '\n' + nameLine : nameLine;
  };

  /** 对话记忆轮数（1 轮 = 1 问 1 答）：所属条目/主条目的 chatMemoryRounds（合并器已填默认非负数字） */
  const memoryRounds = (petId: string, cfg: Record<string, Record<string, unknown>>): number => {
    const found = findPetInstance(cfg, petId);
    const v = Number(found?.conf.chatMemoryRounds ?? cfg.main?.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };

  /** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
   *  每只宠物独立生成（所属条目的人设），缓存按 pet 分开；
   *  force=false 走周期节流（缓存期内返回同一句 ts），force=true 强制新生成并刷新缓存
   *  （右键菜单「碎碎念」手动触发：绕过节流立即新出一句，同宠多端下次轮询看到新 ts 一起展示）。 */
  const serveWhisper = async (
    petId: string,
    force: boolean,
  ): Promise<{ ok: boolean; text?: string; ts?: number; reason?: string; message?: string }> => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    const conf = found ? found.conf : (cfg.main ?? {});
    // 所属条目的碎碎念周期（合并器已填内置默认，必为正数秒）
    const ers = conf.eventsRefreshSec as Record<string, unknown> | undefined;
    const intervalSec = ers && typeof ers.whisper === 'number' ? ers.whisper : 3600;
    const system = petSystemPrompt(petId, cfg);
    const now = Date.now();
    const cached = whisperCache.get(petId);
    if (!force && cached && now - cached.ts < intervalSec * 1000) {
      return { ok: true, text: cached.text, ts: cached.ts };
    }
    const result = await generateWhisper(ctx, system);
    if (!result.ok) {
      return { ok: false, reason: result.reason, message: result.message };
    }
    whisperCache.set(petId, { text: result.text, ts: now });
    return { ok: true, text: result.text, ts: now };
  };

  /** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 返回 {reply,ts}。
   *  供 /chat 端点（POST）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。 */
  const chatWithPet = async (
    petId: string,
    text: string,
  ): Promise<
    | { ok: true; reply: string; ts: number }
    | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string }
  > =>
    withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const rounds = memoryRounds(petId, cfg);
      // 人设：所属条目的 whisperPrompt（合并器已填默认）+ 名字声明（与碎碎念同一拼装）
      const system = petSystemPrompt(petId, cfg);
      const mem = await readMemory();
      const bucketKey = findPetInstance(cfg, petId)?.entry ?? petId;
      const bucket = (mem[bucketKey] ??= {});
      const entry = (bucket[petId] ??= { messages: [] });
      const list = entry.messages.slice().slice(-rounds * 2);
      const generated = await generateChat(ctx, system, list, text);
      if (!generated.ok) return generated;
      const now = Date.now();
      entry.messages.push({ role: 'user', content: text, ts: now });
      entry.messages.push({ role: 'assistant', content: generated.text, ts: now });
      await writeMemory(mem);
      return { ok: true as const, reply: generated.text, ts: now };
    });

  /**
   * 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
   * 字段填满），命令与桌面模式都从这里取。
   */
  const effectivePetList = (): Record<string, unknown>[] => flattenPetList(readAllConfig(configPaths));

  /** 命令触发的展示气泡：/chat 命令写入（两端 1s 轮询 /broadcast 拉取展示）；覆盖手动触发场景 */
  const broadcastTo = (petId: string, text: string): void => {
    broadcastCache.set(petId, { text, ts: Date.now() });
  };

  /** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
  const resolveActivePetId = (): string => {
    try {
      const eff = effectivePetList();
      if (eff.length === 0) return '';
      if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
      return String(eff[0].id);
    } catch {
      return activePetId;
    }
  };

  /** 宠物的显示名（name，缺失回落 id）——命令文案用 */
  const petDisplayName = (pet: Record<string, unknown>): string => {
    const n = String(pet.name ?? '').trim();
    return n || String(pet.id ?? '');
  };

  let hasDesktopPet = false;
  const refreshDesktop = (): void => {
    hasDesktopPet = false;
    try {
      hasDesktopPet = effectivePetList().some((p) => isDesktopVisible(p.display));
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  refreshDesktop();

  /** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
  const desktopPetList = (): Array<{ id: string; size: number }> => {
    try {
      return effectivePetList()
        .filter((p) => isDesktopVisible(p.display))
        .map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };

  let helper: HelperProcess | undefined;
  let startRetryTimer: NodeJS.Timeout | undefined;
  let electronEnsure: Promise<void> | undefined;
  let disposed = false;

  /** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
  const launchHelper = (electronPath: string | undefined): void => {
    if (helper || disposed) return;
    if (!hasDesktopPet) return; // 无宠物显示在桌面（display 含 desktop/both）：不启动
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    if (!port || port <= 0) {
      // webServer 可能尚未完成监听（OS 分配端口时 port 短暂为 0）：延迟重试。
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = undefined;
          launchHelper(electronPath);
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    const origin = `http://127.0.0.1:${port}`;
    // 桌面渲染端也从同一份 handlePetRoute 拿成品配置（每只宠物一个局部小窗口；经管道，不走 HTTP——
    // DSH Desktop 2.0.3+ 会拦插件自拉进程的裸 HTTP 请求，浏览器访问闸门只放行带令牌的请求）
    const configUrl = `${origin}${ROUTE_PREFIX}/config`;
    helper = new HelperProcess(
      {
        electronPath,
        env: {
          DSH_PET_CONFIG_URL: configUrl,
          DSH_PET_SCALE: '1',
          // 打开 bridge 协议：main.js 注册 dsh-pet-bridge scheme，把渲染端请求经管道转给宿主
          DSH_PET_BRIDGE: '1',
          // 每只桌面宠物一个局部小窗口：透传宠物列表（[{id,size}]）
          DSH_PET_PETS: JSON.stringify(desktopPetList()),
        },
        // bridge 协议处理器 = HTTP 路由同一份 handlePetRoute（业务逻辑唯一，两端天然一致）；
        // 素材过文件路径（main.js 自行读盘），json/text 过 body
        bridgeHandler: async (req) => {
          const result = await handlePetRoute(req.url ?? '/', req.method ?? 'GET', req.body);
          if (result.kind === 'file') {
            // file 分支恒 200（404/400 已由 text 分支表达）
            return { id: req.id, status: 200, contentType: result.contentType, file: result.file };
          }
          if (result.kind === 'text') {
            return { id: req.id, status: result.status, contentType: 'text/plain; charset=utf-8', body: result.body };
          }
          return {
            id: req.id,
            status: result.status,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(result.obj),
          };
        },
      },
      ctx.logger ?? console,
    );
    try {
      helper.start();
      ctx.logger?.info?.(`dsh-pet desktop helper started (config: ${configUrl})`);
    } catch (e) {
      ctx.logger?.warn?.(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
      helper = undefined;
    }
  };

  /** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
   *  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
  const startHelper = (): void => {
    if (helper || electronEnsure || disposed) return;
    if (!hasDesktopPet) return; // 无宠物显示在桌面（display 含 desktop/both）：不启动
    const found = resolveElectronPath();
    if (found) {
      launchHelper(found);
      return;
    }
    console.warn(`[dsh-pet] Electron not found, downloading to ${defaultElectronExe()} ...`);
    electronEnsure = ensureElectronDownload()
      .then((path) => {
        if (path) {
          launchHelper(path);
        } else {
          console.warn(
            '[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.',
          );
        }
      })
      .finally(() => {
        electronEnsure = undefined;
      });
  };

  /** 停止桌面 Helper（保留配置，可再次拉起）。 */
  const stopHelper = (reason = 'settings-change'): void => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    helper?.stop(reason);
    helper = undefined;
  };

  /** 宠物配置（display 等）变更后：重解析桌面宠物并按需重启 Helper。 */
  const syncDesktop = (): void => {
    refreshDesktop();
    stopHelper('desktop-config-change');
    startHelper();
  };

  /** 包内动画素材根：唯一格式 webm。 */
  const assetRootFor = (): string => join(PACKAGE_ROOT, 'assets', 'webm');

  /** 用户动画根：唯一格式 webm（main-animation/webm）。 */
  const userRootFor = (): string => join(thumbUserRoot, 'webm');

  /** 单次业务路由(WebServer 注册 → HTTP 落盘 / 桌面 Helper 管道 → scheme 应答,共用同一份实现):
   *  输入只需 rawUrl(/dsh-pet-7340/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
   *  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:浏览器/桌面行为严格对齐)。 */
  const handlePetRoute = async (rawUrl: string, method: string, body?: string): Promise<RouteResult> => {
    const url = new URL(rawUrl, 'http://localhost');
    const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));

    // 成品配置：/dsh-pet-7340/config（GET 读取合并成品 / PUT 保存用户层 / DELETE 恢复默认）
    if (rest === 'config') {
      if (method === 'GET') {
        // 唯一配置入口：readAllConfig 返回绝对正确的完成品聚合（{ main:{...}, test1:{...} }），
        // 浏览器/桌面/设置页直接消费，无需任何校验/兜底
        try {
          return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
        } catch (e) {
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === 'PUT') {
        try {
          const parsed = JSON.parse(body ?? '');
          // 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段（physics/whisperPrompt/
          // chatMemoryRounds/...）带回给 saveUserConfig——设置页保存不再抹掉用户手改的精调配置
          let existing: Record<string, unknown> | undefined;
          try {
            existing = JSON.parse(await readFile(userConfigPath, 'utf8')) as Record<string, unknown>;
          } catch {
            /* 文件不存在/损坏：视为无既有用户字段，不阻塞保存 */
          }
          const clean = saveUserConfig(parsed, existing);
          if (!clean) {
            return {
              kind: 'json',
              status: 400,
              obj: {
                error:
                  'invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled 布尔）',
              },
            };
          }
          await mkdir(userRoot, { recursive: true });
          await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
          syncDesktop(); // display 等可能变化：重解析桌面宠物并重启 Helper
          return { kind: 'json', status: 200, obj: { ok: true } };
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }
      if (method === 'DELETE') {
        try {
          await rm(userConfigPath, { force: true });
        } catch {
          /* 不存在也视为成功 */
        }
        syncDesktop(); // 恢复默认配置：重解析桌面宠物并重启 Helper
        return { kind: 'json', status: 200, obj: { ok: true } };
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    // 配置文件路径（设置页「高级配置」展示用）
    if (rest === 'config/meta') {
      return {
        kind: 'json',
        status: 200,
        obj: {
          user: userConfigPath,
          default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
          animations: thumbUserRoot,
        },
      };
    }

    // 余额查询（浏览器/桌面共用；结果由 host 侧完成全部抓取与校验，两端都不接触 key）
    if (rest === 'balance') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const sel = ctx.agentDefaultModel.currentSelection();
        const result = await queryBalance(sel.provider, async (ref) => {
          const rc = await ctx.credentials.resolve(credentialRef(ref));
          return rc?.value;
        });
        return { kind: 'json', status: 200, obj: result };
      } catch (e) {
        // 意外异常（如注入服务缺失）：显式 500，不静默
        return {
          kind: 'json',
          status: 500,
          obj: {
            ok: false,
            provider: 'unknown',
            reason: 'fetch-error',
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    }

    // 手动触发计数：/dsh-pet-7340/balance/trigger（no-cache，浏览器/桌面 1s 轻量轮询；/balance 命令写入）
    if (rest === 'balance/trigger') {
      return {
        kind: 'json',
        status: 200,
        obj: { count: balanceTriggerCount },
        headers: { 'cache-control': 'no-cache, no-store' }, // 触发计数必须实时，禁止任何缓存层介入
      };
    }

    // 碎碎念周期文本：/dsh-pet-7340/whisper?pet=<id>（GET，浏览器/桌面共用）
    // 按宠物独立生成：每只启用碎碎念的宠物在自己的周期用**所属条目的人设**生成一句话
    // （文件宠物 = pet/<名>-config.json 顶层 whisperPrompt；主宠物 = main 条目即内置默认）。
    // 节流/缓存按 pet 分开：同一宠物周期内重复请求返回同一句（ts 不变，client 检测变化才触发），
    // 同一宠物的多个端（浏览器+桌面窗口）共享一句，不重复调 LLM。
    if (rest === 'whisper') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const petId = String(url.searchParams.get('pet') ?? '');
        return { kind: 'json', status: 200, obj: await serveWhisper(petId, false) };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 碎碎念手动触发：/dsh-pet-7340/whisper/trigger?pet=<id>（GET，右键菜单「碎碎念」用）
    // 与周期端点同一逻辑，但 force=true：绕过节流缓存立即强制新生成一句并刷新缓存
    // （同宠物周期轮询端下次拉取看到新 ts 也会跟着展示——与 /balance/trigger 同语义）。
    if (rest === 'whisper/trigger') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const petId = String(url.searchParams.get('pet') ?? '');
        return { kind: 'json', status: 200, obj: await serveWhisper(petId, true) };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 对话：/dsh-pet-7340/chat?pet=<id>
    //   GET  —— 最近记忆窗口（截尾 chatMemoryRounds 轮），弹窗打开时展示
    //   POST —— 携带历史生成回复并写入记忆（{text} → {ok, reply, ts}）
    // 记忆唯一读写方 = host（memory.json；浏览器/桌面两端都只是客户端）→
    // 同一实例的浏览器与桌面天然共享同一份记忆；文件全存不删，
    // 请求只截尾部 chatMemoryRounds 轮（1 轮 = 1 问 1 答；合并器已按条目填默认）。
    if (rest === 'chat') {
      const petId = String(url.searchParams.get('pet') ?? '');
      try {
        if (method === 'GET') {
          const cfg = readAllConfig(configPaths);
          const mem = await readMemory();
          const bucket = mem[findPetInstance(cfg, petId)?.entry ?? petId] ?? {};
          const list = (bucket[petId]?.messages ?? []).slice();
          const rounds = memoryRounds(petId, cfg);
          return { kind: 'json', status: 200, obj: { ok: true, messages: list.slice(-rounds * 2), rounds } };
        }
        if (method === 'POST') {
          const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          if (!text) {
            return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
          }
          if (text.length > 2000) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
            };
          }
          const result = await chatWithPet(petId, text);
          return { kind: 'json', status: 200, obj: result };
        }
        return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      } catch (e) {
        // 配置已由 readAllConfig 保证正确（不再有 config-error 分支）；其余（IO/LLM）→ generate-error
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 命令触发气泡广播：/dsh-pet-7340/broadcast?pet=<id>（GET，no-cache）
    // /chat 命令把碎碎念/对话文本写入 broadcastCache，浏览器/桌面 1s 轻量轮询拉取，
    // ts 变化即弹气泡——与 /balance/trigger 同语义（无缓存返回 ts=0，轮询侧恒定不触发）
    if (rest === 'broadcast') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const petId = String(url.searchParams.get('pet') ?? '');
      const hit = broadcastCache.get(petId);
      return {
        kind: 'json',
        status: 200,
        obj: { ok: true, text: hit?.text ?? '', ts: hit?.ts ?? 0 },
        headers: { 'cache-control': 'no-cache, no-store' },
      };
    }

    // 动画文件：/dsh-pet-7340/thumb/<素材根>/<file>，唯一格式 webm。
    // 素材归属按「是否存在该宠物的独立素材目录 `pet/<petId>-animation/`」判定：
    //   - 存在（pet pack 宠物）：只查自己的目录，查不到即 404 显式报错——绝不混用
    //   - 不存在（**所有主配置宠物**，main 与用户添加的任意多只）：主素材链
    //     main-animation/webm 优先 → 包内 assets/webm（与宠物数量无关，多只共用）
    // Safari/HEVC(.mov) 兼容属 fork 定制（保留流水线 scripts/encode_hevc_alpha.sh）；
    // 需要者自行在本路由加回 .mov 扩展名分支——插件本体不发布、不支持 .mov。
    // 注意：font / pic 是扁平的 /<scope>/<file>，只有 thumb 是 /<scope>/<petId>/<file>——
    // 这里先拆 scope，再按 scope 各自拆剩余段，避免 font/pic 被误当作 petId 吞掉文件段。
    const [scope, ...restParts] = rest.split('/');
    if (scope === 'font') {
      const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
      const fontFile = resolveExisting(fontRoot, restParts.join('/'));
      if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: font not found' };
      const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: fontFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）
    if (scope === 'pic') {
      const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
      const picFile = resolveExisting(picRoot, restParts.join('/'));
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
      const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    if (scope !== 'thumb') {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    // thumb 是三段式：/<scope>/<petId>/<file>——从这里再拆宠物 id 与文件名
    const [petId, ...nameParts] = restParts;
    if (!petId || nameParts.length === 0) {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    const fileName = nameParts.join('/');
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (ext !== '.webm') {
      return { kind: 'text', status: 400, body: 'dsh-pet: unsupported animation format (expected .webm)' };
    }
    // 素材归属（按是否存在该宠物的独立素材目录判定，绝不静默混用）：
    //   - 存在 `pet/<petId>-animation/`（pet pack 宠物，URL 段 = 素材根 assetRoot）：
    //     只查自己的目录，查不到即 404 显式报错——绝不回落别的素材
    //   - 不存在（**所有主配置宠物**：main 及用户添加的任意多只，共用全局动画池）：
    //     主素材链——用户 main-animation/webm 优先，其次包内 assets/webm
    const extraAnimDir = join(userRoot, 'pet', petId + '-animation');
    const file = existsSync(extraAnimDir)
      ? resolveExisting(extraAnimDir, fileName)
      : (resolveExisting(userRootFor(), fileName) ?? resolveExisting(assetRootFor(), fileName));
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: asset not found' };
    return { kind: 'file', file, contentType: MIME[ext] ?? 'application/octet-stream' };
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            const body = req.method === 'PUT' || req.method === 'POST' ? await readBody(req) : undefined;
            const result = await handlePetRoute(req.url ?? '/', req.method ?? 'GET', body);
            if (result.kind === 'json') sendJson(res, result.status, result.obj, result.headers);
            else if (result.kind === 'text') sendText(res, result.status, result.body);
            else await sendFile(res, result.file, result.contentType);
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        },
      }),
    'dsh-pet: /dsh-pet-7340 asset route',
  );

  // /balance 斜杠命令：递增触发计数 → 浏览器/桌面检测到变化后立即刷新余额并播动画（不进模型历史）
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

  // /pet 斜杠命令：选择「当前桌宠」（/chat 对话的目标）。浏览器端另有 commandUi 装饰的选择框
  // （裸输 /pet 回车或菜单点选时弹出，选中后提交 /pet <id> 走同一 handler）；手输参数认 id 或名字
  // （name 可重复：唯一命中才认，重名报错列出候选 id）。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'pet',
        description: '选择桌宠（/chat 对话的目标；支持选择框或手输 id/名字）',
        input: { hint: '[宠物 id 或名字]（留空查看当前）' },
        handler: ({ rawInput }: { rawInput: string }) => {
          const arg = rawInput.trim();
          let eff: Record<string, unknown>[];
          try {
            eff = effectivePetList();
          } catch {
            eff = [];
          }
          if (!arg) {
            const cur = resolveActivePetId();
            const found = eff.find((p) => String(p.id) === cur);
            return {
              kind: 'success',
              text: '当前桌宠：' + (found ? petDisplayName(found) : cur || '（无可交互桌宠）'),
            };
          }
          const byId = eff.find((p) => String(p.id) === arg);
          if (byId) {
            activePetId = String(byId.id);
            return { kind: 'success', text: '已选择桌宠：' + petDisplayName(byId) };
          }
          const byName = eff.filter((p) => petDisplayName(p) === arg);
          if (byName.length === 1) {
            activePetId = String(byName[0].id);
            return { kind: 'success', text: '已选择桌宠：' + petDisplayName(byName[0]) };
          }
          if (byName.length > 1) {
            return {
              kind: 'error',
              text:
                '「' +
                arg +
                '」有 ' +
                byName.length +
                ' 只桌宠（id：' +
                byName.map((p) => String(p.id)).join('、') +
                '），请用 id 指定',
            };
          }
          return { kind: 'error', text: '找不到桌宠「' + arg + '」（id 或名字都行；/pet 回车可打开选择框）' };
        },
      }),
    'dsh-pet: /pet command',
  );

  // /chat 斜杠命令：与当前桌宠对话。无参数 = 碎碎念一句（手动语义：绕过节流立即新生成，不受
  // whisperEnabled 门控）；有参数 = 正常对话（走 /chat 端点同一条路径：记忆 + 人设 + 写盘）。
  // 两分支的文本都写入广播缓存 → 浏览器/桌面 1s 轮询 /broadcast 拉取后弹气泡展示。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'chat',
        description: '与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话',
        input: { hint: '[消息]（留空 = 碎碎念）' },
        handler: async ({ rawInput }: { rawInput: string }) => {
          const petId = resolveActivePetId();
          if (!petId) return { kind: 'error', text: '没有可交互的桌宠' };
          const text = rawInput.trim();
          try {
            if (!text) {
              // 碎碎念：force=true 立即生成并刷新周期缓存（同宠物两端轮询 /whisper 也会跟着展示）
              const w = await serveWhisper(petId, true);
              if (!w.ok) {
                return { kind: 'error', text: '碎碎念生成失败' + (w.message ? '：' + w.message : '') };
              }
              broadcastTo(petId, w.text ?? '');
              return { kind: 'success', text: w.text ?? '' };
            }
            if (text.length > 2000) return { kind: 'error', text: '消息过长（限 2000 字）' };
            const r = await chatWithPet(petId, text);
            if (!r.ok) {
              return { kind: 'error', text: '对话失败' + (r.message ? '：' + r.message : '') };
            }
            broadcastTo(petId, r.reply);
            return { kind: 'success', text: r.reply };
          } catch (e) {
            return { kind: 'error', text: '对话失败：' + (e instanceof Error ? e.message : String(e)) };
          }
        },
      }),
    'dsh-pet: /chat command',
  );

  // 系统通知不在此处：它独立于宠物（浏览器半侧 notify.ts 经 connection 事件流监听），
  // 宿主无需任何通知端点/监听。

  // 随插件生命周期清理：桌面 Helper 回收（异步下载完成后不再拉起）
  ctx.effect(() => () => {
    disposed = true;
    stopHelper('dsh-host-stop');
  });

  // 路由就绪后拉起桌面 Helper（Electron 缺失时仅告警，不影响 DSH 与浏览器 overlay）
  startHelper();
}
