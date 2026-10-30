/**
 * 会话交互路由（src/host/routes/interaction.ts）中 /whisper 的契约测试：
 * ?image= 透传给生成函数、?surface= 落成 voiceTo、缺省不带、失败 reason 原样透出。
 * 锁 / 投喂 / 清气泡三个分支各有自己的覆盖，这里只钉住 /whisper 这一条链路。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleInteractionRoutes } from './interaction.ts';
import type { GeneratedReply, PetRouteDeps, RouteInput } from './types.ts';

/** 造一份只满足 /whisper 分支的依赖：宠物定位恒命中，生成行为由调用方给。 */
function harness(whisper: (petId: string, image?: string) => Promise<GeneratedReply>) {
  const calls: { petId: string; image?: string; voiceTo?: string }[] = [];
  const deps = {
    requirePet: () => ({ ok: true, petId: 'main', entry: 'main', conf: {}, pet: {} }),
    publishWhisper: (petId: string, image?: string, voiceTo?: string) => {
      calls.push({ petId, image, voiceTo });
      return whisper(petId, image);
    },
  } as unknown as PetRouteDeps;
  const call = (query: string) =>
    handleInteractionRoutes(deps, {
      url: new URL('http://127.0.0.1/dsh-pet-7340/whisper' + query),
      rest: 'whisper',
      method: 'POST',
    } as RouteInput);
  return { calls, call };
}

describe('handleInteractionRoutes —— /whisper 的 voiceTo（谁点的谁念）', () => {
  test('surface=web / desktop 原样落到 voiceTo', async () => {
    const web = harness(async () => ({ ok: true, text: '好' }));
    await web.call('?pet=main&surface=web');
    assert.equal(web.calls[0]?.voiceTo, 'web');

    const desktop = harness(async () => ({ ok: true, text: '好' }));
    await desktop.call('?pet=main&surface=desktop');
    assert.equal(desktop.calls[0]?.voiceTo, 'desktop');
  });

  test('surface=both / any 不足以指定一端 → 不传，交给 display 推导', async () => {
    for (const want of ['both', 'any']) {
      const probe = harness(async () => ({ ok: true, text: '好' }));
      await probe.call('?pet=main&surface=' + want);
      assert.equal(probe.calls[0]?.voiceTo, undefined, `surface=${want} 不该指定成一端`);
    }
  });
});

describe('handleInteractionRoutes —— /whisper 的指定配图', () => {
  test('带 ?image=：图名原样交给生成函数，成功应答照旧带回文本与图', async () => {
    const { calls, call } = harness(async (_petId, image) => ({ ok: true, text: '好呀', image }));
    const result = await call('?pet=main&image=' + encodeURIComponent('大的要来啦'));
    assert.deepEqual(
      calls,
      [{ petId: 'main', image: '大的要来啦', voiceTo: undefined }],
      '图名必须原样透传，不解码错位',
    );
    assert.equal((result as { obj: { image?: string } }).obj.image, '大的要来啦');
  });

  test('不带 ?image=：生成函数收到 undefined（随机/纯文本那条老路径）', async () => {
    const { calls, call } = harness(async () => ({ ok: true, text: '好呀' }));
    await call('?pet=main');
    assert.deepEqual(calls, [{ petId: 'main', image: undefined, voiceTo: undefined }]);
  });

  test('图不在池内：unknown-image 原样透出，不糊成 generate-error', async () => {
    const { call } = harness(async () => ({ ok: false, reason: 'unknown-image', message: '表情包不在池内：查无此图' }));
    const result = await call('?pet=main&image=' + encodeURIComponent('查无此图'));
    const body = (result as { status: number; obj: { ok: boolean; reason?: string } }).obj;
    assert.equal((result as { status: number }).status, 200, '业务失败沿用「HTTP 200 + 失败实体」');
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'unknown-image', '调用方按 reason 分支，不能被归一化掉');
  });
});
