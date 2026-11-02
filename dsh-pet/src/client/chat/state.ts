/**
 * 对话面板的状态装配（注入 react 的工厂）。
 *
 * 只做装配：形状见 ./types、动作见 ./actions、副作用见 ./effects、取数在 ./api。
 * 用一个 state 对象装全部字段——切换宠物要同时清空消息与勾选，拆成多个 useState 会露出中间态。
 * @module dsh-pet/src/client/chat/state
 */
import { speakText } from '../../shared/voice.ts';
import {
  fetchHistory,
  groupRounds,
  memoryBoundaryIndex,
  MEMORY_LINE_ATTR,
  playAction as requestPlayAction,
  roundsToRevealMemory,
} from './api.ts';
import { createHistoryActions, createSendActions, createShellActions } from './actions.ts';
import { createChatEffects } from './effects.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import type { ChatPanelState, PanelData } from './types.ts';

/** 首屏与每次「加载更早」放出的轮数。 */
const PAGE_ROUNDS = 10;

/** 初始状态：空列表 + 加载中。 */
const INITIAL: PanelData = {
  pets: [],
  petId: '',
  messages: [],
  draft: '',
  attachment: undefined,
  busy: false,
  loading: true,
  error: '',
  selected: [],
  selecting: false,
  orphans: [],
  pending: null,
  visibleRounds: PAGE_ROUNDS,
  previewUrl: undefined,
  roundsByEntry: {},
  personas: {},
  personaOpen: false,
  speaking: null,
  avatarVersion: 0,
};

/**
 * 造状态 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 无参 hook：每次渲染返回当前状态、派生值与动作。
 */
export function createPetChatState(rt: ChatPanelRuntime): () => ChatPanelState {
  const { useRef, useState } = rt;
  const useChatEffects = createChatEffects(rt);

  return function usePetChatState(): ChatPanelState {
    // 版本号在面板挂载时生成：每次打开面板都重新挂载，换过头像后重开一定拿到新图。
    const [data, setData] = useState<PanelData>({ ...INITIAL, avatarVersion: Date.now() });
    const listRef = useRef<HTMLDivElement | null>(null);
    const draftRef = useRef<HTMLTextAreaElement | null>(null);
    /** 已贴到底的那条消息（`ts`）：只有它变化时才自动滚到底。 */
    const newestTs = useRef(0);

    const patch = (next: Partial<PanelData>): void => setData((prev) => ({ ...prev, ...next }));
    const fail = (error: unknown): void => patch({ error: error instanceof Error ? error.message : String(error) });

    /** 重读某只宠物的历史；失败只落在 error 上，不静默清空已有消息。 */
    const reload = async (petId: string): Promise<void> => {
      if (petId === '') return;
      try {
        patch({ messages: await fetchHistory(petId) });
      } catch (error) {
        fail(error);
      }
    };

    useChatEffects({ data, patch, fail, reload, listRef, draftRef, newestTs });

    const ports = { read: () => data, patch, fail, reload };
    const history = createHistoryActions(ports);
    const shell = createShellActions({ ports, history, listRef, pageRounds: PAGE_ROUNDS });
    const pet = data.pets.find((one) => one.id === data.petId);
    const allRounds = groupRounds(data.messages);
    const rounds = allRounds.slice(-data.visibleRounds);
    const memoryRounds = data.roundsByEntry[pet?.assetRoot ?? ''];

    /** 分界线元素：只有它落在当前窗口里才存在。 */
    const findMemoryLine = (el: HTMLElement): Element | null => el.querySelector('[' + MEMORY_LINE_ATTR + ']');

    return {
      ...data,
      ...createSendActions(ports),
      ...history,
      ...shell,
      rounds,
      hasOlder: allRounds.length > rounds.length,
      petName: pet?.name || '宠',
      assetRoot: pet?.assetRoot ?? '',
      memoryRounds,
      hasMemoryLine: memoryBoundaryIndex(allRounds.length, memoryRounds) !== null,
      jumpToMemory: () => {
        const el = listRef.current;
        if (el === null) return;
        const line = findMemoryLine(el);
        if (line !== null) {
          line.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
        // 线还在「加载更早」没放出来的那段：先把窗口撑到能看见它，下一帧再滚
        if (memoryRounds === undefined || memoryBoundaryIndex(allRounds.length, memoryRounds) === null) return;
        patch({ visibleRounds: Math.max(data.visibleRounds, roundsToRevealMemory(memoryRounds)) });
        requestAnimationFrame(() => {
          findMemoryLine(el)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      },
      persona: data.personas[data.petId] ?? '',
      togglePersona: () => patch({ personaOpen: !data.personaOpen }),
      closePersona: () => patch({ personaOpen: false }),
      listRef,
      draftRef,
      pickPet: (petId: string) => {
        patch({
          petId,
          messages: [],
          selected: [],
          selecting: false,
          pending: null,
          visibleRounds: PAGE_ROUNDS,
          error: '',
        });
        void reload(petId);
      },
      toggleSelecting: () => patch({ selecting: !data.selecting, selected: [] }),
      toggleRound: (ts: number) =>
        patch({
          selected: data.selected.includes(ts) ? data.selected.filter((one) => one !== ts) : [...data.selected, ts],
        }),
      setDraft: (draft: string) => patch({ draft }),
      speakRound: (ts: number, text: string) => {
        // 阶段回调只写「仍是这一轮」的状态：被别的一条顶掉时，旧请求的 idle 不能清掉新状态
        speakText(text, (phase) => {
          setData((prev) => {
            if (phase === 'idle') return prev.speaking?.ts === ts ? { ...prev, speaking: null } : prev;
            return { ...prev, speaking: { ts, phase } };
          });
        });
      },
      playAction: (name: string) => {
        // 没选中宠物时不发请求：空 id 会被宿主按 bad-request 拒掉
        if (data.petId !== '') void requestPlayAction(data.petId, name);
      },
      clearAttachment: () => patch({ attachment: undefined }),
      showImage: (previewUrl: string) => patch({ previewUrl }),
      closeImage: () => patch({ previewUrl: undefined }),
    };
  };
}
