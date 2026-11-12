/**
 * 天气图标几何的契约测试：27 个码都有图形、形状合法、两两不同，未知码回落成云。
 *
 * 只测几何数据，不渲染：同一份数据由 EnvBubble 映射成 SVG 节点（见 ../bubble.ts）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { envIconShapes } from './env-icon.ts';

/** Open-Meteo 会返回的全部天气码。 */
const CODES = [
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
];

describe('envIconShapes', () => {
  test('27 个码都有图形，且每段形状合法', () => {
    for (const code of CODES) {
      const shapes = envIconShapes(code);
      assert.ok(shapes.length > 0, code + ' 应有图形');
      for (const shape of shapes) {
        if (shape.kind === 'path') assert.ok(shape.d.length > 0, code + ' 的 path 不能为空');
        if (shape.kind === 'line') {
          assert.ok(
            [shape.x1, shape.y1, shape.x2, shape.y2].every((n) => Number.isFinite(n)),
            code + ' 的 line 坐标必须是数字',
          );
        }
        if (shape.kind === 'circle') {
          assert.ok(Number.isFinite(shape.cx) && Number.isFinite(shape.cy) && shape.r > 0, code + ' 的 circle 非法');
        }
      }
    }
  });

  test('27 个码两两不同：同组只靠线条数量/长度区分强度', () => {
    const seen = new Map<string, number>();
    for (const code of CODES) {
      const key = JSON.stringify(envIconShapes(code));
      const other = seen.get(key);
      assert.equal(other, undefined, `码 ${code} 与 ${other} 的图形完全一样`);
      seen.set(key, code);
    }
  });

  test('表外的码回落成云（与「阴」同形），不抛错', () => {
    assert.deepEqual(envIconShapes(1234), envIconShapes(3));
    assert.deepEqual(envIconShapes(-1), envIconShapes(3));
  });
});
