/**
 * 会话交互：占用锁 /lock、碎碎念 /whisper、第三方投喂 /broadcast、气泡清除 /bubble/clear。
 *
 * 不决定文案与语气（归 shared/whisper）。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/interaction
 */
import { readAllConfig } from '../config.ts';
import { normalizeSurface, voiceTargetOfSurface } from '../surface.ts';
import {
  decideBroadcast,
  decideBubbleClear,
  normalizeBroadcastAnim,
  normalizeBroadcastDuration,
  normalizeBroadcastText,
} from '../broadcast.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 会话交互领域：未命中返回 undefined，命中返回应答。 */
export async function handleInteractionRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { configPaths, lock, lockBlocked, memeDirsFor, publishWhisper, requirePet, state, surfaceBlocked } = deps;
  const { body, method, rest, url } = input;

  // 占用锁：POST /lock?pet= 取锁 / 续期二合一（lockId 给了 = 续期，续期即心跳，丢了回 lock-lost），
  // POST /lock/release?pet= 释放。一把锁、全有全无：占用期间除持锁者外全静音。
  // 与 /playback 的分工：那个是「这次点播播完没有」的回执，这个是「这段时间归谁控制」的租约。
  // 锁自己占一个叶子（pets.<id>.lock）：宿主停不掉正在播的视频，「完全静止」最终由渲染端执行。
  // 失败一律 HTTP 200 + 失败实体；方法错与坏 JSON 由协议构造器给真实状态码。
  if (rest === 'lock' || rest === 'lock/release') {
    const isRelease = rest === 'lock/release';
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    try {
      // pet 必填且必须真实存在（与 /anim、/broadcast 同一口径，见 requirePet）
      // surface 只对取锁这一支校验：`/lock/release` 必须永远能成功（否则宠物中途被隐藏就撤不掉锁）
      const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: !isRelease });
      if (!who.ok) return who.res;
      const petId = who.petId;
      if (isRelease) {
        const d = lock.release({ petId, lockId: o.lockId, force: o.force });
        if (!d.ok) {
          return failResult(d.reason, d.message, d.reason === 'lock-lost' ? { cause: d.cause } : undefined);
        }
        // 幂等：当前没有锁同样回 ok（「让锁消失」这个意图在空状态下已经成立）
        return okResult({ ok: true });
      }
      const d = lock.acquire({ petId, lockId: o.lockId, ttl: o.ttl });
      if (!d.ok) {
        const extra: Record<string, unknown> = {};
        if (d.reason === 'locked') extra.expiresAt = d.expiresAt; // 让对方知道何时能重试
        if (d.reason === 'lock-lost') extra.cause = d.cause;
        return failResult(d.reason, d.message, extra);
      }
      return okResult({ ok: true, lockId: d.lockId, petId: d.petId, expiresAt: d.expiresAt });
    } catch (e) {
      // 配置读取失败等（安装损坏）→ 显式失败，不静默（与其他动作端点同一口径）
      return failResult('generate-error', e instanceof Error ? e.message : String(e));
    }
  }

  // 碎碎念：POST /whisper?pet= 立即让桌宠新说一句，返回 {ok,text,image?}。文本照旧写进 S 的
  // pets.<id>.say（与命令气泡、对话回复同一个叶子），同时随响应带回。
  // 手动语义不受 whisperEnabled 门控：那个字段只关自动周期。
  // ?image= 指定这一次用哪张图（右键「配图」菜单点了具体某张）：不在池内 → unknown-image，
  // 由 publishWhisper 判定，这里只搬运。
  if (rest === 'whisper') {
    if (method !== 'POST') return methodNotAllowed();
    try {
      // pet 必填且必须真实存在：空串会让人设/配图按 main 条目取、生成结果写进没人消费的
      // `pets[""].say`，还回 ok:true（钱花了、话丢了、调用方以为成功）。
      const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: true });
      if (!who.ok) return who.res;
      // 谁点的谁念：请求面在 requirePet 里已被 displayCovers 校验过，具体到一端就用它；
      // both / any 不足以指定一端，留空交给生成函数按 display 推导。
      const want = normalizeSurface(url.searchParams.get('surface'));
      const r = await publishWhisper(
        who.petId,
        url.searchParams.get('image') ?? undefined,
        want === null ? undefined : voiceTargetOfSurface(want),
      );
      if (r.ok) return okResult({ ok: true, text: r.text, ...(r.image ? { image: r.image } : {}) });
      // 真实 reason 原样透出（独立模式是 `provider-missing`，见 ./whisper 的联合体）——
      // 不再把一切失败糊成 generate-error，调用方据此能分清「没配模型」与「生成炸了」。
      return failResult(r.reason, r.message ?? '生成失败');
    } catch (e) {
      return failResult('generate-error', e instanceof Error ? e.message : String(e));
    }
  }

  // 第三方投喂：POST /broadcast?pet= 把一段外部给定的文本写进气泡——不生成，调用方自己给文本，
  // 宿主侧其他插件用它把自己的话说出来（issue #76）。写入 S 的 pets.<id>.say，只回 {ok}。
  // text 必填且 trim 后非空（不设长度限制、不限频：内容与频率由调用方负责）；pet 必填且须存在。
  // image / url 二选一：image 只认该条目表情包池内的名称，url 是第三方自带的完整地址、不查池，
  // scheme 由宿主卡在 http/https；宿主不做代理（跨域由浏览器强制）。
  // duration 缺省 10s、0 = 不显示、负数/非有限数拒绝；anim 只有严格 false 才关闭。
  if (rest === 'broadcast') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    // 空文本不需要读配置就能判定：先短路，别为一个必然失败的请求去碰磁盘
    if (!normalizeBroadcastText(o.text)) return failResult('bad-request', 'text 为空');
    // duration 同理：判定不需要配置，先短路（anim 没有非法值，宽松口径下永远有结论）
    const duration = normalizeBroadcastDuration(o.duration);
    if (duration === null) return failResult('bad-request', 'duration 必须是 ≥0 的有限数字（毫秒）');
    const anim = normalizeBroadcastAnim(o.anim);
    try {
      const cfg = readAllConfig(configPaths);
      const d = decideBroadcast({
        cfg,
        requested: String(url.searchParams.get('pet') ?? ''),
        text: o.text,
        image: o.image,
        url: o.url,
        duration,
        anim,
        memeDirs: memeDirsFor,
      });
      if (!d.ok) return failResult(d.reason, d.message);
      // 显示端对齐：不满足 → pet-not-displayed（+ 实际 display），早于锁门禁
      const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
      if (noSurface) return noSurface;
      // 占用门禁：有锁时只有持锁者能投喂（无锁恒放行，见 lockBlocked）
      const blocked = lockBlocked(d.petId, url.searchParams);
      if (blocked) return blocked;
      // duration / anim 写解析后的生效值（缺省也已填成显式值）：/state 里因此能看到
      // 实际生效的时长与联动开关，调用方不用自己猜缺省是多少。
      // 配图两种形态二选一（判定层保证）：url 形态写 url，名称形态写池内规范名，都没有则纯文本。
      const pic = d.url !== undefined ? { url: d.url } : d.image !== undefined ? { image: d.image } : {};
      // 与手动碎碎念同一口径：调用方用 ?surface= 明说了「我希望这句显示在哪一端」，就由那一端念；
      // both / any 不足以指定一端，留空不写（消费端据此不念）。
      const want = normalizeSurface(url.searchParams.get('surface'));
      const voiceTo = want === null ? undefined : voiceTargetOfSurface(want);
      state.writePet(d.petId, 'say', {
        text: d.text,
        ...pic,
        duration: d.duration,
        anim: d.anim,
        ...(voiceTo ? { voiceTo } : {}),
      });
      return okResult({ ok: true });
    } catch (e) {
      // 配置读取失败等（安装损坏）→ 显式失败，不静默
      return failResult('generate-error', e instanceof Error ? e.message : String(e));
    }
  }

  // 清空气泡：POST /bubble/clear?pet= 收起该宠物当前正显示的说话气泡，与 /broadcast 共用
  // pets.<id>.say 叶子。清空靠 `{ clear: true }` 标记——空文本表达不了这个动作（消费端会把
  // 空文本判成非法、整拍跳过）。只收说话气泡，余额/工作状态气泡与 anim/position/throw 都不动。
  // 幂等：没有气泡也回 {ok:true}。
  if (rest === 'bubble/clear') {
    if (method !== 'POST') return methodNotAllowed();
    try {
      const cfg = readAllConfig(configPaths);
      const d = decideBubbleClear({
        cfg,
        requested: String(url.searchParams.get('pet') ?? ''),
      });
      if (!d.ok) return failResult(d.reason, d.message);
      const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
      if (noSurface) return noSurface;
      const blocked = lockBlocked(d.petId, url.searchParams);
      if (blocked) return blocked;
      state.writePet(d.petId, 'say', { clear: true });
      return okResult({ ok: true });
    } catch (e) {
      return failResult('generate-error', e instanceof Error ? e.message : String(e));
    }
  }

  return undefined;
}
