/**
 * 进程内的宿主语言镜像：浏览器与桌面 shared-core 据此取文案。
 * 不负责向宿主上报；上报在客户端。缺省空串，按非 ru 处理。
 */

let hostLocaleId = '';

const listeners = new Set<(id: string) => void>();

/** 当前已知的宿主语言 id；还没收到叶子时是空串。 */
export function getHostLocale(): string {
  return hostLocaleId;
}

/** 写入镜像；id 没变不通知。 */
export function setHostLocale(id: string): void {
  if (id === hostLocaleId) return;
  hostLocaleId = id;
  for (const listener of listeners) listener(id);
}

/** 语言变化时通知；返回退订函数。 */
export function subscribeHostLocale(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试之间清掉镜像，避免串状态。 */
export function resetHostLocale(): void {
  hostLocaleId = '';
  listeners.clear();
}
