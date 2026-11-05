/** Per-pet status from the saved configuration; refreshes only on selection or explicit action. */
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { SettingsRuntime } from './runtime.ts';

interface Status {
  ok: boolean;
  backend: string;
  pending: number;
  captured: number;
  skipped: number;
  recall: string;
  error: string | null;
}

export function makeMemoryStatus({ h, t, useEffect, useState }: SettingsRuntime) {
  return function MemoryStatus({ petId }: { petId: string }) {
    const [status, setStatus] = useState<Status | null>(null);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [action, setAction] = useState({ method: 'GET', attempt: 0 });
    useEffect(() => {
      if (!petId) return;
      const controller = new AbortController();
      setBusy(true);
      setFailed(false);
      setStatus(null);
      void fetch(ROUTE_PATH + '/chat/powercontext?pet=' + encodeURIComponent(petId), {
        method: action.method,
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json()) as Status;
          if (!response.ok || body.ok !== true) throw new Error('unavailable');
          if (!controller.signal.aborted) setStatus(body);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
      return () => controller.abort();
    }, [petId, action]);

    return h('div', {
      className: 'dsh-pet-cfg__note',
      children: [
        h('p', { children: t('memoryStatusHint') }),
        status
          ? h('p', {
              role: 'status',
              children: [
                status.backend === 'native' ? t('memoryNative') : 'PowerContext',
                ' · ',
                t('memoryPending'),
                ': ',
                String(status.pending),
                ' · ',
                t('memoryCaptured'),
                ': ',
                String(status.captured),
                ' · ',
                t('memorySkipped'),
                ': ',
                String(status.skipped),
                ' · ',
                t('memoryRecall'),
                ': ',
                t('memoryRecall_' + status.recall),
                status.error ? ' · ' + status.error : '',
              ],
            })
          : null,
        failed ? h('p', { role: 'status', children: t('memoryRecall_unavailable') }) : null,
        h('button', {
          type: 'button',
          disabled: busy || !petId,
          onClick: () => setAction({ method: 'GET', attempt: action.attempt + 1 }),
          children: t('memoryRefresh'),
        }),
        h('button', {
          type: 'button',
          disabled: busy || !petId || status?.backend !== 'powercontext',
          onClick: () => setAction({ method: 'POST', attempt: action.attempt + 1 }),
          children: t('memoryRetry'),
        }),
      ],
    });
  };
}
