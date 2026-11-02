/**
 * 宠物头像的存取（`pet-avatar.ts`）：按素材根读写 `pet/<素材根>-avatar.<ext>`。
 *
 * 钉住四件事：没上传过读不到、同名覆盖、换格式后取最新（mtime）、非图片字节不落盘。
 * 端点层的校验在 routes/avatar.test.ts 与 routes/assets.test.ts。
 * 跑法：node --experimental-strip-types --test src/host/pet-avatar.test.ts
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { petAvatarFile, savePetAvatar } from './pet-avatar.ts';

/** 各格式的最小文件头：够魔数判定，不构成完整图片。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)]);

let dir = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-avatar-'));
});

beforeEach(() => {
  // 每个用例都从空目录开始：上一用例留下的头像文件会影响「没上传过」的判定。
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('petAvatarFile —— 读取', () => {
  test('没上传过 → undefined（由调用方回退默认 logo）', () => {
    assert.equal(petAvatarFile(dir, 'cat'), undefined);
  });

  test('写过的头像能按素材根读回，类型来自扩展名', () => {
    assert.deepEqual(savePetAvatar(dir, 'cat', PNG), { ok: true });
    const found = petAvatarFile(dir, 'cat');
    assert.equal(found?.contentType, 'image/png');
    assert.equal(readFileSync(found.file).equals(PNG), true);
  });

  test('同名覆盖：内容与扩展名都跟着新图走', () => {
    savePetAvatar(dir, 'cat', PNG);
    savePetAvatar(dir, 'cat', JPEG);
    const found = petAvatarFile(dir, 'cat');
    assert.equal(found?.contentType, 'image/jpeg');
    assert.equal(readFileSync(found.file).equals(JPEG), true);
  });

  test('多份并存（换格式的残留）时取修改时间最新的一份', () => {
    const older = join(dir, 'cat-avatar.png');
    const newer = join(dir, 'cat-avatar.jpg');
    writeFileSync(older, PNG);
    writeFileSync(newer, JPEG);
    utimesSync(older, new Date(1_000), new Date(1_000));
    utimesSync(newer, new Date(2_000), new Date(2_000));
    assert.equal(petAvatarFile(dir, 'cat')?.contentType, 'image/jpeg');
    // 反过来：png 更新时读回 png——顺序不靠扩展名，只看时间
    utimesSync(older, new Date(3_000), new Date(3_000));
    assert.equal(petAvatarFile(dir, 'cat')?.contentType, 'image/png');
  });

  test('非法素材根不越出 pet 目录', () => {
    assert.equal(savePetAvatar(dir, '../evil', PNG).ok, false);
    assert.equal(petAvatarFile(dir, '../evil'), undefined);
  });
});

describe('savePetAvatar —— 校验', () => {
  test('非图片字节 → not-image，且不落盘', () => {
    assert.deepEqual(savePetAvatar(dir, 'cat', Buffer.from('not an image at all', 'utf8')), {
      ok: false,
      reason: 'not-image',
    });
    assert.equal(petAvatarFile(dir, 'cat'), undefined);
  });

  test('GIF 也能存（不限定 png/jpg）', () => {
    assert.deepEqual(savePetAvatar(dir, 'cat', GIF), { ok: true });
    assert.equal(petAvatarFile(dir, 'cat')?.contentType, 'image/gif');
  });
});
