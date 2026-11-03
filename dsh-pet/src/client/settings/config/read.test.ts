/**
 * 成品配置读取的契约测试。
 *
 * 三条契约：
 *   1. 坏响应要显式失败：`main.pets` 缺失或不是数组时返回 `null`，让调用方报错而不是渲染半张空表单；
 *   2. 没写或写成坏值的字段不出现在补丁里，表单保留自己手里的值，绝不拿坏数据覆盖；
 *   3. 成品里已填满的段落（物理参数、字体）缺子键时用内置默认补满，读出来的始终是完整对象。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { readConfigEntries, readMainConfig } from './read.ts';
import { DEFAULT_PHYSICS } from '../../../shared/physics.ts';
import { DEFAULT_FONT } from '../../../shared/fonts.ts';

describe('readMainConfig —— 成品聚合 → 表单补丁', () => {
  test('main.pets 缺失或不是数组：返回 null（响应坏了）', () => {
    assert.equal(readMainConfig({}), null);
    assert.equal(readMainConfig({ main: {} }), null);
    assert.equal(readMainConfig({ main: { pets: 'oops' } }), null);
  });

  test('pets 深拷贝位置：编辑列表与成品列表是两份数据', () => {
    const merged = {
      main: { pets: [{ id: 'pet-1', position: { corner: 'top-left', marginX: 1, marginY: 2 } }] },
    };
    const patch = readMainConfig(merged);
    assert.ok(patch?.pets);
    patch.pets[0].position.marginX = 99;
    assert.equal(merged.main.pets[0].position.marginX, 1, '不允许共享同一份 position 对象');
  });

  test('物理参数与字体：成品缺子键时用内置默认补满', () => {
    const patch = readMainConfig({ main: { pets: [], physics: { gravity: 3 }, font: { size: 20 } } });
    assert.deepEqual(patch?.physics, { ...DEFAULT_PHYSICS, gravity: 3 });
    assert.deepEqual(patch?.font, { ...DEFAULT_FONT, size: 20 });
  });

  test('动作频率权重：三项非负数字才带出，坏值当作没写', () => {
    const patch = readMainConfig({ main: { pets: [], animationWeights: { idle: 30, turn: 5, move: 5 } } });
    assert.deepEqual(patch?.animationWeights, { idle: 30, turn: 5, move: 5 });
    assert.equal('animationWeights' in (readMainConfig({ main: { pets: [] } }) ?? {}), false);
    assert.equal(
      'animationWeights' in
        (readMainConfig({ main: { pets: [], animationWeights: { idle: -1, turn: 5, move: 5 } } }) ?? {}),
      false,
      '负数当作没写',
    );
  });

  test('模型选择只写一半：整对都当没写（宿主会按非法拒绝）', () => {
    const half = readMainConfig({ main: { pets: [], whisperModel: { provider: 'openai' } } });
    assert.equal(half?.whisperModel, undefined);
    const full = readMainConfig({ main: { pets: [], chatModel: { provider: 'a', model: 'b' } } });
    assert.deepEqual(full?.chatModel, { provider: 'a', model: 'b' });
  });

  test('数值字段：负数与非数字当没写，0 是合法值', () => {
    assert.equal(readMainConfig({ main: { pets: [], chatMemoryRounds: -1 } })?.chatMemoryRounds, undefined);
    assert.equal(readMainConfig({ main: { pets: [], chatMemoryRounds: 'x' } })?.chatMemoryRounds, undefined);
    assert.equal(readMainConfig({ main: { pets: [], chatImageLimit: 0 } })?.chatImageLimit, 0);
  });

  test('布尔字段缺失就不进补丁，避免把默认值当用户选择写回去', () => {
    const patch = readMainConfig({ main: { pets: [] } });
    assert.equal('notificationsEnabled' in (patch ?? {}), false);
    assert.equal('trayEnabled' in (patch ?? {}), false);
    const withFlag = readMainConfig({ main: { pets: [], trayEnabled: false } });
    assert.equal(withFlag?.trayEnabled, false);
  });

  test('语音细分开关：布尔原样带出，缺失或非布尔不进补丁', () => {
    const patch = readMainConfig({ main: { pets: [], voiceWhisperEnabled: true, voiceTodoEnabled: false } });
    assert.equal(patch?.voiceWhisperEnabled, true);
    assert.equal(patch?.voiceTodoEnabled, false, 'false 是合法值，不能当作没写');
    const none = readMainConfig({ main: { pets: [] } });
    assert.equal('voiceWhisperEnabled' in (none ?? {}), false);
    assert.equal('voiceTodoEnabled' in (none ?? {}), false);
    const bad = readMainConfig({ main: { pets: [], voiceTodoEnabled: 'yes' } });
    assert.equal('voiceTodoEnabled' in (bad ?? {}), false, '非布尔当作没写');
  });

  test('对话动作联动开关：布尔原样带出，缺失或非布尔不进补丁', () => {
    assert.equal(readMainConfig({ main: { pets: [], chatAnimationEnabled: false } })?.chatAnimationEnabled, false);
    assert.equal('chatAnimationEnabled' in (readMainConfig({ main: { pets: [] } }) ?? {}), false);
    assert.equal(
      'chatAnimationEnabled' in (readMainConfig({ main: { pets: [], chatAnimationEnabled: 1 } }) ?? {}),
      false,
      '非布尔当作没写',
    );
  });

  test('条目人设原样带出，供「留空时跟随什么」的预览', () => {
    assert.equal(readMainConfig({ main: { pets: [], whisperPrompt: '条目人设' } })?.entryPrompt, '条目人设');
  });
});

describe('readConfigEntries —— 成品聚合 → 条目实例列表', () => {
  test('按条目拍平：main 在前，文件宠物带 assetRoot 与 pack 标记', () => {
    const entries = readConfigEntries({
      main: { pets: [{ id: 'm1', position: { corner: 'top-left', marginX: 0, marginY: 0 } }] },
      glm: { pets: [{ id: 'g1', position: { corner: 'top-right', marginX: 1, marginY: 2 } }] },
    });
    assert.deepEqual(
      entries?.map((entry) => [entry.key, entry.kind]),
      [
        ['main', 'main'],
        ['glm', 'pack'],
      ],
    );
    assert.equal(entries?.[1].pets[0].assetRoot, 'glm', '实例要记住自己属于哪个种类');
  });

  test('位置深拷贝：编辑列表与成品列表是两份数据', () => {
    const merged = { main: { pets: [{ id: 'm1', position: { corner: 'top-left', marginX: 1, marginY: 2 } }] } };
    const entries = readConfigEntries(merged);
    assert.ok(entries);
    entries[0].pets[0].position.marginX = 99;
    assert.equal(merged.main.pets[0].position.marginX, 1, '不允许共享同一份 position 对象');
  });

  test('不把条目级大对象挂到实例上（提交体不该被动画池撑大）', () => {
    const entries = readConfigEntries({
      main: {
        pets: [{ id: 'm1', position: { corner: 'top-left', marginX: 0, marginY: 0 } }],
        animations: { idle: ['x'] },
      },
    });
    assert.equal('animations' in (entries?.[0].pets[0] ?? {}), false);
  });

  test('main.pets 缺失或不是数组：返回 null（响应坏了）', () => {
    assert.equal(readConfigEntries({}), null);
    assert.equal(readConfigEntries({ main: {} }), null);
    assert.equal(readConfigEntries({ main: { pets: 'oops' } }), null);
  });

  test('条目人设各自带出：pack 跟随自己种类那份，不共用 main 的', () => {
    const entries = readConfigEntries({
      main: { pets: [], whisperPrompt: '主宠物人设' },
      glm: { pets: [], whisperPrompt: 'GLM 人设' },
    });
    assert.equal(entries?.[0].entryPrompt, '主宠物人设');
    assert.equal(entries?.[1].entryPrompt, 'GLM 人设');
  });
});
