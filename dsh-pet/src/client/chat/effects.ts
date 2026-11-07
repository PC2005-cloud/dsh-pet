/**
 * 面板的副作用：首次装配、贴底滚动、输入框自动长高、跟着桌宠的说话刷新。
 *
 * 四件事都绑 DOM / 外部数据源与生命周期，与状态归约分开放；数据由 ./state 传入，这里不持状态。
 * @module dsh-pet/src/client/chat/effects
 */
import { getStateSnapshot, subscribeStateSnapshot } from '../state-service.ts';
import { fetchChatConfig, fetchOrphans } from './api.ts';
import { INPUT_MAX_HEIGHT } from './metrics.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import type { PanelData } from './types.ts';

/** 副作用需要的状态与句柄。 */
export interface ChatEffectsInput {
  readonly data: PanelData;
  readonly patch: (next: Partial<PanelData>) => void;
  readonly fail: (error: unknown) => void;
  readonly reload: (petId: string) => Promise<void>;
  readonly listRef: { current: HTMLDivElement | null };
  readonly draftRef: { current: HTMLTextAreaElement | null };
  /** 已贴到底的那条消息 `ts`：只有它变化时才自动滚底。 */
  readonly newestTs: { current: number };
}

/**
 * 造副作用 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收状态与句柄的 hook；没有返回值。
 */
export function createChatEffects(rt: ChatPanelRuntime): (input: ChatEffectsInput) => void {
  const { useEffect, useRef } = rt;

  return function useChatEffects(input: ChatEffectsInput): void {
    const { data, fail, listRef, draftRef, newestTs, patch, reload } = input;
    const current = useRef(data);
    current.current = data;
    const preferred = useRef<string | undefined>(undefined);
    const deferredRefresh = useRef(false);
    const refreshConfig = useRef<(() => void) | null>(null);

    // 首次装配：宠物列表 + 孤儿提示 + 第一只宠物的历史。只跑一次，所以依赖留空。
    useEffect(() => {
      void (async () => {
        try {
          // 孤儿历史与配置一起拉：配置里还带着每个条目的记忆轮数（记忆边界线要用）
          const [config, orphans] = await Promise.all([fetchChatConfig(), fetchOrphans().catch(() => [])]);
          const first = config.preferredPetId ?? config.pets[0]?.id ?? '';
          preferred.current = config.preferredPetId;
          patch({
            pets: config.pets,
            roundsByEntry: config.roundsByEntry,
            personas: config.personaByPet,
            petId: first,
            orphans,
          });
          await reload(first);
        } catch (error) {
          fail(error);
        } finally {
          patch({ loading: false });
        }
      })();
      // reload/fail/patch 每次渲染都会重建，放进依赖会让这个效应反复重跑。
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时执行一次，见上
    }, []);

    // An appearance switch publishes the normal config signal used by desktop/browser renderers.
    useEffect(() => {
      let disposed = false;
      let revision = 0;
      let last = getStateSnapshot()?.sections.config?.counter ?? 0;
      const refresh = (): void => {
        if (current.current.busy) {
          deferredRefresh.current = true;
          return;
        }
        const request = ++revision;
        void fetchChatConfig()
          .then((config) => {
            if (disposed || request !== revision) return;
            if (current.current.busy) {
              deferredRefresh.current = true;
              return;
            }
            const changed = preferred.current !== config.preferredPetId;
            preferred.current = config.preferredPetId;
            const petId =
              changed || !config.pets.some((pet) => pet.id === current.current.petId)
                ? (config.preferredPetId ?? config.pets[0]?.id ?? '')
                : current.current.petId;
            patch({
              pets: config.pets,
              roundsByEntry: config.roundsByEntry,
              personas: config.personaByPet,
              petId,
              ...(petId !== current.current.petId ? { selected: [], pending: null } : {}),
              error: '',
            });
            return reload(petId);
          })
          .catch((error) => {
            if (!disposed) fail(error);
          });
      };
      refreshConfig.current = refresh;
      const unsubscribe = subscribeStateSnapshot((snapshot) => {
        const counter = snapshot.sections.config?.counter ?? 0;
        if (counter === last) return;
        last = counter;
        refresh();
      });
      window.addEventListener('dsh-pet-appearance-changed', refresh);
      return () => {
        disposed = true;
        unsubscribe();
        refreshConfig.current = null;
        window.removeEventListener('dsh-pet-appearance-changed', refresh);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once with cleanup; config changes supply fresh data
    }, []);

    useEffect(() => {
      if (!data.busy && deferredRefresh.current) {
        deferredRefresh.current = false;
        refreshConfig.current?.();
      }
    }, [data.busy]);

    // 只有「有更新的一条」时才贴底：向前加载更早的轮不该把视线拽走
    useEffect(() => {
      const el = listRef.current;
      if (el === null) return;
      const newest = data.messages[data.messages.length - 1]?.ts ?? 0;
      if (newest === newestTs.current) return;
      newestTs.current = newest;
      el.scrollTop = el.scrollHeight;
      // 只看消息列表本身，其余句柄是稳定引用
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖见上一行
    }, [data.messages]);

    // 输入框随内容长高：先归零再加回 scrollHeight，否则删字时高度不会缩回去
    useEffect(() => {
      const el = draftRef.current;
      if (el === null) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, INPUT_MAX_HEIGHT) + 'px';
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 句柄是稳定引用
    }, [data.draft]);

    // 桌宠在自己那边说完话也会写 pets.<id>.say：跟着这一拍刷新历史，
    // 否则面板开着时看不到新对话。只认 counter 变化，避免每拍都重读文件。
    useEffect(() => {
      const petId = data.petId;
      if (petId === '') return;
      let last = getStateSnapshot()?.pets[petId]?.say?.counter ?? 0;
      return subscribeStateSnapshot((snapshot) => {
        const counter = snapshot.pets[petId]?.say?.counter ?? 0;
        if (counter === last) return;
        last = counter;
        void reload(petId);
      });
      // 只在切换宠物时重订阅；reload 每次渲染重建，不该进依赖
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖见上一行
    }, [data.petId]);
  };
}
