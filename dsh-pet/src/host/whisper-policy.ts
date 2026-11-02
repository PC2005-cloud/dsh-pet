/**
 * 自动碎碎念的调度结论：把「宠物自身开关」与「独立模式 AI 是否就绪」合成是否启用，周期只取宠物配置。
 * 不负责计时与生成；周期唯一来源是宿主侧的 `eventsRefreshSec.whisper`。
 * @module dsh-pet/src/host/whisper-policy
 */

export interface StandaloneWhisperPolicy {
  /** 独立模式服务是否已就绪（配置齐全且未暂停）。 */
  isReady(): boolean;
}

/**
 * 自动碎碎念的调度结论：是否启用 + 实际周期。
 *
 * 独立模式另需 AI 就绪；DSH 宿主模式下只看宠物配置自身的开关与周期。
 */
export function automaticWhisperSchedule(
  policy: StandaloneWhisperPolicy | undefined,
  petEnabled: boolean,
  configuredPeriodSec: number,
): { enabled: boolean; periodSec: number } {
  if (!policy) return { enabled: petEnabled, periodSec: configuredPeriodSec };
  return { enabled: petEnabled && policy.isReady(), periodSec: configuredPeriodSec };
}
