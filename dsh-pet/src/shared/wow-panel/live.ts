/** 实况角色与地图；断线或演示状态始终与真实在线观测区分。 */
import { object, text } from './api.ts';
import { card, date, details, el, facts, money, profile, type PanelContext } from './dom.ts';
import { currentPosition, mapDiagram } from './map.ts';

/** 渲染当前采集状态以及角色和地图摘要。 */
export function liveCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(t('角色与地图实况', 'Character and map status'));
  const current = profile(ctx);
  if (!Object.keys(current).length) {
    result.append(
      el(
        'p',
        ctx.game === 'classic'
          ? t('怀旧服没有实时采集档案。', 'Classic has no live capture profile.')
          : t('尚未收到本版本的采集状态。', 'No capture state has been received for this game.'),
        'dsh-wow-hint',
      ),
    );
    return result;
  }
  const bridge = object(current.bridge);
  const snapshot = object(bridge.snapshot);
  const statuses: Record<string, string> = {
    live: t('实时连接', 'Live'),
    stale: t('数据已过期', 'Stale data'),
    waiting: t('等待游戏数据', 'Waiting for game data'),
    demo: t('演示数据', 'Demo data'),
    paused: t('已暂停', 'Paused'),
  };
  result.append(
    facts([
      [t('采集状态', 'Capture status'), statuses[text(bridge.status)] ?? text(bridge.status)],
      [t('数据来源', 'Data source'), bridge.source === 'demo' ? t('模拟演示', 'Simulated demo') : bridge.source],
      [t('最近收到', 'Last received'), date(bridge.lastSeen, ctx.locale)],
      [t('数据年龄（秒）', 'Data age (seconds)'), bridge.ageSeconds],
    ]),
  );
  if (current.error || bridge.error) result.append(el('p', text(current.error ?? bridge.error), 'dsh-wow-hint'));
  if (!Object.keys(snapshot).length) return result;
  const position = currentPosition(bridge, current.error);
  result.append(
    facts([
      [t('角色', 'Character'), `${text(snapshot.name)} · ${text(snapshot.realm)}`],
      [
        t('等级 / 职业 / 专精', 'Level / class / spec'),
        `${text(snapshot.level)} / ${text(snapshot.class)} / ${text(snapshot.spec)}`,
      ],
      [t('阵营 / 种族', 'Faction / race'), `${text(snapshot.faction)} / ${text(snapshot.race)}`],
      [t('区域 / 地图', 'Zone / map'), `${text(snapshot.zone)} / ${text(snapshot.map)}`],
      [t('当前地图坐标', 'Current map coordinates'), position ? coordinates(position.x, position.y) : '—'],
      [t('副本', 'Instance'), `${text(snapshot.instanceType)} / ${text(snapshot.instanceID)}`],
      [
        t('状态', 'Status'),
        [
          snapshot.online ? t('在线', 'Online') : t('离线', 'Offline'),
          snapshot.combat ? t('战斗中', 'In combat') : t('脱战', 'Out of combat'),
          snapshot.dead ? t('死亡', 'Dead') : t('存活', 'Alive'),
        ].join(' · '),
      ],
      [
        t('当前金币', 'Current money'),
        bridge.status === 'live' && bridge.source === 'screen' && !current.error && !bridge.error && snapshot.online
          ? money(snapshot.copper, t)
          : '—',
      ],
    ]),
  );
  result.append(mapDiagram(ctx, bridge, current.error));
  result.append(
    details(t('原始观测 / 日历 / 团队增益', 'Raw observation / calendar / group buffs'), {
      snapshot,
      calendar: bridge.calendar,
      groupBuff: bridge.groupBuff,
      events: bridge.events,
      equipmentOffer: bridge.equipmentOffer,
      equipmentSwaps: bridge.equipmentSwaps,
      equipmentSwapError: bridge.equipmentSwapError,
    }),
  );
  return result;
}

/** 像素桥坐标是万分比；缺失坐标不解释为原点。 */
function coordinates(x: unknown, y: unknown): string {
  return typeof x === 'number' && typeof y === 'number' ? `${x.toFixed(2)}%, ${y.toFixed(2)}%` : '—';
}
