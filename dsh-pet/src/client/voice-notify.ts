/**
 * 工作状态播报：档位进入「会弹系统通知」的那几档时，把桌宠的台词念出来。
 *
 * 只随 DSH 网页端走，桌面透明窗不参与——与 client/notify.ts 同一条边界：系统通知只弹在
 * 网页端，工作状态播报同理。不写 `say` 叶子、不碰 `voiceTo`：这是工作状态的事，不是气泡的事。
 * 台词只取该档位的 `workStatusTexts`，不念 `task`（任务详情，常是对话片段或路径）。
 * @module dsh-pet/src/client/voice-notify
 */
import { petBridge } from './settings/bridge.ts';
import { isPageActive } from './notify.ts';
import { isVoiceNotifyEnabled, speakNotice } from '../shared/voice.ts';
import { WORK_STATUS_INDEX, type WorkStatusSnapshot, type WorkStatusState } from '../shared/work-status.ts';
import type { Pet } from '../shared/types.ts';

/** 会弹系统通知的档位：等你确认 / 完成 / 出错。其余档位只播动画，不出声。 */
const SPOKEN_STATES: readonly WorkStatusState[] = ['waiting', 'success', 'error'];

/** 上次念过的档位；同一档位重复写入不重念，回空闲后置 null，下次进入还能再念。 */
let lastSpoken: WorkStatusState | null = null;

/**
 * 判定这一拍要不要念、念什么。
 *
 * 只取配置里的台词，不念 `task`：`task` 是任务详情（常是对话片段或文件路径），读出来像在
 * 念日志；这里要的是宠物自己说的一句话。
 *
 * @param snap - 工作状态快照；只用到 `state`。
 * @param pets - 当前拍平的宠物列表；取首只的台词组，多宠物只念一次。
 * @param prev - 上次念过的档位。
 * @returns 要念的台词；档位没变、档位不出声或该档位没配台词时返回 undefined。
 */
export function decideWorkStatusLine(
  snap: WorkStatusSnapshot,
  pets: readonly Pet[],
  prev: WorkStatusState | null,
): string | undefined {
  if (snap.state === null || snap.state === prev) return undefined;
  if (!SPOKEN_STATES.includes(snap.state)) return undefined;
  const cfg = pets[0];
  if (cfg === undefined) return undefined;
  const group = Array.isArray(cfg.workStatusTexts) ? cfg.workStatusTexts[WORK_STATUS_INDEX[snap.state]] : undefined;
  if (!Array.isArray(group) || group.length === 0) return undefined;
  return group[Math.floor(Math.random() * group.length)];
}

/**
 * 消费一拍工作状态：档位变了、且新档位会弹系统通知时才念。
 *
 * @param snap - 刚读到的工作状态快照。
 */
export function speakWorkStatus(snap: WorkStatusSnapshot): void {
  const line = decideWorkStatusLine(snap, petBridge.current, lastSpoken);
  // 开关关着时 lastSpoken 照常推进：重新打开后不会补念一个已经过去的档位。
  lastSpoken = snap.state;
  if (line === undefined || !isVoiceNotifyEnabled()) return;
  // 与系统通知同一取向：用户正看着本页时不念——动画和头顶气泡已经把信息给了。
  if (isPageActive()) return;
  speakNotice(line);
}

/** 清掉去重状态，让下一次进入同一档位还能念。 @internal */
export function resetSpokenState(): void {
  lastSpoken = null;
}
