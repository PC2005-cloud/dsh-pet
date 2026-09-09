/**
 * 多显示器几何单测 —— 复现「主屏 + 上移副屏」布局下的骑缝 / 空洞问题。
 *
 * 布局取自实机（WinForms Screen.Bounds，DIP）：
 *   主屏  (0, 0, 2560, 1440)     work (0, 0, 2560, 1392)
 *   副屏  (2560, -621, 1234, 2194) work (2560, -621, 1234, 2146)
 * 外接矩形含主屏上方空洞；窗口若按外接矩形摆放会骑在 x=2560 上，两块屏同时合成。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canCrossWorkArea,
  displayWorkArea,
  fitWindowToDisplay,
  nearestDisplay,
  nearestRect,
  parseDisplays,
  throwBoundsForPet,
  throwBoundsOnDisplay,
  throwBoundsOpen,
  type DisplayInfo,
} from './displays.ts';

const PRIMARY: DisplayInfo = {
  x: 0,
  y: 0,
  width: 2560,
  height: 1440,
  workX: 0,
  workY: 0,
  workW: 2560,
  workH: 1392,
};
const SECONDARY: DisplayInfo = {
  x: 2560,
  y: -621,
  width: 1234,
  height: 2194,
  workX: 2560,
  workY: -621,
  workW: 1234,
  workH: 2146,
};
const DISPLAYS = [PRIMARY, SECONDARY];
const WORK = DISPLAYS.map(displayWorkArea);
const ORIGIN = { x: 0, y: -621 };

describe('parseDisplays', () => {
  it('reads injected JSON and drops invalid rows', () => {
    assert.deepEqual(parseDisplays(null), []);
    assert.deepEqual(parseDisplays('nope'), []);
    const list = parseDisplays(JSON.stringify([PRIMARY, { x: 'nope' }, SECONDARY]));
    assert.equal(list.length, 2);
    assert.equal(list[0].workW, 2560);
    assert.equal(list[1].y, -621);
  });
});

describe('nearestDisplay', () => {
  it('hits the display that contains the point', () => {
    assert.equal(nearestDisplay(100, 100, DISPLAYS), PRIMARY);
    assert.equal(nearestDisplay(3000, -100, DISPLAYS), SECONDARY);
  });

  it('maps the void above the primary to the nearest real screen', () => {
    const near = nearestRect(100, -300, WORK);
    assert.ok(near);
    assert.equal(near.x, 0);
    assert.equal(near.y, 0);
  });
});

describe('fitWindowToDisplay', () => {
  it('pulls a straddling window fully onto the screen that owns its center', () => {
    const fitted = fitWindowToDisplay({ x: 2400, y: 100, width: 924, height: 722 }, DISPLAYS);
    assert.equal(fitted.x, 2560);
    assert.equal(fitted.width, 924);
    assert.ok(fitted.x + fitted.width <= SECONDARY.x + SECONDARY.width);
    assert.ok(fitted.y >= SECONDARY.y);
  });

  it('does not move a window already inside the primary', () => {
    const win = { x: 100, y: 200, width: 924, height: 722 };
    assert.deepEqual(fitWindowToDisplay(win, DISPLAYS), win);
  });
});

describe('canCrossWorkArea', () => {
  it('allows crossing the shared bezel where the two work areas overlap in Y', () => {
    assert.equal(canCrossWorkArea(WORK[0], WORK, 2500, 400, 'right'), true);
    assert.equal(canCrossWorkArea(WORK[1], WORK, 2600, 400, 'left'), true);
  });

  it('blocks crossing into the void above the primary', () => {
    assert.equal(canCrossWorkArea(WORK[1], WORK, 2600, -300, 'left'), false);
  });
});

describe('throwBoundsOpen', () => {
  it('opens the primary right edge and keeps the other three walls', () => {
    const b = throwBoundsOpen({
      current: WORK[0],
      displays: WORK,
      originX: ORIGIN.x,
      originY: ORIGIN.y,
      size: 462,
      sideAllow: 80,
      screenCX: 2400,
      screenCY: 400,
    });
    assert.equal(b.maxX, Number.POSITIVE_INFINITY);
    assert.ok(Number.isFinite(b.minX));
    assert.ok(Number.isFinite(b.minY));
    assert.ok(Number.isFinite(b.maxY));
  });

  it('keeps the secondary left wall when the pet is in the void-adjacent band', () => {
    const b = throwBoundsOpen({
      current: WORK[1],
      displays: WORK,
      originX: ORIGIN.x,
      originY: ORIGIN.y,
      size: 462,
      sideAllow: 80,
      screenCX: 2700,
      screenCY: -300,
    });
    assert.ok(Number.isFinite(b.minX));
    const closed = throwBoundsOnDisplay({
      display: WORK[1],
      originX: ORIGIN.x,
      originY: ORIGIN.y,
      size: 462,
      sideAllow: 80,
    });
    assert.equal(b.minX, closed.minX);
  });
});

describe('throwBoundsForPet', () => {
  it('returns null on a single display so the caller keeps the AABB path', () => {
    assert.equal(
      throwBoundsForPet({
        displays: [PRIMARY],
        originX: 0,
        originY: 0,
        size: 462,
        sideAllow: 80,
        petX: 100,
        petY: 100,
        halfW: 231,
        halfH: 130,
      }),
      null,
    );
  });

  it('opens the bezel when the pet center is still on the primary', () => {
    // screen (2400, 400) 在主屏工作区内，贴右缝
    const b = throwBoundsForPet({
      displays: DISPLAYS,
      originX: ORIGIN.x,
      originY: ORIGIN.y,
      size: 462,
      sideAllow: 80,
      petX: 2400 - 231 - ORIGIN.x,
      petY: 400 - 130 - ORIGIN.y,
      halfW: 231,
      halfH: 130,
    });
    assert.ok(b);
    assert.equal(b.maxX, Number.POSITIVE_INFINITY);
  });

  it('walls the secondary left edge in the void-adjacent band', () => {
    const b = throwBoundsForPet({
      displays: DISPLAYS,
      originX: ORIGIN.x,
      originY: ORIGIN.y,
      size: 462,
      sideAllow: 80,
      petX: 2700 - 231 - ORIGIN.x,
      petY: -300 - 130 - ORIGIN.y,
      halfW: 231,
      halfH: 130,
    });
    assert.ok(b);
    assert.ok(Number.isFinite(b.minX));
  });
});
