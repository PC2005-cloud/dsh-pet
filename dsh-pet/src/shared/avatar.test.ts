/**
 * 头像地址拼装的契约测试：两个使用方（聊天面板、设置页）都靠它按素材根取图。
 *
 * 钉住三点：默认图不带查询串；带素材根一定编进 `root=`（不是 `pet=`，那是宠物实例 id）；
 * 版本号总在，换头像后才有新 URL 可拿。
 * 跑法：node --experimental-strip-types --test src/shared/avatar.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { avatarUrl, LOGO_URL } from './avatar.ts';
import { ROUTE_PATH } from './constants.ts';

describe('avatarUrl', () => {
  test('带素材根 → root= 与版本号都在', () => {
    assert.equal(avatarUrl('cat', 7), ROUTE_PATH + '/logo?root=cat&v=7');
  });

  test('空素材根 → 不带 root，只剩版本号', () => {
    assert.equal(avatarUrl('', 7), ROUTE_PATH + '/logo?v=7');
    assert.equal(avatarUrl('   ', 7), ROUTE_PATH + '/logo?v=7');
  });

  test('素材根里的中文与空格必须编码后才进查询串', () => {
    assert.equal(avatarUrl('小猫 pack', 1), ROUTE_PATH + '/logo?root=' + encodeURIComponent('小猫 pack') + '&v=1');
  });

  test('参数名用 root 而不是 pet（后者是宠物实例 id）', () => {
    assert.equal(avatarUrl('cat', 1).includes('pet='), false);
  });

  test('版本号不同 → URL 不同（破缓存靠这一点）', () => {
    assert.notEqual(avatarUrl('cat', 1), avatarUrl('cat', 2));
  });

  test('默认图地址就是不带查询串的 /logo', () => {
    assert.equal(LOGO_URL, ROUTE_PATH + '/logo');
  });
});
