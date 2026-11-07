import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompanionState } from './shared/wow-companion.ts';
import type { WowProfile } from './profile.ts';
import { WowCompanion } from './controller.ts';
import { defaultSettings } from './shared/wow-companion.ts';
import {
  createWowChatContext,
  CompanionPolicy,
  calendarReminder,
  groupBuffReminder,
  formatWowEvent,
  formatWowCalendar,
  formatWowGroupBuff,
} from './chat-context.ts';

const now = Date.now();
function state(): CompanionState {
  return {
    game: 'retail',
    settings: { ...defaultSettings },
    error: null,
    updatedAt: now,
    bridge: {
      instanceId: 'bridge',
      status: 'live',
      source: 'screen',
      lastSeen: new Date(now).toISOString(),
      ageSeconds: 0,
      snapshot: {
        v: 3,
        session: 's',
        seq: 1,
        tick: 1,
        guid: 'player',
        name: '冒险者',
        realm: 'realm',
        level: 10,
        class: 'PRIEST',
        faction: 'Horde',
        race: null,
        spec: 256,
        map: 1,
        zone: '杜隆塔尔',
        instanceType: 'party',
        instanceID: 123,
        px: 1234,
        py: 5678,
        combat: false,
        dead: false,
        online: true,
        account: 'account',
        moneyEpoch: 'epoch',
        copper: 10000,
        earned: 10000,
        spent: 0,
      },
      eventCursor: 0,
      events: [],
      equipment: [],
      equipmentComparisons: [],
      equipmentComparisonError: null,
      equipmentLoadout: null,
      equipmentLoadoutError: null,
      error: null,
      config: { x: 0, y: 0, cellSize: 1, pollMs: 100, paused: false },
    },
    gold: { accounts: [], storageError: null },
    equipmentHistory: { entries: [], storageError: null },
    levelHistory: { characters: [], storageError: null },
    equipmentComparisons: { entries: [], storageError: null },
    equipmentLoadouts: { entries: [], latestCharacter: null, storageError: null },
  };
}

test('fresh chat context names game/session and coordinate units; stale observations remain historical', () => {
  const profile = state();
  const fresh = createWowChatContext({ text: '我在哪，DZ是什么意思', locale: 'zh-CN', profiles: [profile], now });
  assert.match(fresh, /Current observation JSON/);
  assert.match(fresh, /"px":1234/);
  assert.match(fresh, /盗贼/);
  assert.match(fresh, /not a screenshot/);
  profile.bridge!.ageSeconds = 6;
  const stale = createWowChatContext({ text: '我在哪', profiles: [profile], now });
  assert.match(stale, /No current verified/);
  assert.doesNotMatch(stale, /Current observation JSON|"px":1234/);
  assert.doesNotMatch(
    createWowChatContext({ text: '怀旧服DZ', game: 'classic', profiles: [profile], now }),
    /"game":"retail"/,
  );
});

test('ledger chat keeps decimal strings and copper units without making offline balances current', () => {
  const profile = state();
  profile.bridge = null;
  profile.gold = {
    accounts: [
      {
        account: 'a',
        name: 'saved-account',
        balance: '90071992547409930',
        earned: '90071992547409930',
        spent: '0',
        net: '90071992547409930',
        characterCount: 0,
        firstSeen: now,
        lastSeen: now,
        characters: [],
      },
    ],
    storageError: null,
  };
  const context = createWowChatContext({ text: '我还有多少金币', profiles: [profile], now });
  assert.match(context, /"balance":"90071992547409930"/);
  assert.match(context, /Money values are copper/);
  assert.match(context, /does not establish who is online/);
  assert.ok(context.length <= 20500);
});

test('explicit game questions select their own observations even when no chat tool succeeds', () => {
  const retail = state();
  retail.bridge!.snapshot!.name = 'RetailOnlyCharacter';
  const forever = state();
  forever.game = 'forever';
  forever.bridge!.snapshot!.name = 'ForeverOnlyCharacter';
  const input = { game: 'retail' as const, locale: 'zh-CN', profiles: [retail, forever], now };
  for (const text of ['无限服我的金币有多少', '无限服推荐插件']) {
    const context = createWowChatContext({ ...input, text });
    assert.match(context, /ForeverOnlyCharacter/);
    assert.doesNotMatch(context, /RetailOnlyCharacter/);
  }
  const classic = createWowChatContext({ ...input, text: '怀旧服帮我写宏' });
  assert.doesNotMatch(classic, /RetailOnlyCharacter|ForeverOnlyCharacter/);
  const screenshot = createWowChatContext({ ...input, text: '看看无限服这个地形', preferGame: true });
  assert.match(screenshot, /RetailOnlyCharacter/);
  assert.doesNotMatch(screenshot, /ForeverOnlyCharacter/);
});

test('notification policy baselines sessions and defers a single level-up during combat', () => {
  const profile = state();
  const bridge = profile.bridge!;
  const policy = new CompanionPolicy();
  assert.equal(policy.accept(bridge, profile.settings, now), undefined);
  bridge.snapshot!.combat = true;
  bridge.eventCursor = 2;
  bridge.events = [
    {
      id: 1,
      type: 'level_up',
      title: '',
      detail: '',
      demo: false,
      timestamp: new Date(now).toISOString(),
      snapshot: { ...bridge.snapshot!, level: 11 },
    },
    {
      id: 2,
      type: 'zone',
      title: '',
      detail: '',
      demo: false,
      timestamp: new Date(now).toISOString(),
      snapshot: { ...bridge.snapshot!, zone: 'new zone' },
    },
  ];
  assert.equal(policy.accept(bridge, profile.settings, now), undefined);
  bridge.snapshot!.combat = false;
  const event = policy.accept(bridge, profile.settings, now + 1);
  assert.equal(event?.type, 'level_up');
  assert.match(formatWowEvent(event!, 'zh-CN'), /11 级/);
  assert.match(formatWowEvent(event!, 'en'), /level 11/);
  assert.equal(policy.accept(bridge, profile.settings, now + 2), undefined);
  bridge.snapshot!.session = 'new-session';
  assert.equal(policy.accept(bridge, profile.settings, now + 3), undefined);
});

test('calendar receipts and buff reminders require a fresh eligible character and matching instance', () => {
  const profile = state();
  const bridge = profile.bridge!;
  bridge.calendar = { day: '2026-11-05', items: [{ title: '节日', action: 'start', when: '2026-11-05 10:00' }] };
  const calendar = calendarReminder(profile, [], now);
  assert.ok(calendar);
  assert.match(formatWowCalendar(calendar.calendar, 'en'), /server time/);
  assert.match(formatWowCalendar(calendar.calendar, 'zh-CN'), /服务器时间/);
  assert.equal(calendarReminder(profile, calendar.keys, now), undefined);
  bridge.groupBuff = {
    v: 1,
    kind: 'buff',
    s: 's',
    g: 'player',
    e: 1,
    q: 1,
    st: 'ready',
    spell: 21562,
    name: '真言术：韧',
    missing: 1,
    checked: 4,
    total: 5,
    instanceType: 'party',
    instanceID: 123,
  };
  const buff = groupBuffReminder(profile, [], now);
  assert.ok(buff);
  assert.match(formatWowGroupBuff(buff.buff, 'zh-CN'), /1 位缺少/);
  assert.match(formatWowGroupBuff(buff.buff, 'en'), /1 are missing/);
  assert.equal(groupBuffReminder(profile, [buff.key], now), undefined);
  bridge.snapshot!.instanceID = 999;
  assert.equal(groupBuffReminder(profile, [], now), undefined);
  bridge.snapshot!.combat = true;
  assert.equal(calendarReminder(profile, [], now), undefined);
});

test('death and revive remain event notices while mute, opt-outs and combat quiet are respected', () => {
  const profile = state();
  const bridge = profile.bridge!;
  const policy = new CompanionPolicy();
  policy.accept(bridge, profile.settings, now);
  bridge.snapshot!.dead = true;
  bridge.eventCursor = 1;
  bridge.events = [
    {
      id: 1,
      type: 'death',
      timestamp: new Date(now).toISOString(),
      title: '',
      detail: '',
      demo: false,
      snapshot: { ...bridge.snapshot! },
    },
  ];
  const death = policy.accept(bridge, profile.settings, now);
  assert.equal(death?.type, 'death');
  assert.match(formatWowEvent(death!, 'en'), /resurrection point/);
  bridge.snapshot!.dead = false;
  bridge.eventCursor = 2;
  bridge.events.push({
    id: 2,
    type: 'revive',
    timestamp: new Date(now + 21000).toISOString(),
    title: '',
    detail: '',
    demo: false,
    snapshot: { ...bridge.snapshot! },
  });
  assert.equal(policy.accept(bridge, { ...profile.settings, muted: true }, now + 21000), undefined);
  assert.equal(policy.accept(bridge, profile.settings, now + 21001), undefined);
  bridge.eventCursor = 3;
  bridge.events.push({ ...bridge.events[1], id: 3 });
  assert.equal(policy.accept(bridge, { ...profile.settings, revive: false }, now + 21002), undefined);
  bridge.eventCursor = 4;
  bridge.snapshot!.combat = true;
  bridge.events.push({ ...bridge.events[1], id: 4 });
  assert.equal(policy.accept(bridge, profile.settings, now + 21003), undefined);
  bridge.snapshot!.combat = false;
  const revive = policy.accept(bridge, profile.settings, now + 21004);
  assert.equal(revive?.type, 'revive');
  assert.match(formatWowEvent(revive!, 'zh-CN'), /重新站起来/);
});

test('host idle notices wait for continuous current-game eligibility and retain one busy opportunity', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now });
  const root = mkdtempSync(join(tmpdir(), 'wow-idle-'));
  const spoken: string[] = [];
  let busy = false;
  const host = new WowCompanion({
    root,
    appPath: root,
    resourcesPath: root,
    notify: (text) => {
      spoken.push(text);
      return true;
    },
    warn() {},
    idleEligibility: () => ({ eligible: true, busy }),
  });
  const probe = host as unknown as { notify(state: CompanionState): void };
  const profile = state();
  const update = (milliseconds: number) => {
    context.mock.timers.tick(milliseconds);
    profile.bridge!.lastSeen = new Date(Date.now()).toISOString();
    probe.notify(profile);
  };
  try {
    update(0);
    update(20000);
    update(20000);
    busy = true;
    update(20000);
    assert.equal(spoken.length, 0);
    busy = false;
    update(1);
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /下一段征途/);
    profile.bridge!.snapshot!.combat = true;
    update(20000);
    profile.bridge!.snapshot!.combat = false;
    update(20000);
    update(20000);
    assert.equal(spoken.length, 1);
    update(20000);
    update(20000);
    assert.equal(spoken.length, 2);
    assert.match(spoken[1], /喝口水/);
    await host.action('preferences.save', undefined, {
      activeGame: 'classic',
      locale: 'en',
      petId: '',
      eventNotifications: true,
      muted: false,
    });
    for (let i = 0; i < 5; i++) update(20000);
    assert.equal(spoken.length, 2);
  } finally {
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller shutdown revokes an active native workflow before waiting for its action queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wow-dispose-'));
  const host = new WowCompanion({ root, appPath: root, resourcesPath: root, notify: () => false, warn() {} });
  let finish: (() => void) | undefined;
  let started: (() => void) | undefined;
  let revoked = false;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const profile = {
    importMacro: async () => {
      started?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: false, code: 'cancelled' };
    },
    dispose: async () => {
      revoked = true;
      finish?.();
    },
  } as unknown as WowProfile;
  (host as unknown as { profiles: Record<string, WowProfile> }).profiles = { retail: profile, forever: profile };
  try {
    const action = host.action('macro.import', 'retail', { game: 'retail', body: '/cast Frostbolt' });
    await ready;
    const shutdown = host.dispose();
    assert.equal(revoked, true);
    await shutdown;
    assert.deepEqual(await action, { ok: false, code: 'cancelled' });
    assert.equal(host.dispose(), shutdown);
  } finally {
    finish?.();
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
