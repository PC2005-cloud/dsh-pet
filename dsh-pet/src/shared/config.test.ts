/**
 * 成品 → 渲染列表的契约测试：条目级字段只有**一处**填充点（flattenConfigPets）。
 *
 * 背景：animations / animationWeights / eventsRefreshSec / physics / confineToScreen / workStatusTexts 这六个条目级字段
 * 必须由 flattenConfigPets 从「条目」吹进每只实例。客户端曾经还有第二份手抄的填充——设置页保存后把
 * 可编辑的裸实例列表回推给容器时"补吹"一遍——它漏掉了 physics：新增宠物或恢复默认后该实例的
 * physics 是 undefined，拖拽跟手第一帧读 cfg.physics.throwPower 直接抛错（表现为宠物完全拖不动）。
 * 现在设置页改用 host 写接口返回的成品聚合重新拍平，第二份实现已删除（见 petBridge.reload）。
 * 本文件把这条不变式钉住：
 *   ① 成品经 flattenConfigPets 后，每只实例的条目级字段齐全（可执行的契约，用真实内置默认配置）；
 *   ② 客户端不得再出现"手抄条目级字段"的填充、host 写接口必须返回成品聚合（源码级守卫——
 *      src/client/pet.ts 依赖 React/DOM，无法在 node 中导入，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { flattenConfigPets } from './config.ts';
import { readAllConfig } from '../host/config.ts';
import type { Pet } from './types.ts';

/** 条目级字段清单：客户端渲染直接消费，缺一不可 */
const ENTRY_FIELDS: Array<keyof Pet> = [
  'animations',
  'animationWeights',
  'eventsRefreshSec',
  'physics',
  'confineToScreen',
  'workStatusTexts',
];

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('flattenConfigPets —— 成品 → 渲染列表的唯一填充点', () => {
  test('真实内置默认配置：每只实例的条目级字段齐全（含 physics.throwPower）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-flatten-'));
    try {
      const merged = readAllConfig({
        defaultFile: fileURLToPath(new URL('../../assets/config.jsonc', import.meta.url)),
        userFile: join(dir, 'main-config.json'), // 不存在：只测内置默认
        petDir: join(dir, 'pet'), // 不存在：不掺文件宠物
      });
      const pets = flattenConfigPets(merged);
      assert.ok(pets.length > 0, '内置默认配置应至少有一只宠物');
      for (const p of pets) {
        for (const field of ENTRY_FIELDS) {
          assert.ok(p[field] !== undefined, `宠物「${String(p.id)}」缺条目级字段 ${field}`);
        }
        // 拖拽跟手第一帧读的就是它；缺失即 TypeError（本文件存在的直接原因）
        const physics = p.physics as { throwPower?: unknown };
        assert.equal(typeof physics.throwPower, 'number', 'physics.throwPower 必须是数字');
        // animations 是 { idle/turn/drag/clicks/moves/categories/events } 段：待机池必须非空
        const animations = p.animations as { idle?: unknown };
        assert.ok(Array.isArray(animations.idle) && animations.idle.length > 0, 'animations.idle 应为非空待机动画池');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('条目级字段的来源是「条目」而非实例：实例写同名值也不生效（唯一来源 = conf）', () => {
    const merged = {
      main: {
        physics: { throwPower: 7 },
        animations: ['a.webm'],
        pets: [{ id: 'x', physics: { throwPower: 1 } }],
      },
    };
    const [pet] = flattenConfigPets(merged as Record<string, Record<string, unknown>>);
    assert.deepEqual(pet.physics, { throwPower: 7 });
    assert.deepEqual(pet.animations, ['a.webm']);
  });

  test('源码守卫：客户端只有这一处填充，host 的写接口返回成品聚合', () => {
    const clientPet = readSource('../client/pet.ts');
    const clientSettings = readSource('../client/settings.ts');
    const host = readSource('../host/index.ts');

    // ① 旧的手抄填充（mc.<字段> 映射）、以及"设置页回推列表"这条旁路，都不得复活
    assert.ok(
      !/petBridge\.sync/.test(clientPet + clientSettings),
      'petBridge.sync 已删除：设置页不得再把"可编辑的裸实例列表"回推给容器（那正是漏吹 physics 的来源）',
    );
    for (const field of ENTRY_FIELDS) {
      assert.ok(
        !new RegExp(`${field}:\\s*mc\\.`).test(clientPet),
        `客户端不得手抄条目级字段 ${field}——它只应由 flattenConfigPets 从成品吹入`,
      );
    }
    // ② 容器必须经 flattenConfigPets 拿条目级字段
    assert.ok(/flattenConfigPets/.test(clientPet), '容器必须用 flattenConfigPets 拍平成品聚合');
    // ③ host 的 GET / PUT / DELETE /config 都返回成品聚合——设置页拿写接口的响应直接拍平，不自己拼字段
    const returns = host.match(/obj: readAllConfig\(configPaths\)/g) ?? [];
    assert.equal(returns.length, 3, 'GET / PUT / DELETE /config 都应返回成品聚合（obj: readAllConfig(configPaths)）');
    assert.ok(
      !/obj: \{ ok: true \}/.test(host),
      'config 写接口不得再返回 { ok: true }：响应体必须是成品聚合（设置页即时生效靠它拍平）',
    );
  });
});
