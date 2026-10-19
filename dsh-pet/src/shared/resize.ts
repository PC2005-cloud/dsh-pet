// 两端共用的拖柄尺寸边界和本地覆盖；配置中的 size 不被改写。
export const MIN_PET_SIZE = 120;
export const MAX_PET_SIZE = 1200;

export interface ResizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampPetSize(size: number): number {
  return Number.isFinite(size) ? Math.round(Math.min(MAX_PET_SIZE, Math.max(MIN_PET_SIZE, size))) : MIN_PET_SIZE;
}

function localStorageOrNull(storage?: ResizeStorage | null): ResizeStorage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 按宠物 id 和配置尺寸隔离；配置改为新尺寸后优先使用新配置。 */
export function readPetSize(id: string, baseSize: number, storage?: ResizeStorage | null): number {
  try {
    const raw = localStorageOrNull(storage)?.getItem(`dsh-pet:size:${id}:${baseSize}`);
    if (!raw || !raw.trim()) return baseSize;
    const size = Number(raw);
    return Number.isFinite(size) && size >= MIN_PET_SIZE && size <= MAX_PET_SIZE ? size : baseSize;
  } catch {
    return baseSize;
  }
}

/** 仅在手势收尾时写入；禁用/写满存储不能中断交互。 */
export function savePetSize(id: string, baseSize: number, size: number, storage?: ResizeStorage | null): void {
  if (!Number.isFinite(size)) return;
  try {
    localStorageOrNull(storage)?.setItem(`dsh-pet:size:${id}:${baseSize}`, String(clampPetSize(size)));
  } catch {
    /* 可选的本地偏好。 */
  }
}
