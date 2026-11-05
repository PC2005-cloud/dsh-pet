/**
 * 对话：/chat 读写对话记忆并调用模型生成回复。
 *
 * 不拼装提示词（归 ./chat）；图片入参的形状与 base64 校验归 ./image-attachment。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/chat
 */
import { readAllConfig, sliceMemoryRounds } from '../config.ts';
import { parseImageAttachment, type PetImageRef, type PetImageSink } from '../image-attachment.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 图片准入结论；`ref` 缺省表示这次请求没带图。 */
type ImageAdmission =
  { readonly ok: true; readonly ref?: PetImageRef } | { readonly ok: false; readonly res: RouteResult };

/** 对话领域：未命中返回 undefined，命中返回应答。 */
export async function handleChatRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { configPaths, log, memoryPath, memoryRounds, readMemory, requirePet } = deps;
  const { body, method, rest, url } = input;

  // 已删宠物的残留历史：配置里已经没有这只宠物，GET /chat 读不到它，也就清不掉。
  // GET 列出（只给条数与最后时间，不给正文），DELETE 一次性清空。
  if (rest === 'chat/memory') {
    if (method !== 'GET' && method !== 'DELETE') return methodNotAllowed();
    try {
      if (method === 'DELETE') return okResult(await deps.deleteOrphans());
      return okResult({ ok: true, orphans: await deps.orphanHistory() });
    } catch (e) {
      return failResult('generate-error', e instanceof Error ? e.message : String(e));
    }
  }

  // 对话：GET /chat 读最近记忆窗口（截尾 chatMemoryRounds 轮，一次读、不是轮询），
  // POST /chat 携带历史生成回复并写入记忆，DELETE /chat 删除记忆（按轮或整只）。
  // 记忆唯一读写方是 host（memory.json），浏览器与桌面天然共享同一份。
  if (rest === 'chat/powercontext' && deps.memoryStatus && deps.syncMemory) {
    if (method !== 'GET' && method !== 'POST') return methodNotAllowed();
    const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
    if (!who.ok) return who.res;
    try {
      if (method === 'POST') await deps.syncMemory(who.petId);
      return okResult(await deps.memoryStatus(who.petId));
    } catch {
      return failResult('generate-error', '记忆状态暂不可用');
    }
  }

  if (rest === 'chat') {
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return methodNotAllowed();
    try {
      // `?rounds=`：GET 专属的查看参数——只决定这次读多少轮（不写记忆，也不改变后续对话
      // 往上下文里带多少，所以 POST 不认它）。与 surface 同一处境：参数级校验放在读盘之前。
      const roundsRaw = method === 'GET' ? url.searchParams.get('rounds') : null;
      let roundsOverride: number | null = null;
      if (roundsRaw !== null && roundsRaw.trim() !== '') {
        const n = Number(roundsRaw);
        if (!Number.isInteger(n) || n < 0 || n > 200) {
          return failResult('bad-request', 'rounds 必须是 0–200 的整数（不传则用配置）');
        }
        roundsOverride = n;
      }
      // `?ts=`（可重复，DELETE 专属）：只删命中的轮。缺省 = 清空整只；同样在读盘之前校验。
      let tsList: number[] | undefined;
      if (method === 'DELETE') {
        const parsed = parseTsList(url.searchParams.getAll('ts'));
        if (parsed === null) return failResult('bad-request', 'ts 必须是非负整数（毫秒时间戳）');
        tsList = parsed.length > 0 ? parsed : undefined;
      }
      // pet 必填且必须真实存在：空串会让人设/配图按 main 条目取，记忆以那个（不存在的）id
      // 新建一个分桶，回复写进没人消费的 `pets[""].say`，还回 ok:true。
      // 惰性 + 记忆化：pet 空串时完全不读配置；GET 分支复用同一次读取。
      let cfgCache: Record<string, Record<string, unknown>> | undefined;
      const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(configPaths));
      // surface 只对 POST 校验：GET 是读记忆、DELETE 是存储管理，跟宠物显示在哪一端无关
      const who = requirePet(url.searchParams, cfg, { surface: method === 'POST' });
      if (!who.ok) return who.res;
      const petId = who.petId;
      if (method === 'GET') {
        const mem = await readMemory();
        const rawMessages = mem[who.entry]?.[petId]?.messages;
        // 记忆文件是合法 JSON 但 messages 不是数组时，slice() 会抛 slice is not a function：
        // 按空历史处理并记一行日志，不因为一条坏数据让整个历史接口报错。
        const list = Array.isArray(rawMessages) ? rawMessages.filter((m) => m && typeof m.content === 'string') : [];
        if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
          log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId}，按空历史处理：${memoryPath}`);
        }
        // 传了 ?rounds= 就用传的（含 0 = 空历史），没传才回落到配置
        const rounds = roundsOverride ?? memoryRounds(who.conf);
        // 与 chatWithPet 同一语义：rounds = 0 → 空历史（slice(-0) 会返回整个数组，见上）
        const messages = sliceMemoryRounds(list, rounds);
        return okResult({ ok: true, messages, rounds });
      }
      if (method === 'DELETE') return okResult(await deps.deleteHistory(petId, tsList));
      return await postChat(deps, petId, body);
    } catch (e) {
      // 配置已由 readAllConfig 保证正确（不再有 config-error 分支）；其余（IO/LLM）→ generate-error
      return failResult('generate-error', e instanceof Error ? e.message : String(e));
    }
  }

  return undefined;
}

/**
 * 解析 DELETE 的 `?ts=`（可重复）。
 *
 * @param raws - 查询串里所有 `ts` 的原值。
 * @returns 去重后的时间戳数组；任一值不是非负整数时返回 `null`（调用方转 bad-request）。
 */
function parseTsList(raws: readonly string[]): number[] | null {
  const out: number[] = [];
  for (const raw of raws) {
    const n = Number(raw);
    // 空串不能当 0：Number('') === 0 会静默删掉 ts=0 的轮
    if (raw.trim() === '' || !Number.isInteger(n) || n < 0) return null;
    out.push(n);
  }
  return [...new Set(out)];
}

/**
 * POST /chat：解析文本与可选图片，交给对话层生成回复。
 *
 * @param deps - 路由依赖。
 * @param petId - 已校验存在的宠物 id。
 * @param body - 请求体原文；不是合法 JSON 时回 400。
 * @returns 与加入图片前同形的应答：成功只带 `text`（配图时另有 `image`）。
 */
async function postChat(deps: PetRouteDeps, petId: string, body: string | undefined): Promise<RouteResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
  } catch {
    return invalidJson();
  }
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!text) return failResult('bad-request', '消息为空');
  if (text.length > 2000) return failResult('bad-request', '消息过长（限 2000 字）');
  // 图片缺省时直接返回空结论，下面的调用与加入图片前逐字一致（回归测试钉的就是这条）
  const admitted = await admitImage(deps, parsed.attachment);
  if (!admitted.ok) return admitted.res;
  return okResult(await deps.chatWithPet(petId, text, admitted.ref));
}

/**
 * 校验图片入参并交给宿主附件服务落盘。
 *
 * @param deps - 路由依赖（附件服务经 optionalService 软取，不进 inject）。
 * @param raw - 请求体里的 `attachment` 原始值；`undefined` 表示没传图。
 * @returns 已落盘的图片引用，或可直接返回的失败应答。
 */
async function admitImage(deps: PetRouteDeps, raw: unknown): Promise<ImageAdmission> {
  if (raw === undefined) return { ok: true };
  const parsed = parseImageAttachment(raw);
  if (!parsed.ok) return { ok: false, res: failResult('bad-request', parsed.message) };
  const sink = deps.optionalService('attachments') as PetImageSink | undefined;
  // 独立模式没有附件服务：图片能力直接不可用，不做假存储（契约见 API.md）
  if (typeof sink?.saveImages !== 'function') {
    return { ok: false, res: failResult('bad-request', '当前模式不支持图片（缺少附件服务）') };
  }
  const maxBytes = sink.imageLimits?.maxImageBytes;
  if (maxBytes !== undefined && parsed.bytes.length > maxBytes) {
    return { ok: false, res: failResult('bad-request', `图片过大（上限 ${maxBytes} 字节，请压缩或降低分辨率）`) };
  }
  try {
    const [ref] = await sink.saveImages([{ data: parsed.bytes, mediaType: parsed.mediaType }]);
    if (ref === undefined) return { ok: false, res: failResult('generate-error', '附件服务未返回图片引用') };
    return { ok: true, ref };
  } catch (e) {
    // 存储失败不是调用方的参数问题：回 generate-error，避免被当成 bad-request 而排错方向
    return { ok: false, res: failResult('generate-error', e instanceof Error ? e.message : String(e)) };
  }
}
