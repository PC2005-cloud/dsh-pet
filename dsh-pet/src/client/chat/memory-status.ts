/** A small read-only memory indicator. Delivery, retrieval and local process state are distinct facts. */
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { ChatPanelRuntime } from './runtime.ts';

interface MemoryStatus {
  backend: string;
  pending: number;
  captured: number;
  recall: string;
  error?: string | null;
}
interface LocalStatus {
  memoryRunning?: boolean;
  memoryReady?: boolean;
  memoryEnabled?: boolean;
  configured?: boolean;
  busy?: boolean;
}

export function describeMemoryStatus(status: MemoryStatus): string {
  if (status.backend === 'native') return '当前宠物使用近期对话，长期记忆未开启。';
  const recall: Record<string, string> = {
    not_run: '尚未检索',
    ready: '最近召回到相关记忆',
    empty: '最近检索无相关记忆',
    unavailable: '最近检索不可用，聊天使用近期对话',
  };
  return (
    'PowerContext · 待同步 ' +
    status.pending +
    ' · 已同步 ' +
    status.captured +
    ' 轮 · ' +
    (recall[status.recall] ?? '最近检索状态未知') +
    (status.error ? ' · 记忆服务异常，请检查设置' : '')
  );
}

export function makeMemoryStatus(rt: ChatPanelRuntime): (props: { petId: string; revision: number }) => unknown {
  return function MemoryStatusPanel({ petId, revision }) {
    const [state, setState] = rt.useState({ petId: '', text: '正在读取记忆状态…', local: '' });
    const standalone = typeof document !== 'undefined' && !!document.getElementById('tab-setup');
    rt.useEffect(() => {
      if (!petId) return;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const refresh = async (): Promise<void> => {
        try {
          if (document.hidden || (standalone && document.getElementById('panel-chat')?.hidden)) return;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
          const response = await fetch(ROUTE_PATH + '/chat/powercontext?pet=' + encodeURIComponent(petId), {
            cache: 'no-store',
            signal,
          });
          if (!response.ok) throw new Error('unavailable');
          const memory = (await response.json()) as MemoryStatus & { ok?: boolean };
          if (memory.ok !== true || !['native', 'powercontext'].includes(memory.backend))
            throw new Error('unavailable');
          let local = '';
          if (standalone) {
            try {
              const result = await fetch('/standalone-ai/setup', { cache: 'no-store', signal });
              if (!result.ok) throw new Error('unavailable');
              const setup = (await result.json()) as LocalStatus;
              local = setup.memoryReady
                ? '本机记忆服务：已就绪'
                : setup.busy
                  ? '本机记忆服务：准备中'
                  : setup.memoryRunning
                    ? '本机记忆服务：运行中'
                    : setup.memoryEnabled
                      ? '本机记忆服务：暂不可用'
                      : setup.configured
                        ? '本机记忆服务：已暂停，数据保留'
                        : '本机记忆服务：未开启';
            } catch {
              local = '本机记忆服务：状态暂不可用';
            }
          }
          if (!controller.signal.aborted) setState({ petId, text: describeMemoryStatus(memory), local });
        } catch {
          if (!controller.signal.aborted) setState({ petId, text: '记忆状态暂不可用，正在重新连接。', local: '' });
        } finally {
          if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
        }
      };
      void refresh();
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [petId, revision, standalone]);
    if (!petId) return null;
    const current = state.petId === petId;
    return rt.h('div', {
      className: 'pet-chat-memory-status',
      children: [
        rt.h('p', {
          key: 'status',
          role: 'status',
          'aria-live': 'polite',
          children: current ? state.text : '正在读取这只宠物的记忆状态…',
        }),
        rt.h('small', {
          key: 'local',
          children:
            (current && state.local ? state.local + '。' : '') + '已同步表示对话已送达，不代表已整理成可召回的记忆。',
        }),
        standalone
          ? rt.h('button', {
              key: 'settings',
              type: 'button',
              onClick: () => document.getElementById('tab-setup')?.click(),
              children: '记忆设置',
            })
          : null,
      ],
    });
  };
}
