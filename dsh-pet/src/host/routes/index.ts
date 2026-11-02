/**
 * 路由分发器：按固定顺序串行尝试各领域处理器，第一个给出应答的生效。
 *
 * 顺序即语义——素材路由是末端兜底（任何未知路径都会落到它并回 400），必须排在最后；
 * 其余领域按 `rest` 精确匹配，彼此不重叠，顺序只影响可读性。
 * 不解析 URL、不判断业务：`rest` 由调用方切好，处理器各自定义匹配条件。
 * @module dsh-pet/src/host/routes/index
 */
import type { RouteResult } from '../http.ts';
import { handleAssetsRoutes } from './assets.ts';
import { handleAttachmentRoutes } from './attachment.ts';
import { handleAvatarRoutes } from './avatar.ts';
import { handleBalanceRoutes } from './balance.ts';
import { handleChatRoutes } from './chat.ts';
import { handleConfigRoutes } from './config/index.ts';
import { handleDesktopRoutes } from './desktop.ts';
import { handleInteractionRoutes } from './interaction.ts';
import { handleMenuRoutes } from './menu.ts';
import { handleMotionRoutes } from './motion.ts';
import { handlePlaybackRoutes } from './playback.ts';
import { handleSessionRoutes } from './session.ts';
import { handleStateRoutes } from './state.ts';
import { handleSleepRoutes } from './sleep.ts';
import { handleTodoRoutes } from './todos.ts';
import { handleVoiceRoutes } from './voice.ts';
import type { PetRouteDeps, RouteHandler } from './types.ts';

/** 处理器顺序：越靠前越先匹配；素材兜底必须在末尾。 */
const HANDLERS: readonly RouteHandler[] = [
  handleConfigRoutes,
  handleDesktopRoutes,
  handleMenuRoutes,
  handleStateRoutes,
  handleSessionRoutes,
  handleBalanceRoutes,
  handleInteractionRoutes,
  handleMotionRoutes,
  handlePlaybackRoutes,
  handleSleepRoutes,
  handleChatRoutes,
  handleAttachmentRoutes,
  handleTodoRoutes,
  handleVoiceRoutes,
  handleAvatarRoutes,
  handleAssetsRoutes,
];

/**
 * 睡觉期间要拒绝的端点：只列「打扰类」。
 *
 * 刻意用白名单而不是黑名单——新增端点默认放行，不会因为忘了排除而把维护动作（改显示位置、
 * 重载配置）或拖拽链路（/position、/throw）一起锁死；反过来，漏列一个打扰端点只是它还能用，
 * 不会造成「宠物叫不醒」。
 */
function sleepGated(rest: string, method: string): boolean {
  if (rest === 'chat') return method === 'POST';
  if (rest === 'todos') return method === 'POST' || method === 'DELETE';
  return (
    rest === 'anim' ||
    rest === 'whisper' ||
    rest === 'balance' ||
    rest === 'broadcast' ||
    rest === 'bubble/clear' ||
    rest === 'menu/click' ||
    rest === 'voice'
  );
}

/**
 * 由依赖表构造路由分发器（`apply` 只调一次）。
 * @param deps - 路由层依赖（store、路径、动作函数）。
 * @returns 接收 URL/rest/方法/请求体/断开信号并给出应答的函数。
 */
export function createPetRouter(
  deps: PetRouteDeps,
): (url: URL, rest: string, method: string, body?: string, signal?: AbortSignal) => Promise<RouteResult> {
  return async (url, rest, method, body, signal) => {
    // 睡觉闸门放在分发之前：各领域处理器完全不用知道「睡觉」这回事，也不会漏掉某一处。
    // 只挡带 ?pet= 的请求（/todos 的清单是全局的，没有归属宠物就不拦）。
    if (sleepGated(rest, method)) {
      const petId = String(url.searchParams.get('pet') ?? '').trim();
      if (petId) {
        const blocked = deps.sleepBlocked(petId, url.searchParams);
        if (blocked) return blocked;
      }
    }
    for (const handle of HANDLERS) {
      const result = await handle(deps, { url, rest, method, body, signal });
      if (result !== undefined) return result;
    }
    // 素材处理器总会给出应答，这条只在新增领域处理器漏掉兜底时才会走到。
    return { kind: 'text', status: 404, body: 'dsh-pet: not found' };
  };
}
