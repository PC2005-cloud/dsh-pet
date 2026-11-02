/**
 * 头像上传端点（`POST /pet-avatar?root=<素材根>`）：出入参与失败分档。
 *
 * 只测端点自己的判断——文件怎么落、读到哪份由 pet-avatar.test.ts 与 assets.test.ts 覆盖。
 * 跑法：node --experimental-strip-types --test src/host/routes/avatar.test.ts
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleAvatarRoutes } from './avatar.ts';
import { petAvatarFile } from '../pet-avatar.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps } from './types.ts';

/** 最小 PNG 文件头：够魔数判定，不构成完整图片。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

let dir = '';

/** 路由只用到 petConfigDir（其余字段本领域不读），测试里不构造。 */
const deps = (): PetRouteDeps => ({ petConfigDir: dir }) as unknown as PetRouteDeps;

/** 调一次上传；`rest` 默认是干净的 `pet-avatar`。 */
function upload(query: string, method: string, body?: string, rest = 'pet-avatar'): Promise<RouteResult | undefined> {
  return handleAvatarRoutes(deps(), {
    url: new URL('http://localhost/pet-avatar' + query),
    rest,
    method,
    body,
  });
}

/** 断言是 JSON 应答并取出状态码与响应体。 */
function asJson(result: RouteResult | undefined): { status: number; obj: Record<string, unknown> } {
  assert.ok(result !== undefined, '处理器应给出应答');
  assert.equal(result.kind, 'json');
  return { status: result.status, obj: result.obj as Record<string, unknown> };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-avatar-route-'));
});

beforeEach(() => {
  // 每个用例都从空目录开始：上一用例落盘的头像会影响「不落盘」类断言。
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleAvatarRoutes —— 路径与方法', () => {
  test('非 pet-avatar 路径 → undefined（交给下一个处理器）', async () => {
    assert.equal(await upload('', 'POST', '{}', 'other'), undefined);
  });

  test('非 POST → 405', async () => {
    const { status } = asJson(await upload('?root=cat', 'GET'));
    assert.equal(status, 405);
  });
});

describe('handleAvatarRoutes —— 参数校验', () => {
  test('缺 root → 业务失败 bad-request（200 + ok:false）', async () => {
    const { status, obj } = asJson(await upload('', 'POST', '{}'));
    assert.equal(status, 200);
    assert.equal(obj.reason, 'bad-request');
  });

  test('root 含路径分隔符 → bad-request，不拼路径', async () => {
    const { obj } = asJson(await upload('?root=' + encodeURIComponent('../evil'), 'POST', '{}'));
    assert.equal(obj.reason, 'bad-request');
  });

  test('root=main（内置条目）→ bad-request，不写文件', async () => {
    const { status, obj } = asJson(
      await upload('?root=main', 'POST', JSON.stringify({ base64: PNG.toString('base64') })),
    );
    assert.equal(status, 200);
    assert.equal(obj.reason, 'bad-request');
    assert.equal(petAvatarFile(dir, 'main'), undefined, 'main 不得在 pet/ 里留下头像文件');
  });

  test('坏 JSON → 400 invalid-json', async () => {
    const { status, obj } = asJson(await upload('?root=cat', 'POST', '{'));
    assert.equal(status, 400);
    assert.equal(obj.reason, 'invalid-json');
  });

  test('base64 非规范 → 业务失败 bad-request，不解出垃圾字节', async () => {
    // 与 /chat 的附件校验同一口径：内容不合规是业务结论（200 + ok:false），不是协议 4xx
    const { status, obj } = asJson(await upload('?root=cat', 'POST', JSON.stringify({ base64: 'abc!!!' })));
    assert.equal(status, 200);
    assert.equal(obj.reason, 'bad-request');
  });
});

describe('handleAvatarRoutes —— 内容校验与落盘', () => {
  test('不是图片 → unsupported，且不落盘', async () => {
    const base64 = Buffer.from('definitely not an image', 'utf8').toString('base64');
    const { obj } = asJson(await upload('?root=cat', 'POST', JSON.stringify({ base64 })));
    assert.equal(obj.reason, 'unsupported');
    assert.equal(petAvatarFile(dir, 'cat'), undefined);
  });

  test('超过字节上限 → 413', async () => {
    // 头部对、长度超：先过魔数再看预算
    const huge = Buffer.concat([PNG, Buffer.alloc(800 * 1024)]);
    const { status, obj } = asJson(
      await upload('?root=cat', 'POST', JSON.stringify({ base64: huge.toString('base64') })),
    );
    assert.equal(status, 413);
    assert.equal(obj.reason, 'payload-too-large');
  });

  test('合法 PNG → ok:true 并落盘', async () => {
    const { status, obj } = asJson(
      await upload('?root=cat', 'POST', JSON.stringify({ base64: PNG.toString('base64') })),
    );
    assert.equal(status, 200);
    assert.deepEqual(obj, { ok: true });
    assert.equal(petAvatarFile(dir, 'cat')?.contentType, 'image/png');
  });
});
