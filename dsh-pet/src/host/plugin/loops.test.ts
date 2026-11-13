/**
 * 梦话闸门的单元测试：关掉碎碎念、或配置上不显示时，睡眠期间也不生成。
 *
 * 钉住 #355：碎碎念循环有两道闸（宠物开关 + display），梦话循环原先一道都没有，
 * 于是 `whisperEnabled: false` 的宠物睡着时仍每拍调一次模型。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/loops.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldSleepTalk } from './loops.ts';

describe('shouldSleepTalk —— 梦话闸门', () => {
  test('开着碎碎念且可见：说梦话', () => {
    assert.equal(shouldSleepTalk({ whisperEnabled: true, display: 'web' }), true);
    assert.equal(shouldSleepTalk({ whisperEnabled: true, display: 'desktop' }), true);
    assert.equal(shouldSleepTalk({ whisperEnabled: true, display: 'both' }), true);
  });

  test('关掉碎碎念：一律不生成，与 display 无关', () => {
    assert.equal(shouldSleepTalk({ whisperEnabled: false, display: 'web' }), false);
    assert.equal(shouldSleepTalk({ whisperEnabled: false, display: 'both' }), false);
  });

  test('没写 whisperEnabled：按关闭处理，不默认开', () => {
    assert.equal(shouldSleepTalk({ display: 'web' }), false);
    assert.equal(shouldSleepTalk({ whisperEnabled: 'true', display: 'web' }), false, '非布尔值不算开启');
  });

  test('配置上不显示：开着碎碎念也不生成（#237 同一口径）', () => {
    assert.equal(shouldSleepTalk({ whisperEnabled: true, display: 'none' }), false);
    assert.equal(shouldSleepTalk({ whisperEnabled: true }), false, '缺 display 等于不可见');
  });
});
