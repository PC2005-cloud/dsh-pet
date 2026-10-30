/**
 * `?surface=`（调用方期望的显示端）的决策层单测 —— issue #122 第 1 条。
 *
 * 契约核心三条：
 *   1. 只认四个字面量，其余（缺省 / 大小写不符 / 空白 / 非字符串）一律 `null`；
 *   2. `display: none` 无条件不满足，`any` 也不满足；
 *   3. `both` 只被 `both` 满足（它比"不传/any"更严，不是"哪端都行"的同义词）。
 *
 * 本模块只依赖两个字符串，可完全离线测。用 Node 内置 test runner，不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SURFACES,
  SURFACE_TEXT,
  displayCovers,
  isDisplayed,
  normalizeSurface,
  pickVoiceSurface,
  voiceTargetOfSurface,
} from './surface.ts';

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
    none: { web: false, desktop: false, both: false, any: true },
  };

  test('四行全对：both 只被 both 满足；any 不挑显示模式（none 也放行）', () => {
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

describe('isDisplayed —— 任一端可见即算显示', () => {
  test('web / desktop / both 可见，none 与非法值不可见', () => {
    for (const display of ['web', 'desktop', 'both']) {
      assert.equal(isDisplayed(display), true, `display=${display} 应在某端可见`);
    }
    for (const display of ['none', '', 'nope', 'Both']) {
      assert.equal(isDisplayed(display), false, `display=${display} 不应算可见`);
    }
  });
});

describe('pickVoiceSurface —— 这一句该由哪一端念', () => {
  test('桌面优先：both → desktop，desktop → desktop', () => {
    assert.equal(pickVoiceSurface('both'), 'desktop', '两端都显示时交给桌面端');
    assert.equal(pickVoiceSurface('desktop'), 'desktop');
  });

  test('只在网页显示 → web', () => {
    assert.equal(pickVoiceSurface('web'), 'web');
  });

  test('两端都不显示 / 非法值 → null（不该有人念）', () => {
    for (const display of ['none', '', 'nope']) {
      assert.equal(pickVoiceSurface(display), null, `display=${display} 不应挑出一端`);
    }
  });
});

describe('voiceTargetOfSurface —— 请求面落成该由哪一端念', () => {
  test('具体的一端原样落地', () => {
    assert.equal(voiceTargetOfSurface('web'), 'web');
    assert.equal(voiceTargetOfSurface('desktop'), 'desktop');
  });

  test('both / any 不足以指定一端 → undefined（交回 display 推导）', () => {
    assert.equal(voiceTargetOfSurface('both'), undefined);
    assert.equal(voiceTargetOfSurface('any'), undefined);
  });
});

describe('SURFACE_TEXT —— 与文档共用同一句', () => {
  test('四个取值全部出现在文案里（改了取值集合这里会红）', () => {
    for (const s of SURFACES) assert.ok(SURFACE_TEXT.includes(s), '文案缺 ' + s);
  });
});
