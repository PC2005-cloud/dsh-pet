/**
 * 素材路由的 `/logo` 分支：缺省回包内 logo，带 `root=<素材根>` 时回该宠物的自定义头像。
 *
 * 只钉本模块的 root 分支；其余素材端点（thumb / pic / font / sound）经真实 router 在
 * routes.test.ts 覆盖，这里不重复搭那一套。
 * 跑法：node --experimental-strip-types --test src/host/routes/assets.test.ts
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleAssetsRoutes } from './assets.ts';
import { savePetAvatar } from '../pet-avatar.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps } from './types.ts';

/** 最小 PNG 文件头：够魔数判定，不构成完整图片。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

let dir = '';

/** 路由只用到 petConfigDir（其余字段本领域不读），测试里不构造。 */
const deps = (): PetRouteDeps => ({ petConfigDir: dir }) as unknown as PetRouteDeps;

/** 调一次 logo 读取；`rest` 默认是干净的 `logo`。 */
function readLogo(query: string, rest = 'logo'): Promise<RouteResult | undefined> {
  return handleAssetsRoutes(deps(), { url: new URL('http://localhost/logo' + query), rest, method: 'GET' });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-assets-'));
});

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleAssetsRoutes —— /logo?root=', () => {
  test('带 root 且该宠物有头像 → 回该文件', async () => {
    savePetAvatar(dir, 'cat', PNG);
    const result = await readLogo('?root=cat');
    assert.ok(result !== undefined && result.kind === 'file');
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.file, join(dir, 'cat-avatar.png'));
  });

  test('带 root 但没上传过 → 不回头像（继续走默认 logo 分支）', async () => {
    const result = await readLogo('?root=cat');
    // 源码形态下包内 assets/logo.png 不可达，所以断言「不是 pet 目录里的文件」即可
    assert.ok(result === undefined || result.kind !== 'file' || !result.file.startsWith(dir));
  });

  test('非法素材根 → 400，不做任何路径拼接', async () => {
    const result = await readLogo('?root=' + encodeURIComponent('../evil'));
    assert.ok(result !== undefined && result.kind === 'text');
    assert.equal(result.status, 400);
  });

  test('/logo 后面还有段 → 400', async () => {
    const result = await readLogo('', 'logo/x');
    assert.ok(result !== undefined && result.kind === 'text');
    assert.equal(result.status, 400);
  });

  test('root=main（内置）即使有残留文件也不读它', async () => {
    // 直接写文件（绕过上传端点），模拟历史遗留：读取侧仍然要无视它
    writeFileSync(join(dir, 'main-avatar.png'), PNG);
    const result = await readLogo('?root=main');
    assert.ok(
      result === undefined || result.kind !== 'file' || !result.file.startsWith(dir),
      'main 只能回包内默认 logo',
    );
    assert.equal(readFileSync(join(dir, 'main-avatar.png')).equals(PNG), true, '残留文件不被删除');
  });
});
