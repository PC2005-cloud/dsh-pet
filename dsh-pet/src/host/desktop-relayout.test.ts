/** 桌面端切屏回归：复现远程连接时先合并双屏、再收窄主屏的事件顺序。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { rebaseCenter } from '../shared/displays.ts';
import { anchorPixel } from '../shared/motion.ts';

const script = readFileSync(new URL('../../runtime/electron-helper/sprite.js', import.meta.url), 'utf8');

for (const manual of [false, true]) {
  test(manual ? '切屏时保留手动位置，越界才夹回' : '切屏时按新主屏右下角和原边距定位', () => {
    const view = { x: 0, y: 0, w: 3840, h: 1032 };
    const left = { x: 0, y: 0, width: 1920, height: 1032 };
    const context = {
      navigator: { platform: 'Win32' },
      BASE: '',
      VIEW: view,
      AREAS: [left, { ...left, x: 1920 }],
      PRIMARY_AREA: left,
      S: { rebaseCenter, anchorPixel },
    };
    const sprite = Object.assign(Object.create(runInNewContext(script + '\nPetSprite.prototype', context)), {
      size: 320,
      halfW: 160,
      halfH: 90,
      pet: { position: { corner: 'bottom-right', marginX: 0, marginY: 60 } },
      customPos: manual ? { rx: 3000 / view.w, ry: 600 / view.h } : null,
      dragState: { active: false },
      throwRef: null,
      stopMove() {},
      sendBounds(x: number, y: number) {
        this.pos = { x, y };
      },
      pos: { x: 0, y: 0 },
    });
    sprite.position();
    for (const width of [3840, 1920]) {
      const prev = { ...view };
      view.w = width;
      context.PRIMARY_AREA = { ...left, width };
      context.AREAS = [context.PRIMARY_AREA];
      sprite.relayout(prev);
      const expectedX = manual ? Math.min(3000, width - 1) - 160 : width - 320;
      assert.deepEqual(sprite.pos, { x: expectedX, y: manual ? 510 : 792 });
      assert.equal(sprite.customPos === null, !manual);
    }
  });
}
