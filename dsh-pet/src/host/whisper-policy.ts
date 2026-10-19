export interface StandaloneWhisperPolicy {
  isReady(): boolean;
  canWhisper(): boolean;
  whisperIntervalSec(): number;
}

/** 独立模式另需全局明确授权；DSH 宿主继续遵循原来的宠物配置。 */
export function automaticWhisperSchedule(
  policy: StandaloneWhisperPolicy | undefined,
  petEnabled: boolean,
  configuredPeriodSec: number,
): { enabled: boolean; periodSec: number } {
  if (!policy) return { enabled: petEnabled, periodSec: configuredPeriodSec };
  const period = policy.whisperIntervalSec();
  return {
    enabled: petEnabled && policy.isReady() && policy.canWhisper(),
    periodSec: Number.isFinite(period) ? Math.max(60, period) : 300,
  };
}
