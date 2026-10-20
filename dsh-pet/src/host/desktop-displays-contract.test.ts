/**
 * 多显示器几何在打包形态下的接线契约（ticket 03）。
 *
 * 打包形态与开发形态跑的是**同一份** `runtime/electron-helper/main.js`（打包入口
 * desktop/main.mjs 直接 require 它），所以这里钉的是两条跨进程约定：
 *   1. `deskGeometry()` 必须复用 `desktop-geometry.js` 的 `buildDeskGeometry`，不能另写一套；
 *   2. 显示器热更新必须把同一份几何经 `pet:displays` 推给渲染端，渲染端就地
 *      `applyDeskGeometry` + `relayout()` —— 这样「改分辨率/插拔屏/注入双屏」才会实时生效。
 *
 * 边界判定本身（不规则布局、外接矩形空洞、负原点、任务栏条带）由
 * `src/host/desktop-geometry.test.ts` 与 `src/shared/displays.test.ts` 覆盖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function readHelperFile(relative: string): string {
  return readFileSync(new URL(`../../runtime/electron-helper/${relative}`, import.meta.url), 'utf8');
}

const mainSource = readHelperFile('main.js');
const rendererSource = readHelperFile('renderer.js');
const spriteSource = readHelperFile('sprite.js');
const constantsSource = readHelperFile('constants.js');

describe('多显示器几何 —— 打包形态仍走同一套纯函数', () => {
  test('deskGeometry() 用 screen.getAllDisplays + 主屏 id 调用 buildDeskGeometry', () => {
    assert.match(mainSource, /require\(['"]\.\/desktop-geometry\.js['"]\)/);
    assert.match(mainSource, /function deskGeometry\(\)\s*\{[^}]*buildDeskGeometry\(/s);
    assert.match(mainSource, /buildDeskGeometry\(screen\.getAllDisplays\(\),\s*screen\.getPrimaryDisplay\(\)\.id/);
    assert.match(mainSource, /process\.platform/);
  });

  test('显示器变化经 pet:displays 推给渲染端，渲染端 applyDeskGeometry + relayout', () => {
    assert.match(mainSource, /webContents\.send\(['"]pet:displays['"],\s*geo\)/);
    assert.match(
      rendererSource,
      /window\.petBridge\.onDisplays\(\(geo\)\s*=>\s*\{[\s\S]{0,200}applyDeskGeometry\(geo\)[\s\S]{0,200}relayout\(\)/,
    );
  });

  test('渲染端边界判定走逐屏工作区并集（不是外接矩形）', () => {
    // relayout / 归一化落点必须把中心夹到 AREAS 并集；外接矩形只做坐标系原点
    assert.match(spriteSource, /clampPointToRegion\(AREAS/);
    assert.match(constantsSource, /AREAS = S\.translateRects\([\s\S]{0,300}-VIEW\.x,\s*-VIEW\.y/);
  });
});
