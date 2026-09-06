/**
 * 任务桥接 host 半侧 —— 宠物的任务消息经此模块进程内直调 DSH Agent
 * （ctx.agents：新建/恢复会话、agent.followup 派发、cancel 取消），并把绑定会话的
 * 展示类 session/event 帧化成最小词汇缓冲给两端（浏览器/桌面）轮询排水。
 *
 * 自包含（不 import src/shared —— DSH 单文件加载约束）；帧类型与
 * src/shared/task.ts 的 TaskStreamFrame 严格同步（host 不能引用共享目录，契约靠注释钉住）。
 *
 * 粘性绑定（工作区驱动）：每宠物 {workspaceId, sessionId} 落盘 $DSH_HOME/dsh-pet/task-state.json；
 * workspaceId = DSH 工作区注册表（与 Web 侧边栏同一份），'' = 默认工作目录（Web 的"未分组"）。
 * 会话策略（pets[i].task.session）：last=粘性（默认）/ new=每次任务新建 / 其余=固定绑定。
 * 用户主动「切换/新建」（/task/open）恒粘性写盘（决策 1：选定就一直用）。
 *
 * 会话对 Web 透明：新建会话带 meta.cwd（工作区路径），并在创建后 attach 进该工作区——
 * Web 侧边栏可见、可续聊同一会话。创建/恢复的 AgentHandle 由本模块持有，
 * 插件卸载时统一 dispose（与 Web 网关同款所有权语义）。
 */
import { statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { findPetInstance } from './config';

/** 任务流帧（与 src/shared/task.ts 的 TaskStreamFrame 同步；字段/语义一致） */
export type TaskFrame =
  | { type: 'turn-start'; seq: number }
  | { type: 'user'; seq: number; text: string }
  | { type: 'chunk'; seq: number; text: string }
  | { type: 'assistant'; seq: number; text: string }
  | { type: 'tool-call'; seq: number; name: string; id: string }
  | { type: 'tool-result'; seq: number; id: string; ok: boolean }
  | { type: 'turn-end'; seq: number }
  | { type: 'error'; seq: number; message: string }
  | { type: 'truncated'; seq: number };

/** 任务路由应答（与 host/index.ts 的 RouteResult 结构兼容；任务路由不返回文件） */
export type TaskRouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string };

/** 每宠物粘性绑定（task-state.json 持久化结构；folder 为 v1 遗留字段，读取时迁移） */
interface PetTaskState {
  /** DSH 工作区 id；'' = 默认工作目录（未分组） */
  workspaceId: string;
  sessionId: string | null;
}

/** 每会话帧队列（有界；溢出丢最旧并在头部放 truncated 帧） */
interface SessionQueue {
  frames: TaskFrame[];
}

const MAX_FRAMES = 500; // 每会话帧缓冲上限（客户端 500ms 轮询排水；会话日志是权威，缓冲只是展示缓存）

/** 桥接选项：宿主在 apply 里组装好传入 */
export interface TaskBridgeOptions {
  /** 用户数据根（$DSH_HOME/dsh-pet）：task-state.json 落盘位置 */
  userRoot: string;
  /** 成品配置读取（readAllConfig 闭包，绝对正确零校验） */
  readAllConfig: () => Record<string, Record<string, unknown>>;
}

/** task 桥接返回值：route 供 handlePetRoute 挂载，dispose 随插件卸载回收 */
export interface TaskBridge {
  route: (rest: string, method: string, body: string | undefined, params: URLSearchParams) => Promise<TaskRouteResult>;
  dispose: () => Promise<void>;
}

/** 发送 JSON 任务应答 */
function json(status: number, obj: unknown, headers?: Record<string, string>): TaskRouteResult {
  return { kind: 'json', status, obj, headers };
}

/** 从 ContentBlock[] 提取纯文本（text 与 text_delta 块都认；防版本差异） */
function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    if (o.type === 'text' || o.type === 'text_delta') {
      out += typeof o.text === 'string' ? o.text : String(o.text ?? '');
    }
  }
  return out;
}

/** session/event → 展示帧；不关心的事件返回 null */
function eventToFrame(event: unknown): TaskFrame | null {
  const ev = (event ?? {}) as { type?: unknown; seq?: unknown; data?: Record<string, unknown> };
  const type = typeof ev.type === 'string' ? ev.type : '';
  const seq = Number(ev.seq);
  if (!Number.isFinite(seq) || seq <= 0) return null;
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'turn/start':
      return { type: 'turn-start', seq };
    case 'user/message': {
      const text = blocksToText(d.content);
      if (!text) return null;
      return { type: 'user', seq, text };
    }
    case 'assistant/chunk': {
      const text = blocksToText(d.content);
      if (!text) return null;
      return { type: 'chunk', seq, text };
    }
    case 'assistant/message': {
      const text = blocksToText(d.content);
      if (!text) return null;
      return { type: 'assistant', seq, text };
    }
    case 'tool/call':
      return { type: 'tool-call', seq, name: String(d.name ?? ''), id: String(d.id ?? '') };
    case 'tool/result': {
      let ok = true;
      if (typeof d.ok === 'boolean') ok = d.ok;
      else if (d.isError === true || d.error !== undefined) ok = false;
      return { type: 'tool-result', seq, id: String(d.id ?? ''), ok };
    }
    case 'turn/end':
      return { type: 'turn-end', seq };
    default:
      return null;
  }
}

/**
 * 创建任务桥。ctx 为宿主 cordis 上下文（host/index.ts 已注入 agents；
 * sessionQuery / workspaceRegistry 经 ctx.get 可选读取，缺失时列表降级）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（agents/sessionQuery/workspaceRegistry 服务无静态类型，与 host/index.ts 同约定）
export function createTaskBridge(ctx: any, options: TaskBridgeOptions): TaskBridge {
  const { userRoot, readAllConfig } = options;
  const statePath = join(userRoot, 'task-state.json');

  // ---- 粘性状态读写（损坏→备份+重建；写操作串行，防两端交错写盘） ----
  let stateQueue: Promise<void> = Promise.resolve();

  const readState = async (): Promise<Record<string, PetTaskState>> => {
    let raw: string;
    try {
      raw = await readFile(statePath, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      return parsed as Record<string, PetTaskState>;
    } catch (e) {
      console.error(
        `dsh-pet: 任务粘性状态损坏已备份（将从头绑定会话）：${statePath}（${e instanceof Error ? e.message : String(e)}）`,
      );
      try {
        await mkdir(userRoot, { recursive: true });
        await writeFile(`${statePath}.bak-${Date.now()}`, raw, 'utf8');
      } catch {
        /* 备份失败仅告警，不阻断 */
      }
      return {};
    }
  };

  const writeState = (petId: string, next: PetTaskState): Promise<void> => {
    const run = stateQueue.then(async () => {
      const all = await readState();
      all[petId] = next;
      await mkdir(userRoot, { recursive: true });
      await writeFile(statePath, JSON.stringify(all, null, 2), 'utf8');
    });
    stateQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---- 配置/绑定解析 ----
  /** 该宠物的 task 配置（合并器已填默认；防御性回落） */
  const petTaskConf = (petId: string): { folder: string; session: string; agentPreset: string } => {
    try {
      const cfg = readAllConfig();
      const found = findPetInstance(cfg, petId);
      const conf = found ? found.conf : (cfg.main ?? {});
      const t = (found?.pet?.task ?? conf?.task ?? {}) as Record<string, unknown>;
      return {
        folder: typeof t.folder === 'string' ? t.folder : '',
        session: typeof t.session === 'string' && t.session.length > 0 ? t.session : 'last',
        agentPreset: typeof t.agentPreset === 'string' ? t.agentPreset : '',
      };
    } catch {
      return { folder: '', session: 'last', agentPreset: '' };
    }
  };

  /** 工作区注册表（可选服务；多处经它读工作区/成员会话）——结构型最小面，避免跨版本类型依赖 */
  interface WorkspaceEntityLike {
    id?: unknown;
    path?: unknown;
    title?: unknown;
    sessionIds?: unknown[];
    attachSession?: (sessionId: string) => Promise<void>;
  }
  interface WorkspaceRegistryLike {
    get: (id: string) => WorkspaceEntityLike | undefined;
    list: () => WorkspaceEntityLike[];
    resolveByPath: (path: string) => Promise<WorkspaceEntityLike | undefined>;
  }
  const wsRegistry = (): WorkspaceRegistryLike | undefined =>
    ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;

  /** 文件夹路径 → 工作区 id（未拥有该目录/服务缺失 → ''，即默认目录） */
  const resolveIdByPath = async (folder: string): Promise<string> => {
    const ws = wsRegistry();
    if (!folder || !ws) return '';
    try {
      const w = await ws.resolveByPath(folder);
      return w && typeof w.id === 'string' ? String(w.id) : '';
    } catch {
      return '';
    }
  };

  /** 运行时活动绑定（petId → 当前会话 id；驱动流式转发；进程内内存态） */
  const activeBindings = new Map<string, string>();
  /** 会话 id → 绑定它的宠物集合（事件监听反查；由 activeBindings 重建） */
  let sessionToPets = new Map<string, Set<string>>();
  /** 本模块创建/恢复的 AgentHandle（插件卸载时统一 dispose） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentHandle 为 rc.6 运行时类型，本包 peer 类型未对齐，运行时结构型访问
  const handles = new Map<string, any>();
  /** 每会话帧队列 */
  const queues = new Map<string, SessionQueue>();

  const rebuildSessionMap = (): void => {
    const next = new Map<string, Set<string>>();
    for (const [petId, sessionId] of activeBindings) {
      let set = next.get(sessionId);
      if (!set) {
        set = new Set();
        next.set(sessionId, set);
      }
      set.add(petId);
    }
    sessionToPets = next;
  };

  const setActive = (petId: string, sessionId: string): void => {
    activeBindings.set(petId, sessionId);
    rebuildSessionMap();
  };

  const pushFrame = (sessionId: string, frame: TaskFrame): void => {
    let q = queues.get(sessionId);
    if (!q) {
      q = { frames: [] };
      queues.set(sessionId, q);
    }
    if (q.frames.length >= MAX_FRAMES) {
      const dropped = q.frames.shift();
      q.frames.unshift({ type: 'truncated', seq: dropped ? dropped.seq : frame.seq });
    }
    q.frames.push(frame);
  };

  // ---- 会话就位 ----
  const isDirectory = (folder: string): boolean => {
    try {
      return statSync(folder).isDirectory();
    } catch {
      return false;
    }
  };

  /** 解析该宠物当前绑定（策略 + 状态文件 + 配置默认文件夹；旧 folder 状态自动迁移为工作区 id） */
  const resolveBinding = async (petId: string): Promise<PetTaskState> => {
    const conf = petTaskConf(petId);
    const state = await readState();
    const st = state[petId];
    const legacy = (st ?? {}) as { folder?: unknown; workspaceId?: unknown; sessionId?: unknown };
    let workspaceId = typeof legacy.workspaceId === 'string' ? legacy.workspaceId : '';
    // v1 遗留：状态存 folder 路径 → 解析成工作区 id（未命中归默认目录）
    if (!workspaceId && typeof legacy.folder === 'string' && legacy.folder) {
      workspaceId = await resolveIdByPath(legacy.folder);
    }
    // 配置默认文件夹（状态无工作区时生效）→ 工作区 id
    if (!workspaceId && conf.folder) {
      workspaceId = await resolveIdByPath(conf.folder);
    }
    if (conf.session !== 'last' && conf.session !== 'new') {
      return { workspaceId, sessionId: conf.session };
    }
    if (conf.session === 'new') {
      return { workspaceId, sessionId: null };
    }
    const sessionId = typeof legacy.sessionId === 'string' && legacy.sessionId ? legacy.sessionId : null;
    return { workspaceId, sessionId };
  };

  /** 新建会话：工作区路径 → agents.create → attach 工作区 → 粘性写盘（sticky=false 不存 sessionId） */
  const createSession = async (petId: string, workspaceId: string, sticky: boolean): Promise<{ sessionId: string }> => {
    let cwd: string | undefined;
    let ws: WorkspaceEntityLike | undefined;
    const workspaceRegistry = wsRegistry();
    if (workspaceId && workspaceRegistry) {
      try {
        const entity = workspaceRegistry.get(workspaceId);
        if (entity && typeof entity.path === 'string' && isDirectory(entity.path)) {
          ws = entity;
          cwd = entity.path;
        }
      } catch {
        /* 未知工作区：按默认目录建会话 */
      }
    }
    const conf = petTaskConf(petId);
    const sessionId = 'pet-' + randomUUID();
    const meta: Record<string, unknown> = {};
    if (cwd) meta.cwd = cwd;
    if (conf.agentPreset) meta.agentPreset = conf.agentPreset;
    const handle = await ctx.agents.create({ sessionId, meta });
    handles.set(sessionId, handle);
    if (ws && typeof ws.attachSession === 'function') {
      try {
        await ws.attachSession(sessionId);
      } catch {
        /* 附接失败不阻断：会话仍可用（不进工作区分组） */
      }
    }
    setActive(petId, sessionId);
    await writeState(petId, {
      workspaceId: cwd ? workspaceId : '',
      sessionId: sticky ? sessionId : null,
    });
    return { sessionId };
  };

  /** 发送/取消共用：拿到绑定会话的 live Agent（live 直用 → 冷 resume → 失败回退新建） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Agent 为 rc.6 运行时类型，本包 peer 类型未对齐，运行时结构型访问
  const ensureSession = async (petId: string): Promise<{ agent: any; sessionId: string }> => {
    const binding = await resolveBinding(petId);
    if (binding.sessionId) {
      const live = ctx.agents.get(binding.sessionId);
      if (live) {
        setActive(petId, binding.sessionId);
        return { agent: live, sessionId: binding.sessionId };
      }
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: binding.sessionId });
        handles.set(binding.sessionId, handle);
        setActive(petId, binding.sessionId);
        return { agent: handle.agent, sessionId: binding.sessionId };
      } catch (e) {
        console.warn(
          `dsh-pet: 会话「${binding.sessionId}」恢复失败，已回退新建会话（${e instanceof Error ? e.message : String(e)}）`,
        );
        await writeState(petId, { workspaceId: binding.workspaceId, sessionId: null });
      }
    }
    const conf = petTaskConf(petId);
    // 固定绑定策略：目标会话恢复失败即报错（绝不静默新建——用户明确指定了那个会话）
    if (conf.session !== 'last' && conf.session !== 'new') {
      throw new Error('固定绑定的会话「' + String(binding.sessionId) + '」无法恢复，任务未派发');
    }
    const { sessionId } = await createSession(petId, binding.workspaceId, conf.session !== 'new');
    const agent = ctx.agents.get(sessionId);
    if (!agent) throw new Error('dsh-pet: 会话创建后未找到 Agent：' + sessionId);
    return { agent, sessionId };
  };

  // ---- 事件监听：绑定会话的展示事件 → 帧化入队（两端轮询排水） ----
  ctx.effect(
    () =>
      ctx.on('session/event', (session: unknown, event: unknown) => {
        const sid = String(
          (session as { id?: unknown; header?: { id?: unknown } } | null)?.id ??
            (session as { id?: unknown; header?: { id?: unknown } } | null)?.header?.id ??
            '',
        );
        if (!sessionToPets.has(sid)) return;
        const frame = eventToFrame(event);
        if (!frame) return;
        pushFrame(sid, frame);
      }),
    'dsh-pet: task bridge session events',
  );

  // ---- 路由 ----
  const route = async (
    rest: string,
    method: string,
    body: string | undefined,
    params: URLSearchParams,
  ): Promise<TaskRouteResult> => {
    const petId = String(params.get('pet') ?? '');

    if (rest === 'task/workspaces') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' });
      const items: Array<{ workspaceId: string; title: string; path: string }> = [
        { workspaceId: '', title: '默认工作目录', path: '' },
      ];
      const ws = wsRegistry();
      if (ws) {
        try {
          for (const w of ws.list()) {
            const wid = String(w.id ?? '');
            if (!wid) continue;
            items.push({ workspaceId: wid, title: String(w.title ?? ''), path: String(w.path ?? '') });
          }
        } catch (e) {
          console.warn('dsh-pet: 工作区列表读取失败，已降级：' + (e instanceof Error ? e.message : String(e)));
        }
      }
      return json(200, { ok: true, items });
    }

    if (rest === 'task/current') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' });
      const binding = await resolveBinding(petId);
      let folder = '';
      const ws = wsRegistry();
      if (binding.workspaceId && ws) {
        try {
          const w = ws.get(binding.workspaceId);
          if (w && typeof w.path === 'string') folder = w.path;
        } catch {
          /* 工作区已删除：folder 留空（仅展示用） */
        }
      }
      return json(200, {
        ok: true,
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
        folder,
      });
    }

    if (rest === 'task/sessions') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' });
      const workspaceParam = String(params.get('workspace') ?? '');
      const agents = ctx.agents;
      const items: Array<{ sessionId: string; title: string; cwd: string; live: boolean }> = [];
      const seen = new Set<string>();
      const pushItem = (sid: string, title: string, cwd: string, live: boolean): void => {
        if (!sid || seen.has(sid)) return;
        seen.add(sid);
        items.push({ sessionId: sid, title, cwd, live });
      };
      // 主路径：sessionQuery 全量列表（含冷会话）；缺失/失败降级到 live + 工作区
      const sq = ctx.get('sessionQuery');
      if (sq && typeof sq.listSessions === 'function') {
        try {
          const records = await sq.listSessions();
          for (const r of records as Array<Record<string, unknown>>) {
            const header = (r.header ?? {}) as Record<string, unknown>;
            pushItem(
              String(header.id ?? ''),
              String(r.title ?? ''),
              String(header.cwd ?? ''),
              Boolean(agents.get(header.id)),
            );
          }
        } catch (e) {
          console.warn('dsh-pet: 会话列表读取失败，已降级：' + (e instanceof Error ? e.message : String(e)));
        }
      }
      for (const a of agents.list() as Array<Record<string, unknown>>) {
        const sid = String(a.id ?? '');
        const sess = (a.session ?? {}) as { header?: { cwd?: unknown } };
        const cwd = String(sess.header?.cwd ?? '');
        pushItem(sid, '', cwd, true);
      }
      const ws = wsRegistry();
      if (ws) {
        for (const w of ws.list()) {
          const wpath = String(w.path ?? '');
          const sids = Array.isArray(w.sessionIds) ? w.sessionIds : [];
          for (const sid of sids) pushItem(String(sid), '', wpath, Boolean(agents.get(sid)));
        }
      }
      // 按工作区过滤：指定工作区 → 其成员会话；''（默认工作目录）→ 不属于任何工作区的会话
      if (workspaceParam) {
        let ids: Set<string> | null = null;
        if (ws) {
          const target = ws.get(workspaceParam);
          if (target && Array.isArray(target.sessionIds)) {
            ids = new Set(target.sessionIds.map(String));
          }
        }
        return json(200, { ok: true, items: ids ? items.filter((i) => ids!.has(i.sessionId)) : [] });
      }
      const grouped = new Set<string>();
      if (ws) {
        for (const w of ws.list()) {
          const sids = Array.isArray(w.sessionIds) ? w.sessionIds : [];
          for (const sid of sids) grouped.add(String(sid));
        }
      }
      return json(200, { ok: true, items: items.filter((i) => !grouped.has(i.sessionId)) });
    }

    if (rest === 'task/open') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      let parsed: Record<string, unknown>;
      try {
        parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
      } catch {
        return json(400, { ok: false, message: 'invalid JSON body' });
      }
      const bindSessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
      let workspaceId = typeof parsed.workspaceId === 'string' ? parsed.workspaceId.trim() : '';
      // 兼容 v1：folder 传参 → 解析成工作区 id
      if (!workspaceId && typeof parsed.folder === 'string' && parsed.folder.trim()) {
        workspaceId = await resolveIdByPath(parsed.folder.trim());
      }
      if (bindSessionId) {
        let agent = ctx.agents.get(bindSessionId);
        if (!agent) {
          try {
            const handle = await ctx.agents.resume({ resumeSessionId: bindSessionId });
            handles.set(bindSessionId, handle);
            agent = handle.agent;
          } catch (e) {
            return json(404, {
              ok: false,
              message: '会话不存在或无法恢复：' + (e instanceof Error ? e.message : String(e)),
            });
          }
        }
        setActive(petId, bindSessionId);
        // 绑定既有会话：把该会话所属工作区一并粘性记住（保持"先工作区后对话"的导航一致）
        const cwd = String(agent?.session?.header?.cwd ?? '');
        const wid = await resolveIdByPath(cwd);
        await writeState(petId, { workspaceId: wid, sessionId: bindSessionId });
        return json(200, { ok: true, sessionId: bindSessionId, created: false });
      }
      // 新建（workspaceId 空 = 默认工作目录）
      try {
        const { sessionId } = await createSession(petId, workspaceId, true);
        return json(200, { ok: true, sessionId, created: true });
      } catch (e) {
        return json(500, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }

    if (rest === 'task/send') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      let parsed: Record<string, unknown>;
      try {
        parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
      } catch {
        return json(400, { ok: false, message: 'invalid JSON body' });
      }
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      if (!text) return json(400, { ok: false, message: '任务消息为空' });
      // 无长度上限（决策 4）：不设业务限制，直接交给 DSH
      try {
        const { agent, sessionId } = await ensureSession(petId);
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        });
        agent.followup(message);
        return json(200, { ok: true, sessionId });
      } catch (e) {
        return json(500, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }

    if (rest === 'task/cancel') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      const sessionId = activeBindings.get(petId);
      if (!sessionId) return json(400, { ok: false, message: '尚无绑定的会话' });
      const agent = ctx.agents.get(sessionId);
      if (!agent) return json(400, { ok: false, message: '会话未在运行' });
      agent.cancel({ kind: 'user' }, { keepInbox: true });
      return json(200, { ok: true });
    }

    if (rest === 'task/stream') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' });
      const sessionId = activeBindings.get(petId) ?? null;
      const q = sessionId ? queues.get(sessionId) : undefined;
      return json(
        200,
        { ok: true, sessionId, events: q ? q.frames.slice() : [] },
        { 'cache-control': 'no-cache, no-store' },
      );
    }

    return json(404, { error: 'unknown task route: ' + rest });
  };

  const dispose = async (): Promise<void> => {
    for (const [sessionId, handle] of handles) {
      try {
        await handle.dispose();
      } catch (e) {
        console.warn(`dsh-pet: 任务会话「${sessionId}」回收失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    handles.clear();
    activeBindings.clear();
    queues.clear();
  };

  return { route, dispose };
}

// 供测试与未来扩展引用的类型（构建产物导出无副作用）
export type { PetTaskState };
