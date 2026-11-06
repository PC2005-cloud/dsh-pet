/**
 * 角色参考图端点（`GET /character?root=<素材根>`）：参数校验、探测顺序与应答形态。
 *
 * 只测本模块自己的判断。包内兜底在源码形态下不可达——`PACKAGE_ROOT` 由 `import.meta.url`
 * 推出，源码运行时指向 `src/`，所以这里只覆盖 `pet/` 命中与「都没有」两种结果。
 * 跑法：node --experimental-strip-types --test src/host/routes/character.test.ts
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleCharacterRoutes } from './character.ts';
import type { PetRouteDeps } from './types.ts';
import type { RouteResult } from '../http.ts';

let dir = '';

/** 路由只用到 petConfigDir（其余字段本领域不读），测试里不构造。 */
const deps = (): PetRouteDeps => ({ petConfigDir: dir }) as unknown as PetRouteDeps;

/** 调一次读取；`rest` 默认是干净的 `character`。 */
function read(query: string, rest = 'character'): Promise<RouteResult | undefined> {
  return handleCharacterRoutes(deps(), {
    url: new URL('http://localhost/character' + query),
    rest,
    method: 'GET',
  });
}

/** 断言是纯文本应答并取出状态码与文案。 */
function asText(result: RouteResult | undefined): { status: number; body: string } {
  assert.ok(result !== undefined, '处理器应给出应答');
  assert.equal(result.kind, 'text');
  return { status: result.status, body: result.body };
}

/** 在 pet/ 下写一张占位图；内容无关紧要，读取侧只看存在性与扩展名。 */
function putCharacter(assetRoot: string, ext: string): string {
  const file = join(dir, assetRoot + '-character' + ext);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-character-'));
});

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleCharacterRoutes —— 路径分派', () => {
  test('非 character 路径 → undefined（交给下一个处理器）', async () => {
    assert.equal(await read('?root=cat', 'other'), undefined);
  });
});

describe('handleCharacterRoutes —— 参数校验', () => {
  test('缺 root → 400，说明期望的参数形状', async () => {
    const { status, body } = asText(await read(''));
    assert.equal(status, 400);
    assert.match(body, /character\?root=/);
  });

  test('root 全是空白 → 400', async () => {
    const { status } = asText(await read('?root=%20%20'));
    assert.equal(status, 400);
  });

  test('root 含路径分隔符 → 400，不做任何路径拼接', async () => {
    const { status, body } = asText(await read('?root=' + encodeURIComponent('../evil')));
    assert.equal(status, 400);
    assert.equal(body, 'dsh-pet: invalid asset root');
  });

  test('目录里有个名字相近的文件 → 仍然 404，不按前缀匹配', async () => {
    putCharacter('cat', '.png');
    const { status } = asText(await read('?root=ca'));
    assert.equal(status, 404);
  });
});

describe('handleCharacterRoutes —— 取图', () => {
  test('pet/ 命中 → 回文件路径与按扩展名定的 Content-Type', async () => {
    const file = putCharacter('cat', '.png');
    const result = await read('?root=cat');
    assert.ok(result !== undefined && result.kind === 'file');
    assert.equal(result.file, file);
    assert.equal(result.contentType, 'image/png');
  });

  test('扩展名按白名单识别 → .webp 回 image/webp', async () => {
    putCharacter('cat', '.webp');
    const result = await read('?root=cat');
    assert.ok(result !== undefined && result.kind === 'file');
    assert.equal(result.contentType, 'image/webp');
  });

  test('多份并存 → 取探测顺序里靠前的那份', async () => {
    const png = putCharacter('cat', '.png');
    putCharacter('cat', '.webp');
    const result = await read('?root=cat');
    assert.ok(result !== undefined && result.kind === 'file');
    assert.equal(result.file, png);
  });

  test('main 不是特例：内置素材根同样按文件取', async () => {
    const file = putCharacter('main', '.png');
    const result = await read('?root=main');
    assert.ok(result !== undefined && result.kind === 'file');
    assert.equal(result.file, file);
  });

  test('没有这份图 → 404', async () => {
    const { status, body } = asText(await read('?root=cat'));
    assert.equal(status, 404);
    assert.equal(body, 'dsh-pet: character not found');
  });
});
