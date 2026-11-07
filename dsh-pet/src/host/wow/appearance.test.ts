import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readAllConfig } from '../config.ts';
import type { ConfigPaths } from '../config.ts';
import { WowAppearance } from './appearance.ts';

function pet(id: string, display: string) {
  return {
    id,
    name: `Name ${id}`,
    display,
    size: 280,
    balanceEnabled: false,
    position: { corner: 'bottom-right', marginX: 15, marginY: 20 },
    whisperPrompt: `persona ${id}`,
    customProperty: { untouched: true },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-appearance-'));
  const paths: ConfigPaths = {
    defaultFile: fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url)),
    userFile: join(root, 'main-config.jsonc'),
    petDir: join(root, 'pet'),
  };
  mkdirSync(paths.petDir);
  const packFile = join(paths.petDir, 'elf-config.jsonc');
  const main = {
    pets: [pet('main', 'both'), pet('another-main', 'desktop')],
    whisperPrompt: 'shared main persona',
    chatModel: { provider: 'test', model: 'existing' },
    customGlobal: { preserve: true },
  };
  const pack = {
    pets: [pet('elf', 'none'), pet('another-elf', 'web')],
    whisperPrompt: 'shared elf persona',
    animations: { idle: ['stand'] },
    customGlobal: 'elf custom config',
  };
  writeFileSync(paths.userFile, `// Keep JSONC input readable\n${JSON.stringify(main, null, 2)}`);
  writeFileSync(packFile, `/* Installed pet pack */\n${JSON.stringify(pack, null, 2)}`);
  return {
    root,
    paths,
    packFile,
    main,
    pack,
    service: new WowAppearance(paths),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('the original built-in appearance is the default; only installed pet instances appear', () => {
  const f = fixture();
  try {
    const state = f.service.read();
    assert.equal(state.selectedPetId, '');
    assert.equal(state.resolvedPetId, 'main');
    assert.equal(state.error, undefined);
    assert.deepEqual(
      state.options.map((option) => option.id),
      ['main', 'another-main', 'elf', 'another-elf'],
    );
    assert.equal(state.options.find((option) => option.id === 'main')?.builtin, true);
    assert.equal(state.options.find((option) => option.id === 'elf')?.avatarRoot, 'elf');
    assert.equal(f.service.read('deleted-custom-pet').resolvedPetId, 'main');
    assert.equal(f.service.read('deleted-custom-pet').error, 'wow-appearance-unavailable');
  } finally {
    f.clean();
  }
});

test('select changes actual visibility and preserves other pets, personas, models and pack fields', async () => {
  const f = fixture();
  try {
    let preferenceCommitted = false;
    const selected = await f.service.select('elf', '', () => {
      preferenceCommitted = true;
    });
    assert.equal(preferenceCommitted, true);
    assert.equal(selected.resolvedPetId, 'elf');
    assert.deepEqual(selected.changedPetIds.sort(), ['elf', 'main']);
    const main = JSON.parse(readFileSync(f.paths.userFile, 'utf8'));
    const pack = JSON.parse(readFileSync(f.packFile, 'utf8'));
    assert.deepEqual(main, { ...f.main, pets: [{ ...f.main.pets[0], display: 'none' }, f.main.pets[1]] });
    assert.deepEqual(pack, { ...f.pack, pets: [{ ...f.pack.pets[0], display: 'both' }, f.pack.pets[1]] });
    assert.equal(new WowAppearance(f.paths).read('elf').resolvedPetId, 'elf');
    await f.service.select('', 'elf');
    const restored = readAllConfig(f.paths);
    assert.equal((restored.main.pets as Record<string, unknown>[])[0]?.display, 'both');
    assert.equal((restored.elf.pets as Record<string, unknown>[])[0]?.display, 'none');
    assert.equal((restored.main.pets as Record<string, unknown>[])[1]?.display, 'desktop');
  } finally {
    f.clean();
  }
});

test('already visible target retains its surface and same-entry changes are saved together', async () => {
  const f = fixture();
  try {
    const selected = await f.service.select('another-main', 'main');
    assert.equal(selected.resolvedPetId, 'another-main');
    const main = JSON.parse(readFileSync(f.paths.userFile, 'utf8'));
    assert.equal(main.pets[0].display, 'none');
    assert.equal(main.pets[1].display, 'desktop');
    assert.deepEqual(
      readFileSync(f.packFile),
      Buffer.from(`/* Installed pet pack */\n${JSON.stringify(f.pack, null, 2)}`),
    );
  } finally {
    f.clean();
  }
});

test('a preference commit failure rolls back both files byte for byte and leaves no staging files', async () => {
  const f = fixture();
  try {
    const beforeMain = readFileSync(f.paths.userFile);
    const beforePack = readFileSync(f.packFile);
    await assert.rejects(
      f.service.select('elf', '', () => {
        throw new Error('wow-settings-unreadable');
      }),
      /wow-settings-unreadable/,
    );
    assert.deepEqual(readFileSync(f.paths.userFile), beforeMain);
    assert.deepEqual(readFileSync(f.packFile), beforePack);
    assert.equal(
      [...readdirSync(f.root), ...readdirSync(f.paths.petDir)].some((name) => name.endsWith('.tmp')),
      false,
    );
  } finally {
    f.clean();
  }
});

test('appearance transactions stay ordered when multiple selections arrive', async () => {
  const f = fixture();
  try {
    let selected = '';
    await Promise.all([
      f.service.select('elf', '', () => {
        selected = 'elf';
      }),
      f.service.select('another-elf', 'elf', () => {
        selected = 'another-elf';
      }),
    ]);
    const config = readAllConfig(f.paths);
    const elves = config.elf.pets as Record<string, unknown>[];
    assert.equal(selected, 'another-elf');
    assert.equal(elves.find((pet) => pet.id === 'elf')?.display, 'none');
    assert.equal(elves.find((pet) => pet.id === 'another-elf')?.display, 'web');
    assert.equal((config.main.pets as Record<string, unknown>[]).find((pet) => pet.id === 'main')?.display, 'none');
  } finally {
    f.clean();
  }
});

test('unknown selections and corrupt files are never overwritten', async () => {
  const f = fixture();
  try {
    const beforeMain = readFileSync(f.paths.userFile);
    await assert.rejects(f.service.select('not-installed', ''), /wow-appearance-unavailable/);
    assert.deepEqual(readFileSync(f.paths.userFile), beforeMain);
    writeFileSync(f.paths.userFile, 'bad-json-original');
    assert.equal(f.service.read().error, 'wow-appearance-config-unreadable');
    await assert.rejects(f.service.select('elf', ''), /wow-appearance-config-unreadable/);
    assert.equal(readFileSync(f.paths.userFile, 'utf8'), 'bad-json-original');
  } finally {
    f.clean();
  }
});

test('a missing user configuration is created without changing packaged defaults and removed on rollback', async () => {
  const f = fixture();
  try {
    rmSync(f.paths.userFile);
    const defaultBytes = readFileSync(f.paths.defaultFile);
    await assert.rejects(
      f.service.select('elf', '', () => {
        throw new Error('wow-settings-unreadable');
      }),
      /wow-settings-unreadable/,
    );
    assert.equal(readdirSync(f.root).includes('main-config.jsonc'), false);
    assert.deepEqual(readFileSync(f.paths.defaultFile), defaultBytes);
    await f.service.select('elf', '');
    assert.equal((readAllConfig(f.paths).main.pets as Record<string, unknown>[])[0]?.display, 'none');
    assert.deepEqual(readFileSync(f.paths.defaultFile), defaultBytes);
  } finally {
    f.clean();
  }
});
