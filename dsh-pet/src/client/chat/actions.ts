/**
 * 对话面板的动作：记忆删除、发送、附图、确认分发与「加载更早」。
 *
 * 由 ./state 用当前状态装配；这里不持有状态，只把一次用户动作翻译成「调接口 → 补丁」。
 * 每个动作自己兜住异常并交给 fail 端口，调用方拿到的永远是同步的空返回。
 * @module dsh-pet/src/client/chat/actions
 */
import { encodeImageFile } from '../../shared/chat/encode.ts';
import {
  clearHistory,
  clearOrphans as clearOrphansApi,
  deleteRounds,
  fetchChatConfig,
  fetchOrphans,
  sendMessage,
  type DeleteResult,
} from './api.ts';
import type { ConfirmKind, PanelData } from './types.ts';

/** 动作需要的最小端口。 */
export interface ActionPorts {
  /** 读写当前状态快照（每次渲染重建，取到的就是最新值）。 */
  readonly read: () => PanelData;
  /** 合并一次状态补丁。 */
  readonly patch: (next: Partial<PanelData>) => void;
  /** 把任何异常归一成可展示文案。 */
  readonly fail: (error: unknown) => void;
  /** 重新拉取某只宠物的历史。 */
  readonly reload: (petId: string) => Promise<void>;
}

/** 记忆动作：按轮删除与清空整只。 */
export function createHistoryActions(ports: ActionPorts): {
  deleteSelected: () => void;
  clearAll: () => void;
} {
  /** 跑一次删除：失败只报错；成功后清勾选并以服务端为准重读。 */
  const apply = async (run: () => Promise<DeleteResult>): Promise<void> => {
    try {
      const result = await run();
      if (!result.ok) {
        ports.fail(result.message);
        return;
      }
      ports.patch({ selected: [], error: '' });
      await ports.reload(ports.read().petId);
    } catch (error) {
      ports.fail(error);
    }
  };

  return {
    deleteSelected: (): void => {
      const { petId, selected } = ports.read();
      if (petId === '' || selected.length === 0) return;
      void apply(() => deleteRounds(petId, selected));
    },
    clearAll: (): void => {
      const { petId } = ports.read();
      if (petId === '') return;
      void apply(() => clearHistory(petId));
    },
  };
}

/** 发送动作：附图压缩、发送、成功后重读。 */
export function createSendActions(ports: ActionPorts): {
  send: () => void;
  pickFile: (file: File) => void;
} {
  return {
    send: (): void => {
      const data = ports.read();
      const text = data.draft.trim();
      if (text === '' || data.busy || data.petId === '') return;
      ports.patch({ busy: true, error: '' });
      void (async () => {
        try {
          const attachment =
            data.attachment === undefined
              ? undefined
              : { mediaType: data.attachment.mediaType, data: data.attachment.base64 };
          const result = await sendMessage(data.petId, text, attachment);
          if (!result.ok) {
            ports.fail(result.message);
            return;
          }
          ports.patch({ draft: '', attachment: undefined });
          await ports.reload(data.petId);
        } catch (error) {
          ports.fail(error);
        } finally {
          ports.patch({ busy: false });
        }
      })();
    },
    pickFile: (file: File): void => {
      void (async () => {
        try {
          ports.patch({ attachment: await encodeImageFile(file), error: '' });
        } catch (error) {
          ports.fail(error);
        }
      })();
    },
  };
}

/** 外壳动作需要的额外句柄。 */
export interface ShellDeps {
  readonly ports: ActionPorts;
  /** 记忆删除动作（确认后要分发到它们）。 */
  readonly history: { deleteSelected: () => void; clearAll: () => void };
  /** 消息列表容器：展开更早的轮时要按高度差补偿滚动。 */
  readonly listRef: { current: HTMLDivElement | null };
  /** 每次「加载更早」放出的轮数。 */
  readonly pageRounds: number;
}

/** 外壳动作：孤儿清理、确认条分发、刷新与「加载更早」。 */
export function createShellActions(deps: ShellDeps): {
  clearOrphans: () => void;
  ask: (kind: ConfirmKind) => void;
  cancelAsk: () => void;
  confirmAsk: () => void;
  refresh: () => void;
  showOlder: () => void;
} {
  const { ports, history, listRef, pageRounds } = deps;

  /** 清掉已删宠物残留的历史。 */
  const clearOrphans = (): void => {
    void (async () => {
      try {
        const result = await clearOrphansApi();
        if (!result.ok) {
          ports.fail(result.message);
          return;
        }
        ports.patch({ orphans: [], error: '' });
      } catch (error) {
        ports.fail(error);
      }
    })();
  };

  /** 确认条点「确定」后按待办类型分发；先清 pending，避免重复触发。 */
  const confirmAsk = (): void => {
    const kind = ports.read().pending;
    ports.patch({ pending: null });
    if (kind === 'delete-selected') history.deleteSelected();
    else if (kind === 'clear-all') history.clearAll();
    else if (kind === 'clear-orphans') clearOrphans();
  };

  /** 多放一批更早的轮；按高度差补偿滚动位置，视线不跳。 */
  const showOlder = (): void => {
    const el = listRef.current;
    const before = el?.scrollHeight ?? 0;
    ports.patch({ visibleRounds: ports.read().visibleRounds + pageRounds });
    if (el === null) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - before;
    });
  };

  /** 重读配置、孤儿提示与当前宠物的历史：改完对话配置不必刷新整个页面。
   *  当前宠物可能已被删（配置是重新拉的）→ 回落到第一只，否则面板会停在一只不存在的宠物上。 */
  const refresh = (): void => {
    void (async () => {
      try {
        const [config, orphans] = await Promise.all([fetchChatConfig(), fetchOrphans().catch(() => [])]);
        const { petId } = ports.read();
        const nextPetId = config.pets.some((one) => one.id === petId) ? petId : (config.pets[0]?.id ?? '');
        ports.patch({
          pets: config.pets,
          roundsByEntry: config.roundsByEntry,
          personas: config.personaByPet,
          orphans,
          petId: nextPetId,
          // 刷新是「以磁盘为准重读」：头像也换一版，否则刚上传的图还挂在浏览器缓存里。
          avatarVersion: Date.now(),
          error: '',
        });
        await ports.reload(nextPetId);
      } catch (error) {
        ports.fail(error);
      }
    })();
  };

  return {
    clearOrphans,
    ask: (kind: ConfirmKind) => ports.patch({ pending: kind }),
    cancelAsk: () => ports.patch({ pending: null }),
    confirmAsk,
    refresh,
    showOlder,
  };
}
