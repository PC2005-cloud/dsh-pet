import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WowCompanion } from './controller.ts';
import { importWowHistory } from './history-import.ts';
import { WowJsonSettings } from './storage.ts';
import { handleWowRoutes } from '../routes/wow.ts';
import type { PetRouteDeps } from '../routes/types.ts';
import type { RouteResult } from '../http.ts';
import { defaultSettings } from './shared/wow-companion.ts';
import type { WowProfile } from './profile.ts';
import { fileURLToPath } from 'node:url';
import { WowAppearance } from './appearance.ts';
import { readAllConfig } from '../config.ts';

function status(result: RouteResult | undefined): number | undefined {
  return result && 'status' in result ? result.status : undefined;
}

test('companion appearance commits its real display and preference together and survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wow-appearance-host-'));
  const paths = {
    defaultFile: fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url)),
    userFile: join(root, 'main-config.jsonc'),
    petDir: join(root, 'pet'),
  };
  await mkdir(paths.petDir);
  await writeFile(
    join(paths.petDir, 'elf-config.json'),
    JSON.stringify({ pets: [{ id: 'elf', name: '精灵', display: 'none' }], whisperPrompt: 'preserve elf persona' }),
  );
  let changed = '';
  const options = {
    root: join(root, 'wow'),
    appPath: root,
    resourcesPath: root,
    notify: () => false,
    warn: () => {},
    appearance: new WowAppearance(paths),
    appearanceChanged: (id: string) => {
      changed = id;
    },
  };
  const host = new WowCompanion(options);
  try {
    assert.equal(host.preferredPetId(), 'main');
    await host.action('appearance.select', undefined, { petId: 'elf' });
    assert.equal(changed, 'elf');
    assert.equal(host.preferredPetId(), 'elf');
    const config = readAllConfig(paths);
    assert.equal((config.main.pets as { display: string }[])[0]?.display, 'none');
    assert.notEqual((config.elf.pets as { display: string }[])[0]?.display, 'none');
    assert.equal(config.elf.whisperPrompt, 'preserve elf persona');
    await assert.rejects(host.action('appearance.select', undefined, { petId: '../invalid' }));
    await assert.rejects(
      host.action('preferences.save', undefined, {
        activeGame: 'retail',
        locale: 'zh-CN',
        petId: '',
        eventNotifications: true,
        muted: false,
      }),
      /appearance-select-required/,
    );
    assert.equal(host.preferredPetId(), 'elf');
  } finally {
    await host.dispose();
  }
  const restarted = new WowCompanion(options);
  try {
    assert.equal(restarted.preferredPetId(), 'elf');
    await restarted.action('appearance.select', undefined, { petId: '' });
    assert.equal(restarted.preferredPetId(), 'main');
    const config = readAllConfig(paths);
    assert.notEqual((config.main.pets as { display: string }[])[0]?.display, 'none');
    assert.equal((config.elf.pets as { display: string }[])[0]?.display, 'none');
  } finally {
    await restarted.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('new migration host stays disconnected, keeps version boundaries, and persists preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wow-migration-'));
  const options = { root, appPath: root, resourcesPath: root, notify: () => false, warn: () => {} };
  const host = new WowCompanion(options);
  try {
    host.start();
    const state = (await host.read()) as {
      profiles: Record<string, { settings: { enabled: boolean }; bridge: unknown }>;
      settings: { activeGame: string };
    };
    assert.equal(state.profiles.retail.settings.enabled, false);
    assert.equal(state.profiles.forever.settings.enabled, false);
    assert.equal(state.profiles.retail.bridge, null);
    assert.equal(state.profiles.classic, undefined);
    await assert.rejects(host.action('settings.save', 'classic', {}));
    const result = (await host.action('knowledge.search', undefined, {
      query: '怀旧服 DZ 是什么意思',
      locale: 'zh-CN',
      server: 'retail',
    })) as { games: string[]; entries: { title: string }[] };
    assert.deepEqual(result.games, ['classic']);
    assert.match(JSON.stringify(result.entries), /盗贼/);
    const plain = await host.prepareChat('你好');
    assert.equal(plain.transientImage, undefined);
    const visual = await host.prepareChat('你帮我看看我面前这个地形我走的过去吗');
    assert.match(visual.error ?? '', /未|没有/);
    assert.equal(visual.transientImage, undefined);
    await host.action('preferences.save', undefined, {
      activeGame: 'forever',
      locale: 'en',
      petId: '',
      eventNotifications: false,
      muted: true,
    });
  } finally {
    await host.dispose();
  }
  const restarted = new WowCompanion(options);
  try {
    const state = (await restarted.read()) as { settings: { activeGame: string; locale: string } };
    assert.equal(state.settings.activeGame, 'forever');
    assert.equal(state.settings.locale, 'en');
    assert.deepEqual((await readdir(root)).sort(), ['preferences.json']);
  } finally {
    await restarted.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('history import validates the whole whitelist, backs up destinations and excludes credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wow-import-'));
  const old = join(root, 'old');
  const current = join(root, 'new');
  await mkdir(old);
  await mkdir(current);
  const file = 'wow-companion-gold-v1.json';
  const oldBytes = '{"version":1,"accounts":[]}';
  const currentBytes = '{ "version": 1, "accounts": [] }';
  try {
    await writeFile(join(old, file), oldBytes);
    await writeFile(join(current, file), currentBytes);
    await writeFile(join(old, 'credentials.json'), '{"secret":"do-not-copy"}');
    await writeFile(join(old, 'wow-companion-equipment-history-v1.json'), '{"version":1,"entries":"corrupt"}');
    await assert.rejects(importWowHistory(old, current), /history-invalid/);
    assert.equal(await readFile(join(current, file), 'utf8'), currentBytes);
    await rm(join(old, 'wow-companion-equipment-history-v1.json'));
    const result = await importWowHistory(old, current);
    assert.deepEqual(result.imported, [file]);
    assert.ok(result.backupDirectory);
    assert.equal(await readFile(join(result.backupDirectory, file), 'utf8'), currentBytes);
    assert.equal(await readFile(join(current, file), 'utf8'), oldBytes);
    assert.equal((await readdir(current)).includes('credentials.json'), false);
    assert.equal(await readFile(join(old, file), 'utf8'), oldBytes);
    await assert.rejects(importWowHistory(current, current), /same-directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt preferences remain untouched and block replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wow-settings-'));
  const file = join(root, 'preferences.json');
  try {
    await writeFile(file, 'not-json');
    const store = new WowJsonSettings(file, { enabled: false }, (input) => input as { enabled: boolean });
    assert.equal(store.error, 'wow-settings-unreadable');
    assert.throws(() => store.save({ enabled: true }), /unreadable/);
    assert.equal(await readFile(file, 'utf8'), 'not-json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt addon receipt file does not hide other Warcraft settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wow-addon-isolation-'));
  const file = join(root, 'wow-addons-v1.json');
  await writeFile(file, 'corrupt-receipts');
  const host = new WowCompanion({ root, appPath: root, resourcesPath: root, notify: () => false, warn: () => {} });
  try {
    const state = (await host.read()) as { addons: unknown; addonsError: string; profiles: unknown; launcher: unknown };
    assert.equal(state.addons, null);
    assert.equal(state.addonsError, 'wow-addons-settings-invalid');
    assert.ok(state.profiles);
    assert.ok(state.launcher);
    assert.equal(await readFile(file, 'utf8'), 'corrupt-receipts');
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('disabling a profile can cancel an import already occupying the action queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wow-stop-priority-'));
  const host = new WowCompanion({ root, appPath: root, resourcesPath: root, notify: () => false, warn: () => {} });
  const { profiles } = host as unknown as { profiles: { retail: WowProfile } };
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  profiles.retail.importMacro = async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ok: false, code: 'disabled' };
  };
  const original = profiles.retail.setSettings.bind(profiles.retail);
  profiles.retail.setSettings = async (input) => {
    const state = await original(input);
    finish();
    return state;
  };
  try {
    const pending = host.action('macro.import', 'retail', { game: 'retail', body: '/cast Test' });
    await entered;
    const stopped = host.action('settings.save', 'retail', { ...defaultSettings, enabled: false });
    const settled = await Promise.race([
      stopped.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(settled, true, 'disable must finish without waiting behind a macro');
    assert.deepEqual(await pending, { ok: false, code: 'disabled' });
  } finally {
    finish?.();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('WoW routes reject malformed requests and method changes without executing mutations', async () => {
  let calls = 0;
  const deps = {
    wow: {
      read: async () => ({ profiles: {} }),
      action: async () => {
        calls++;
        return { ok: true };
      },
    },
    log: { warn: () => {} },
  } as unknown as PetRouteDeps;
  const base = { url: new URL('http://127.0.0.1/dsh-pet-7340/wow/action'), rest: 'wow/action', method: 'POST' };
  assert.equal(status(await handleWowRoutes(deps, { ...base, method: 'GET' })), 405);
  assert.equal(status(await handleWowRoutes(deps, { ...base, body: '[' })), 400);
  assert.equal(status(await handleWowRoutes(deps, { ...base, body: '{"action":42}' })), 400);
  assert.equal(status(await handleWowRoutes(deps, { ...base, body: 'x'.repeat(1024 * 1024 + 1) })), 413);
  assert.equal(calls, 0);
  assert.equal(
    status(await handleWowRoutes(deps, { ...base, body: '{"action":"demo","game":"retail","data":{}}' })),
    200,
  );
  assert.equal(calls, 1);
});
