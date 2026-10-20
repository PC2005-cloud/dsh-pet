/**
 * `?surface=`（调用方期望的显示端）的决策层单测 —— issue #122 第 1 条。
 *
 * 契约核心三条：
 *   1. 只认四个字面量，其余（缺省 / 大小写不符 / 空白 / 非字符串）一律 `null`；
 *   2. `display: none` **无条件不满足**，`any` 也不满足；
 *   3. `both` 只被 `both` 满足（它比"不传/any"更严，不是"哪端都行"的同义词）。
 *
 * 本模块只依赖两个字符串，可完全离线测。用 Node 内置 test runner，不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SURFACES, SURFACE_TEXT, displayCovers, normalizeSurface } from './surface.ts';

describe('normalizeSurface —— 取值收窄', () => {
  test('四个字面量原样通过', () => {
    for (const s of SURFACES) assert.equal(normalizeSurface(s), s);
  });

  test('缺省 / 非字符串 / 空串 / 大小写不符 / 空白 / 别的枚举值 → null', () => {
    for (const bad of [undefined, null, '', '   ', 'WEB', 'Web', 'Desktop', 'none', 'all', 42, true, {}, []]) {
      assert.equal(normalizeSurface(bad), null, JSON.stringify(bad) + ' 不应通过');
    }
  });
});

describe('displayCovers —— 4×4 匹配矩阵', () => {
  /** 期望表：display（行） × want（列） */
  const TABLE: Record<string, Record<string, boolean>> = {
    web: { web: true, desktop: false, both: false, any: true },
    desktop: { web: false, desktop: true, both: false, any: true },
    both: { web: true, desktop: true, both: true, any: true },
    none: { web: false, desktop: false, both: false, any: false },
  };

  test('四行全对：both 只被 both 满足；any 只被前三者满足；none 一律不满足', () => {
    for (const [display, row] of Object.entries(TABLE)) {
      for (const want of SURFACES) {
        assert.equal(displayCovers(want, display), row[want], `display=${display} want=${want}`);
      }
    }
  });

  test('display 非法（配置校验本该拦住）一律不满足，且不抛', () => {
    for (const bad of ['', 'nope', 'WEB', 'Both', 'undefined', ' web']) {
      for (const want of SURFACES) assert.equal(displayCovers(want, bad), false, `display=${bad} want=${want}`);
    }
  });
});

describe('SURFACE_TEXT —— 与文档共用同一句', () => {
  test('四个取值全部出现在文案里（改了取值集合这里会红）', () => {
    for (const s of SURFACES) assert.ok(SURFACE_TEXT.includes(s), '文案缺 ' + s);
  });
});
