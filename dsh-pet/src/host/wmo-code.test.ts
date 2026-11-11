/** WMO 码表的契约测试：常用码有中文说法，未收录的码不猜。 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { wmoText } from './wmo-code.ts';

describe('wmoText', () => {
  test('常用码映射成中文：晴 / 阴 / 小雨 / 雷阵雨', () => {
    assert.equal(wmoText(0), '晴');
    assert.equal(wmoText(3), '阴');
    assert.equal(wmoText(61), '小雨');
    assert.equal(wmoText(95), '雷阵雨');
  });

  test('未收录的码返回“未知天气”，不臆造说法', () => {
    assert.equal(wmoText(1234), '未知天气');
    assert.equal(wmoText(-1), '未知天气');
  });
});
