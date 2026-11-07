/** Fixed, localized game notices and receipt policies; this module never invokes a model. */
import type { BridgeStatus, CompanionEvent, CompanionState, Snapshot } from './shared/wow-companion.ts';
import type { EquipmentComparison } from './shared/wow-companion-equipment-comparisons.ts';
import type { EquipmentOffer } from './shared/wow-companion-equipment-offer.ts';

import { canInteract } from './idle.ts';
import { assessEquipment } from './shared/wow-companion-equipment-comparisons.ts';

export { CompanionPolicy } from './policy.ts';
export { CompanionIdlePolicy, canInteract } from './idle.ts';

type Calendar = NonNullable<BridgeStatus['calendar']>;
type GroupBuff = NonNullable<BridgeStatus['groupBuff']>;
const chinese = (locale: string) => locale.toLowerCase().startsWith('zh');
const spells: Readonly<Record<string, number>> = {
  WARRIOR: 6673,
  MAGE: 1459,
  PRIEST: 21562,
  DRUID: 1126,
  SHAMAN: 462854,
  EVOKER: 364342,
};
const label = (text: string | null | undefined, fallback: string) =>
  (text &&
    [...text]
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join('')
      .slice(0, 160)) ||
  fallback;

/** Official events share receipts across characters; personal appointments and resets belong to one character. */
export function calendarReminder(state: CompanionState, seen: readonly string[], now: number) {
  if (!canInteract(state, now) || !state.bridge.calendar) return;
  const { calendar, snapshot } = state.bridge;
  const identity = [state.game, snapshot.account, snapshot.realm, calendar.day];
  const oldDailyReceipt = JSON.stringify(identity);
  const keys: string[] = [];
  const items = calendar.items.filter((item) => {
    const personal = item.action !== 'start' && item.action !== 'end';
    const key = JSON.stringify([...identity, personal ? snapshot.guid : '', item.action, item.when, item.title]);
    if (seen.includes(key) || (!personal && seen.includes(oldDailyReceipt))) return false;
    keys.push(key);
    return true;
  });
  if (items.length) return { keys, calendar: { ...calendar, items } };
}

/** Correlates one current instance, class, character, and session before suggesting a missing group buff. */
export function groupBuffReminder(state: CompanionState, seen: readonly string[], now: number) {
  if (!canInteract(state, now)) return;
  const { snapshot, groupBuff: buff } = state.bridge;
  if (
    !buff ||
    buff.st !== 'ready' ||
    buff.s !== snapshot.session ||
    buff.g !== snapshot.guid ||
    buff.spell !== spells[snapshot.class] ||
    buff.missing < 1 ||
    buff.instanceType !== snapshot.instanceType ||
    buff.instanceID !== snapshot.instanceID
  )
    return;
  const key = JSON.stringify([state.game, snapshot.account, snapshot.guid, snapshot.session, buff.e, buff.spell]);
  if (!seen.includes(key)) return { key, buff };
}

/** Formats supported events from validated observations. Empty output means no proactive notice is needed. */
export function formatWowEvent(event: CompanionEvent, locale = 'zh-CN'): string {
  const zh = chinese(locale);
  const player = label(event.snapshot?.name, zh ? '冒险者' : 'Adventurer');
  switch (event.type) {
    case 'level_up':
      return zh
        ? `${player}，升到 ${event.snapshot?.level ?? '?'} 级了。继续前进吧。`
        : `${player}, level ${event.snapshot?.level ?? '?'} reached. Onward.`;
    case 'zone':
      return zh
        ? `抵达${label(event.snapshot?.zone, '新区域')}。留意周围的道路与敌人。`
        : `Arrived in ${label(event.snapshot?.zone, 'a new area')}. Watch the roads and nearby enemies.`;
    case 'death':
      return zh
        ? '先别急，看看复活点和周围的敌人，再决定下一步。'
        : 'Take a moment. Check the resurrection point and nearby enemies before your next move.';
    case 'revive':
      return zh
        ? '重新站起来了。先恢复状态，再继续冒险。'
        : 'Back on your feet. Recover before continuing the adventure.';
    default:
      return '';
  }
}

/** Calendar times are the observed server times; no conversion to the desktop clock is implied. */
export function formatWowCalendar(calendar: Calendar, locale = 'zh-CN'): string {
  const zh = chinese(locale);
  const actions = zh
    ? {
        start: '开始',
        end: '结束',
        personal_start: '预约开始',
        personal_end: '预约结束',
        reset: '副本重置',
        reset_soon: '副本即将重置',
      }
    : {
        start: 'starts',
        end: 'ends',
        personal_start: 'appointment starts',
        personal_end: 'appointment ends',
        reset: 'instance resets',
        reset_soon: 'instance resets soon',
      };
  const details = calendar.items
    .map((item) => `${label(item.title, zh ? '日历事件' : 'Calendar event')} · ${item.when} · ${actions[item.action]}`)
    .join('; ');
  return details ? `${zh ? '游戏日历（服务器时间）' : 'Game calendar (server time)'}: ${details}` : '';
}

/** A reminder asks the player to cast the buff; it does not operate the game or promise all members were checked. */
export function formatWowGroupBuff(buff: GroupBuff, locale = 'zh-CN'): string {
  if (buff.st !== 'ready' || buff.missing < 1) return '';
  const name = label(buff.name, chinese(locale) ? '队伍增益' : 'the group buff');
  return chinese(locale)
    ? `已检查 ${buff.checked}/${buff.total} 位队员，其中 ${buff.missing} 位缺少${name}。方便时记得补一下。`
    : `${buff.checked}/${buff.total} members checked; ${buff.missing} are missing ${name}. Refresh it when convenient.`;
}

/** Conservative numeric comparison text never treats item level alone as proof of a combat upgrade. */
export function formatWowEquipment(comparison: EquipmentComparison, locale = 'zh-CN'): string {
  const zh = chinese(locale);
  const name = label(comparison.candidate.name, zh ? '新装备' : 'New equipment');
  const assessment = assessEquipment(comparison);
  if (assessment.verdict === 'upgrade')
    return zh
      ? `${name}：当前记录支持属性提升。请在游戏内检查并确认是否更换。`
      : `${name}: the observed attributes support an improvement. Review and confirm any change inside the game.`;
  if (assessment.verdict === 'not_upgrade')
    return zh
      ? `${name}：当前记录未支持升级结论（${assessment.reason}）。`
      : `${name}: the observed comparison does not support an upgrade (${assessment.reason}).`;
  return zh
    ? `${name}：需要进一步核对属性、特效与专精（${assessment.reason}）。装等更高不一定更适合。`
    : `${name}: review attributes, effects, and specialization (${assessment.reason}). Higher item level alone is insufficient.`;
}

/** A live addon confirmation is an invitation for an in-game decision, never permission for a desktop action. */
export function formatWowEquipmentOffer(offer: EquipmentOffer, locale = 'zh-CN'): string {
  if (offer.st !== 'ready') return '';
  return chinese(locale)
    ? `${label(offer.n, '新装备')}的装等为 ${offer.il}。游戏内有待确认的更换提示，请核对后自行决定。`
    : `${label(offer.n, 'New equipment')} has item level ${offer.il}. Review the pending confirmation inside the game.`;
}

/** Rotates the four original idle conversation prompts without invoking a model or implying visual access. */
export function formatWowIdle(snapshot: Snapshot, locale = 'zh-CN', index = 0): string {
  const zh = chinese(locale);
  const player = label(snapshot.name, zh ? '冒险者' : 'Adventurer');
  const messages = zh
    ? [
        `${player}，下一段征途，你想去哪里？`,
        `${player}，趁现在平静，喝口水歇一歇吧。我会陪着你。`,
        `${player}，接下来最想换哪件装备？`,
        `${player}，艾泽拉斯的风景里，你最喜欢哪里？`,
      ]
    : [
        `${player}, where do you want your next adventure to take you?`,
        `${player}, enjoy this quiet moment. Drink some water and rest. I will stay by your side.`,
        `${player}, which piece of equipment do you want to replace next?`,
        `${player}, which view in Azeroth is your favorite?`,
      ];
  return messages[((Math.trunc(index) % messages.length) + messages.length) % messages.length]!;
}
