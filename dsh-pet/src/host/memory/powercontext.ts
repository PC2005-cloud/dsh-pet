/**
 * 内置长期记忆实现：把本机 PowerContext 服务接到 {@link ChatMemoryProvider} 契约上。
 *
 * 召回：探到 scope → 可选地把这句话连同最近两轮改写成检索查询 → 并行检索主题记忆与原子记忆 → 分层拼成证据块前插到 userText。
 * 每步失败只放弃这一步：探测与检索失败整轮不介入，改写失败退回原句，任何情况都不阻塞对话。
 * 两层都要查：主题记忆是服务端把多轮对话沉淀成的摘要（「姐姐会缝扣子」这类关系事实只在这里），
 * 原子记忆是逐条偏好与事实（「红烧肉放两颗冰糖」这类细节只在这里），少查一层就会答不出其中一类。
 * 配置只经装配层注入的 getter 读，本模块不碰文件、不持有进程级状态（scope 缓存闭在实例里）。
 * @module dsh-pet/src/host/memory/powercontext
 */
import {
  registerChatMemoryProvider,
  resolveChatMemoryProvider,
  type CaptureTurn,
  type ChatMemoryProvider,
  type ChatRequest,
  type ChatTurn,
  type RecallRequest,
} from '../chat-memory-provider.ts';
import { defaultLog } from '../log-file.ts';
import { POWERCONTEXT_MEMORY_ID } from '../../shared/memory.ts';

/** scope 标题：一只宠物实例一个 scope，记忆不跨宠物串。 */
const scopeTitleOf = (petId: string): string => 'dsh-pet:' + petId;
/** scope 摘要：服务端建 scope 时必填（1–2000 字）。 */
const scopeSummaryOf = (petId: string): string => '桌面宠物 ' + petId + ' 的对话记忆，由插件自动创建。';
/** scope 的幂等键：一只宠物一份，重复创建只会得到同一个；换掉它会多出一个删不掉的 scope。 */
const scopeKeyOf = (petId: string): string => 'dsh-pet:' + petId + ':v1';

/** 本机 CRUD 请求的超时（ms）：探 scope、建 scope、写证据都不跑模型，慢就是服务端出问题了。 */
const CRUD_TIMEOUT_MS = 1_000;
/** 检索请求的超时（ms）：hybrid 要现场调一次远程 embedding 模型，比 CRUD 慢一个量级。 */
const SEARCH_TIMEOUT_MS = 5_000;
/** 改写查询的预算（ms）：超时就用原句查，宁可查得糙也不拖住对话。 */
const REWRITE_BUDGET_MS = 800;
/** 召回总预算（ms）：改写预算 + 检索超时 + 余量，core 按这个值掐整轮。 */
const RECALL_TIMEOUT_MS = 6_000;
/** 改写查询时带上的历史轮数（1 轮 = 1 问 1 答）：只用来还原「它」「那家」这类指代。 */
const REWRITE_HISTORY_ROUNDS = 2;
/** 原子记忆检索条数：三条足够，再多只是把无关内容塞进上下文。 */
const RECALL_LIMIT = 3;
/** 主题记忆检索条数：一条主题就是整段对话的摘要，比原子记忆长得多，两条已能占满半个证据块。 */
const TOPIC_RECALL_LIMIT = 2;
/** 查询串的字节上限：服务端收 8192，留一半余量给中文。 */
const QUERY_BYTES = 4_096;
/** 证据块的总字节上限：超了从尾部丢句子，越靠后的命中分越低。 */
const EVIDENCE_BYTES = 3_072;
/** 证据块的表头：明确告诉模型这是检索到的旧信息，冲突时以用户当次输入为准。 */
const EVIDENCE_HEADER = '以下是从长期记忆里检索到的相关信息，供你参考；与用户这次说的话冲突时，以用户为准：';
/** 证据块的分层标题：先给概括再给细节，模型更容易把原子条目挂到对的关系上。 */
const TOPIC_SECTION = '[主题记忆]';
const ATOM_SECTION = '[原子记忆]';

/** 一次改写的输入。 */
export interface RewriteInput {
  /** 用户这一句话。 */
  readonly userText: string;
  /** 最近 {@link REWRITE_HISTORY_ROUNDS} 轮的原文（按时间正序）；没有历史时为空。 */
  readonly history: readonly ChatTurn[];
}

/** 装配层注入的依赖：配置读取与可选的查询改写。 */
export interface PowerContextDeps {
  /** 服务根地址；空串 = 没配，整轮不介入。 */
  readonly endpoint: () => string;
  /** Bearer 令牌；空串 = 不带鉴权头（服务端没开认证时）。只驻内存，禁止进日志。 */
  readonly token: () => string;
  /** 把这句话连同最近两轮改写成检索查询；缺省或返回 undefined 时用原句。 */
  readonly rewrite?: (input: RewriteInput) => Promise<string | undefined>;
}

/** 检索命中里本模块真正用到的两个字段。 */
interface MemoryHit {
  readonly kind: string;
  readonly text: string;
}

/** 主题记忆命中：服务端只给标题与摘要，本模块用这两段拼一行证据。 */
interface TopicHit {
  readonly title: string;
  readonly summary: string;
}

/** 一次召回的两层结果；`undefined` 表示该层失败，空数组表示查到了但没有命中。 */
interface RecallLayers {
  readonly topics: readonly TopicHit[] | undefined;
  readonly atoms: readonly MemoryHit[] | undefined;
}

/**
 * 造 PowerContext 记忆实现。
 *
 * @param deps - 地址与令牌的读取口，外加可选的查询改写。
 * @returns 注册表认得的内置实现。
 */
export function createPowerContextMemory(deps: PowerContextDeps): ChatMemoryProvider {
  /** 已探测到的 scope：一只宠物一份，键里带上地址——换了服务器不能继续往旧 scope 写。 */
  const scopes = new Map<string, string>();

  /**
   * 取某只宠物的 scope id：先按标题查，没有才创建。
   *
   * 不用「幂等 POST 兜底创建」：那条路对已存在的 scope 会返回 409，语义不明确；
   * 查询 + 创建虽然多一次往返，但「检测」与「创建」各自的结果都确定。
   */
  const ensureScope = async (petId: string): Promise<string | undefined> => {
    const endpoint = deps.endpoint().trim();
    if (endpoint === '') return undefined;
    const cacheKey = endpoint + '\u0000' + petId;
    const cached = scopes.get(cacheKey);
    if (cached !== undefined) return cached;
    const title = scopeTitleOf(petId);
    const page = await callApi(deps, {
      method: 'GET',
      path: '/v1/scopes?query=' + encodeURIComponent(title) + '&query_field=title&limit=50',
      timeoutMs: CRUD_TIMEOUT_MS,
    });
    const items = (page as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items)) return undefined;
    // 服务端的 query 是模糊匹配，可能连 "dsh-pet:pet-20" 一起返回，所以按标题精确比对
    const found = items.find((item) => (item as { title?: unknown }).title === title);
    const known = (found as { scope_id?: unknown } | undefined)?.scope_id;
    if (typeof known === 'string' && known !== '') {
      scopes.set(cacheKey, known);
      return known;
    }
    const created = await callApi(deps, {
      method: 'POST',
      path: '/v1/scopes',
      body: {
        title,
        summary: scopeSummaryOf(petId),
        idempotency_key: scopeKeyOf(petId),
      },
      timeoutMs: CRUD_TIMEOUT_MS,
    });
    const id = (created as { scope_id?: unknown } | undefined)?.scope_id;
    if (typeof id !== 'string' || id === '') return undefined;
    scopes.set(cacheKey, id);
    return id;
  };

  /** 查询串：改写优先（带最近两轮还原指代），没有就用原话；按字节截断，服务端限 8192。 */
  const buildQuery = async (req: RecallRequest): Promise<string> => {
    const rewritten = await rewriteWithin(deps.rewrite, {
      userText: req.userText,
      history: req.prepared.history.slice(-REWRITE_HISTORY_ROUNDS * 2),
    });
    return truncateBytes(rewritten ?? req.userText, QUERY_BYTES);
  };

  const recall = async (req: RecallRequest): Promise<ChatRequest | undefined> => {
    const scopeId = await ensureScope(req.petId);
    if (scopeId === undefined) return undefined;
    const query = await buildQuery(req);
    if (query === '') return undefined;
    // 两层并行：总耗时取较慢的那一路，不让一层慢拖成两层的和。
    const [topics, atoms] = await Promise.all([searchTopics(deps, scopeId, query), search(deps, scopeId, query)]);
    const evidence = formatEvidence({ topics, atoms });
    if (evidence === '') {
      logEmptyRecall(req.petId, topics, atoms);
      return undefined;
    }
    return { ...req.prepared, userText: evidence + '\n\n' + req.prepared.userText };
  };

  const capture = async (turn: CaptureTurn): Promise<void> => {
    const scopeId = await ensureScope(turn.petId);
    if (scopeId === undefined) return;
    // 写的是 CaptureContentSourceRequest（202 受理，抽取在服务端后台跑）。
    // source_id 只带轮次时间戳：唯一性按 (scope, source_id) 算，而 scope 已是「一只宠物一个」，重试仍得同一个 id。
    // 注意不能走 /v1/scopes/{id}/sources——那条路收的是 CreateSourceRequest，不认 scope_id 与 source_id。
    await callApi(deps, {
      method: 'POST',
      path: '/v1/sources/content',
      body: {
        scope_id: scopeId,
        source_id: 'dsh-pet:' + turn.ts,
        content: '用户：' + turn.userText + '\n宠物：' + turn.replyText,
      },
      timeoutMs: CRUD_TIMEOUT_MS,
    });
  };

  return {
    id: POWERCONTEXT_MEMORY_ID,
    name: 'PowerContext',
    timeoutMs: RECALL_TIMEOUT_MS,
    recall,
    capture,
  };
}

/**
 * 确保内置 PowerContext 实现在注册表里；重复调用无副作用（多次装配、热重载都会经过这里）。
 *
 * 已经注册过时直接返回，不去覆盖同 id 的另一份。
 *
 * @param deps - 地址与令牌的读取口，外加可选的查询改写。
 */
export function ensurePowerContextMemory(deps: PowerContextDeps): void {
  if (resolveChatMemoryProvider(POWERCONTEXT_MEMORY_ID).id === POWERCONTEXT_MEMORY_ID) return;
  registerChatMemoryProvider(createPowerContextMemory(deps));
}

/** 一次出站请求。 */
interface ApiCall {
  readonly method: 'GET' | 'POST';
  /** 以 `/` 开头的服务端路径（含查询串）。 */
  readonly path: string;
  /** 请求体；缺省表示不带体。 */
  readonly body?: unknown;
  /** 单次超时（ms）：检索要跑向量化，跟 CRUD 不是一个量级，由调用方各自给。 */
  readonly timeoutMs: number;
}

/**
 * 发一次 JSON 请求。
 *
 * 超时、断网、非 2xx、响应不是 JSON 一律回 `undefined`——调用方只按「这步没成」处理。
 * 错误只记端点与状态码：地址里可能带内网主机名，令牌更是不该出现在日志里。
 *
 * @param deps - 取地址与令牌。
 * @param call - 方法、路径、请求体与本次超时。
 * @returns 解析后的 JSON 值，未校验形状（调用方逐字段判）。
 */
async function callApi(deps: PowerContextDeps, call: ApiCall): Promise<unknown> {
  const base = deps.endpoint().trim().replace(/\/+$/, '');
  if (base === '') return undefined;
  const token = deps.token().trim();
  try {
    const response = await fetch(base + call.path, {
      method: call.method,
      headers: {
        'content-type': 'application/json',
        ...(token === '' ? {} : { authorization: 'Bearer ' + token }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: AbortSignal.timeout(call.timeoutMs),
    });
    if (!response.ok) {
      defaultLog(
        'warn',
        'dsh-pet: PowerContext ' + call.method + ' ' + call.path.split('?')[0] + ' 返回 HTTP ' + response.status,
      );
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  }
}

/** 检索原子记忆（逐条偏好与事实）；响应形状不对按失败处理。 */
async function search(deps: PowerContextDeps, scopeId: string, query: string): Promise<MemoryHit[] | undefined> {
  const result = await callApi(deps, {
    method: 'POST',
    path: '/v1/atomic-memory/search',
    body: {
      scope_id: scopeId,
      query,
      mode: 'hybrid',
      limit: RECALL_LIMIT,
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  const hits = (result as { hits?: unknown } | undefined)?.hits;
  if (!Array.isArray(hits)) return undefined;
  return hits.map(toHit).filter((hit): hit is MemoryHit => hit !== undefined);
}

/** 检索主题记忆（多轮对话沉淀成的摘要）；响应形状不对同样按失败处理。 */
async function searchTopics(deps: PowerContextDeps, scopeId: string, query: string): Promise<TopicHit[] | undefined> {
  const result = await callApi(deps, {
    method: 'POST',
    path: '/v1/topic-memory/search',
    body: {
      scope_id: scopeId,
      query,
      limit: TOPIC_RECALL_LIMIT,
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  const hits = (result as { hits?: unknown } | undefined)?.hits;
  if (!Array.isArray(hits)) return undefined;
  return hits.map(toTopicHit).filter((hit): hit is TopicHit => hit !== undefined);
}

/** 一条命中 → `{ kind, text }`；缺字段或空文本当没有这一条。 */
function toHit(value: unknown): MemoryHit | undefined {
  const memory = (value as { memory?: unknown } | undefined)?.memory;
  if (!memory || typeof memory !== 'object') return undefined;
  const record = memory as { kind?: unknown; text?: unknown };
  if (typeof record.text !== 'string' || record.text === '') return undefined;
  return { kind: typeof record.kind === 'string' ? record.kind : '', text: record.text };
}

/** 一条主题命中 → `{ title, summary }`；只有标题没有正文的条目对模型没有信息量，丢弃。 */
function toTopicHit(value: unknown): TopicHit | undefined {
  const hit = value as { title?: unknown; summary?: unknown; snippet?: unknown } | undefined;
  const summary = textField(hit?.summary) || textField(hit?.snippet);
  if (summary === '') return undefined;
  return { title: textField(hit?.title), summary };
}

/** 取一个字符串字段并去首尾空白；非字符串按空串处理。 */
function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 一条主题命中的展示行：`- 标题：摘要`；标题为空时只给摘要。 */
function topicLine(hit: TopicHit): string {
  return '- ' + (hit.title === '' ? '' : hit.title + '：') + hit.summary;
}

/** 证据块的一段：段标题与已按分数降序排好的行。 */
type EvidenceSection = readonly [title: string, lines: readonly string[]];

/**
 * 把两层命中分层拼成证据块。
 *
 * 主题段在原子段之前：主题概括的是一整段关系，原子条目是细节，先给概括模型才挂得对地方。
 *
 * @param layers - 两层的命中；某一层为 `undefined` 时按空处理，只剩一层也照常输出。
 * @returns 以表头开头的证据块；空串表示没有任何可用命中。
 */
function formatEvidence(layers: RecallLayers): string {
  const lines = fitSections([
    [TOPIC_SECTION, (layers.topics ?? []).map(topicLine)],
    [ATOM_SECTION, (layers.atoms ?? []).map((hit) => evidenceLine(hit.kind, hit.text))],
  ]);
  return lines.length === 0 ? '' : EVIDENCE_HEADER + '\n' + lines.join('\n');
}

/**
 * 在字节预算内摆放各段，段标题与每一行都计入。
 *
 * 超长从尾部丢整条：越靠后的命中分越低，先丢它们的损失最小。
 * 首条就放不下时截断塞进去——单条啰嗦记忆不该让整轮召回作废。
 *
 * @param sections - 按展示顺序排列的段。
 * @returns 放得下的行；空数组表示连第一个段标题都放不下。
 */
function fitSections(sections: readonly EvidenceSection[]): string[] {
  const out: string[] = [];
  let used = Buffer.byteLength(EVIDENCE_HEADER, 'utf8');
  let hasContent = false;
  for (const [title, lines] of sections) {
    if (lines.length === 0) continue;
    const titleCost = Buffer.byteLength('\n' + title, 'utf8');
    if (used + titleCost > EVIDENCE_BYTES) break;
    out.push(title);
    used += titleCost;
    for (const line of lines) {
      const size = Buffer.byteLength('\n' + line, 'utf8');
      if (used + size <= EVIDENCE_BYTES) {
        out.push(line);
        used += size;
        hasContent = true;
        continue;
      }
      if (hasContent) return out;
      const room = EVIDENCE_BYTES - used - 1;
      const truncated = room > 0 ? truncateBytes(line, room) : '';
      if (truncated === '') return out;
      out.push(truncated);
      return out;
    }
  }
  return out;
}

/** 一条原子记忆命中的展示行：`- [kind] 正文`。 */
function evidenceLine(kind: string, text: string): string {
  return '- ' + (kind === '' ? '' : '[' + kind + '] ') + text;
}

/**
 * 记一行「这轮召回是空的」。
 *
 * 召回为空有三条路：scope 探不到、检索失败、命中 0 条。过去三条都是静默返回，
 * 出问题时只能手工去问服务端；分层的状态写进同一行，看日志就能分清是哪条路。
 *
 * @param petId - 目标宠物；日志按它定位。
 * @param topics - 主题记忆那一路的结果。
 * @param atoms - 原子记忆那一路的结果。
 */
function logEmptyRecall(
  petId: string,
  topics: readonly TopicHit[] | undefined,
  atoms: readonly MemoryHit[] | undefined,
): void {
  const describe = (list: readonly unknown[] | undefined): string =>
    list === undefined ? '失败' : list.length + ' 条';
  const line =
    'dsh-pet: PowerContext 记忆召回无命中 pet=' +
    petId +
    '（主题 ' +
    describe(topics) +
    '，原子 ' +
    describe(atoms) +
    '）';
  // 两层都失败多半是服务没起、地址或令牌不对，与「查到了但没命中」不是一类问题
  if (topics === undefined && atoms === undefined) defaultLog('warn', line);
  else defaultLog('info', line);
}

/** 在预算内改写查询；超时、抛错、返回空串都当没改写。 */
async function rewriteWithin(rewrite: PowerContextDeps['rewrite'], input: RewriteInput): Promise<string | undefined> {
  if (rewrite === undefined) return undefined;
  const budget = AbortSignal.timeout(REWRITE_BUDGET_MS);
  const deadline = new Promise<undefined>((resolve) => {
    budget.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const attempt = Promise.resolve()
    .then(() => rewrite(input))
    .catch(() => undefined);
  const text = await Promise.race([attempt, deadline]);
  if (typeof text !== 'string') return undefined;
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized === '' ? undefined : normalized;
}

/** 按 UTF-8 字节截断；不会把多字节字符切半个。 */
function truncateBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > limit) break;
    out += char;
    used += size;
  }
  return out;
}
