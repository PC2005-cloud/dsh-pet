import type { TestContext } from 'node:test';
import type { BridgeStatus, Snapshot } from '../shared/wow-companion';
import type { InstalledAddon } from '../shared/wow-addons';
import type { LauncherPlatform } from './wow-launcher-runtime';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import { WowAddonsController } from './addons-controller';
import { WowAddonInstaller, validateClientDirectory } from './wow-addons-install';
import { CompanionGoldLedger } from './wow-companion-gold';
import { LauncherFailure, WowLauncher } from './wow-launcher-runtime';

async function temporary(t: TestContext) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, 'dsh-wow-domain-'));
  t.after(async () => {
    const difference = relative(root, resolve(directory));
    if (isAbsolute(difference) || difference.startsWith(`..${sep}`) || !difference.startsWith('dsh-wow-domain-'))
      throw new Error('Refusing cleanup outside the test directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function live(snapshot: Partial<Snapshot> = {}): BridgeStatus {
  return {
    instanceId: 'bridge-1',
    status: 'live',
    source: 'screen',
    snapshot: {
      v: 3,
      session: 'session-1',
      seq: 1,
      tick: 100,
      guid: 'Player-1',
      name: 'Mage',
      realm: 'Silvermoon',
      level: 80,
      class: 'MAGE',
      faction: 'Alliance',
      race: 'Human',
      spec: 1,
      map: 1,
      zone: 'Town',
      combat: false,
      dead: false,
      online: true,
      account: 'account-1',
      moneyEpoch: 'epoch-1',
      copper: 100_000,
      earned: 0,
      spent: 0,
      ...snapshot,
    },
    lastSeen: new Date().toISOString(),
    ageSeconds: 0,
    eventCursor: 0,
    events: [],
    equipmentComparisons: [],
    equipmentComparisonError: null,
    equipmentLoadout: null,
    equipmentLoadoutError: null,
    config: { x: 0, y: 0, cellSize: 2, pollMs: 750, paused: false },
    error: null,
  };
}

test('gold totals survive restarts without replaying cumulative counters or retired epochs', async (t) => {
  const path = join(await temporary(t), 'gold.json');
  const ledger = new CompanionGoldLedger(path);
  await ledger.observe(live({ seq: 10, earned: 100, spent: 40, copper: 60 }));
  await ledger.observe(live({ seq: 11, earned: 90, spent: 50, copper: 40 }));
  await ledger.observe(live({ seq: 9, earned: 110, spent: 45, copper: 65 }));
  assert.equal(ledger.read().accounts[0].earned, '100');
  await ledger.observe(live({ seq: 12, moneyEpoch: 'epoch-2', earned: 20, spent: 5, copper: 75 }));
  await ledger.observe(live({ seq: 13, moneyEpoch: 'epoch-1', earned: 5000, spent: 1, copper: 4999 }));
  await ledger.flush();
  const reopened = new CompanionGoldLedger(path);
  await reopened.observe(live({ session: 'session-2', moneyEpoch: 'epoch-2', earned: 30, spent: 10, copper: 80 }));
  const account = reopened.read().accounts[0];
  assert.equal(account.earned, '130');
  assert.equal(account.spent, '50');
  assert.equal(account.balance, '80');
  await reopened.flush();
});

test('gold ignores demonstration data and preserves damaged storage', async (t) => {
  const path = join(await temporary(t), 'gold.json');
  const ledger = new CompanionGoldLedger(path);
  await ledger.observe({ ...live({ earned: 999 }), source: 'demo' });
  assert.deepEqual(ledger.read().accounts, []);
  await writeFile(path, '{damaged', 'utf8');
  const damaged = new CompanionGoldLedger(path);
  await damaged.observe(live());
  await damaged.flush();
  assert.ok(damaged.read().storageError);
  assert.equal(await readFile(path, 'utf8'), '{damaged');
});

test('launcher validates replacements atomically and reinspects before launching', async (t) => {
  const path = join(await temporary(t), 'launcher.json');
  let invalid = false;
  let inspections = 0;
  let launches = 0;
  const platform: LauncherPlatform = {
    supported: true,
    async inspect(target, executable) {
      inspections++;
      if (invalid) throw new LauncherFailure('wrong-version');
      return { target, path: executable, productName: 'World of Warcraft', fileVersion: '12.0.0' };
    },
    async launch() {
      launches++;
    },
  };
  const launcher = new WowLauncher(path, platform);
  assert.deepEqual(await launcher.launch({}), { ok: false, code: 'not-configured' });
  assert.equal(
    (await launcher.save({ target: 'retail', path: 'E:\\Games\\_retail_\\Wow.exe', makeDefault: true })).ok,
    true,
  );
  const saved = await readFile(path, 'utf8');
  invalid = true;
  assert.deepEqual(await launcher.save({ target: 'retail', path: 'E:\\wrong.exe', makeDefault: false }), {
    ok: false,
    code: 'wrong-version',
  });
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.deepEqual(await launcher.launch({ target: 'retail', args: ['--exec=bad'] }), {
    ok: false,
    code: 'invalid-request',
  });
  assert.deepEqual(await launcher.launch({}), { ok: false, code: 'wrong-version' });
  assert.equal(launches, 0);
  invalid = false;
  assert.equal((await launcher.launch({})).ok, true);
  assert.equal(inspections, 4);
  assert.equal(launches, 1);
  assert.deepEqual(await launcher.launch({}), { ok: false, code: 'busy' });
});

interface ZipEntry {
  name: string;
  contents: string;
  checksum?: number;
  compressed?: boolean;
}

// Real ZIP local/central records exercise decompression, path checks and streaming CRC verification.
function archive(files: ZipEntry[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const contents = Buffer.from(file.contents);
    const data = file.compressed ? deflateRawSync(contents) : contents;
    const checksum = file.checksum ?? crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(file.compressed ? 8 : 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(file.compressed ? 8 : 0, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(contents.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
    centralSize += header.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

const details = {
  game: 'retail' as const,
  modId: 42,
  fileId: 101,
  name: 'Example',
  version: '1.0',
  gameVersionTypeId: 517,
};

async function installerFixture(t: TestContext) {
  const directory = await temporary(t);
  const client = join(directory, 'World of Warcraft', '_retail_');
  const addons = join(client, 'Interface', 'AddOns');
  await mkdir(addons, { recursive: true });
  await writeFile(join(client, 'Wow.exe'), '');
  return { client, addons, installer: new WowAddonInstaller(join(directory, 'backups')) };
}

test('addon installation stages compressed files and rolls back a failed receipt commit', async (t) => {
  const { client, addons, installer } = await installerFixture(t);
  await mkdir(join(addons, 'First'));
  await writeFile(join(addons, 'First', 'First.toc'), 'old');
  const previous: InstalledAddon = {
    ...details,
    clientDirectory: client,
    folders: ['First'],
    installedAt: new Date().toISOString(),
  };
  const bytes = archive([
    { name: 'First/First.toc', contents: 'new', compressed: true },
    { name: 'Second/Second.toc', contents: 'new module' },
  ]);
  await assert.rejects(
    installer.installArchive(client, bytes, details, [previous], async () => {
      throw new Error('disk full');
    }),
    /wow-addons-install-failed/,
  );
  assert.equal(await readFile(join(addons, 'First', 'First.toc'), 'utf8'), 'old');
  assert.deepEqual(await readdir(addons), ['First']);
  const receipt = await installer.installArchive(client, bytes, details, [previous]);
  assert.deepEqual(receipt.folders, ['First', 'Second']);
  assert.ok(receipt.backupPath);
  assert.equal(await readFile(join(receipt.backupPath, 'First', 'First.toc'), 'utf8'), 'old');
  assert.equal(await readFile(join(addons, 'First', 'First.toc'), 'utf8'), 'new');
  assert.deepEqual(await readdir(join(client, 'Interface')), ['AddOns']);
});

test('addon installation rejects traversal, bad CRC, executable payloads and foreign branches', async (t) => {
  const { client, addons, installer } = await installerFixture(t);
  for (const file of [
    { name: '../escape.toc', contents: 'unsafe' },
    { name: 'First/First.toc', contents: 'bad crc', checksum: 0 },
    { name: 'First/First.toc', contents: 'MZ executable' },
  ]) {
    await assert.rejects(installer.installArchive(client, archive([file]), details, []), /wow-addons-invalid-archive/);
    assert.deepEqual(await readdir(addons), []);
  }
  await assert.rejects(validateClientDirectory(client, 'forever'), /wow-addons-invalid-directory/);
});

test('addon controller validates actions and keeps missing credentials out of network operations', async (t) => {
  const controller = new WowAddonsController(await temporary(t), {
    isEncryptionAvailable: () => false,
    encryptString() {
      throw new Error('Unavailable');
    },
    decryptString() {
      throw new Error('Unavailable');
    },
  });
  assert.equal(controller.read().hasApiKey, false);
  assert.deepEqual(await controller.action('metadata', {}), { ok: false, error: 'curseforge-api-key-required' });
  assert.equal((await controller.action('settings.save', {})).ok, false);
  assert.equal((await controller.action('install', { game: 'retail', modId: -1, fileId: 1 })).ok, false);
  assert.deepEqual(await controller.action('unknown', {}), { ok: false, error: 'wow-addons-action-invalid' });
  await controller.dispose();
  assert.deepEqual(await controller.action('metadata', {}), { ok: false, error: 'wow-addons-stopped' });
});
