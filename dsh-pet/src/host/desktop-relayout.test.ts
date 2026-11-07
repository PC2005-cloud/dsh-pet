/**
 * 桌面端切屏回归：复现远程连接时「双屏 → 临时 3840 宽主屏 → 收窄为 1920」的事件序列。
 *
 * 为什么加载真脚本而不是抽纯函数：问题出在 `relayout` 与 `position()`、`anchorPixel` 的联动上——
 * 夹取结果被写成自定义位置，纯函数测不出这层接线。这里用 node:vm 起一份干净全局，驱动真实的
 * `sprite.js`，断言的是行为（位置与 customPos），不是源码文本。
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { rebaseCenter } from '../shared/displays.ts';
import { anchorPixel } from '../shared/motion.ts';

/** 工作区高度：1080 减 48px 任务栏。 */
const AREA_HEIGHT = 1032;
/** 宠物宽度（与本 issue 的配置同量级）。 */
const PET_SIZE = 320;
/** 本体高度按 16:9 算，与 {@link anchorPixel} 的口径一致。 */
const PET_HEIGHT = (PET_SIZE * 9) / 16;

/** 视口：经典脚本里 VIEW 的形状。 */
interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 工作区：经典脚本里 AREAS / PRIMARY_AREA 元素的形状。 */
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 被测脚本会用到的那部分实例状态。 */
interface Sprite {
  pos: { x: number; y: number };
  customPos: { rx: number; ry: number } | null;
  position(): void;
  relayout(prevView: ViewRect): void;
}

const script = readFileSync(new URL('../../runtime/electron-helper/sprite.js', import.meta.url), 'utf8');

/**
 * 造一只装在 vm 里的宠物，并用变宽的主屏模拟远程桌面接入/断开。
 *
 * @param manual - 是否已有自定义位置（用户拖过或抛过）。
 * @returns 宠物实例、当前视口，以及把主屏换成单块 `width` 宽工作区的动作。
 */
function loadSprite(manual: boolean): {
  sprite: Sprite;
  view: ViewRect;
  setPrimary(width: number): void;
} {
  const view: ViewRect = { x: 0, y: 0, w: 3840, h: AREA_HEIGHT };
  const left: Area = { x: 0, y: 0, width: 1920, height: AREA_HEIGHT };
  const context: Record<string, unknown> = {
    navigator: { platform: 'Win32', userAgent: 'test' },
    BASE: '',
    VIEW: view,
    AREAS: [left, { ...left, x: left.width }],
    PRIMARY_AREA: left,
    S: { rebaseCenter, anchorPixel },
  };
  const proto = runInNewContext(script + '\nPetSprite.prototype', context) as object;
  const sprite = Object.create(proto) as Sprite;
  // 只补 position()/relayout() 真正读到的状态：vm 里的方法按属性随时现取，补齐即可跑。
  Object.assign(sprite as unknown as Record<string, unknown>, {
    size: PET_SIZE,
    halfW: PET_SIZE / 2,
    halfH: PET_HEIGHT / 2,
    pet: { position: { corner: 'bottom-right', marginX: 0, marginY: 60 } },
    customPos: manual ? { rx: 3000 / view.w, ry: 600 / AREA_HEIGHT } : null,
    dragState: { active: false },
    throwRef: null,
    pos: { x: 0, y: 0 },
    stopMove: (): void => undefined,
    sendBounds: (x: number, y: number): void => {
      sprite.pos = { x, y };
    },
  });
  sprite.position();
  const setPrimary = (width: number): void => {
    const area: Area = { x: 0, y: 0, width, height: AREA_HEIGHT };
    context.AREAS = [area];
    context.PRIMARY_AREA = area;
    view.w = width;
  };
  return { sprite, view, setPrimary };
}

test('切屏：角落模式按新主屏的角落与边距重算，不写自定义位置', () => {
  const { sprite, view, setPrimary } = loadSprite(false);
  assert.deepEqual(
    sprite.pos,
    { x: 1920 - PET_SIZE, y: AREA_HEIGHT - PET_HEIGHT - 60 },
    '起点：双屏时落在主屏右下角，边距 0/60',
  );

  const before = { ...view };
  setPrimary(3840); // 远程接入：两块屏被合成一块 3840 宽的临时主屏
  sprite.relayout(before);
  assert.deepEqual(sprite.pos, { x: 3840 - PET_SIZE, y: AREA_HEIGHT - PET_HEIGHT - 60 }, '临时主屏：跟随到它的右下角');

  const wide = { ...view };
  setPrimary(1920); // 约 4 秒后收窄回单屏
  sprite.relayout(wide);
  assert.deepEqual(
    sprite.pos,
    { x: 1920 - PET_SIZE, y: AREA_HEIGHT - PET_HEIGHT - 60 },
    '收窄后必须回到配置的角落与边距，而不是停在右边缘',
  );
  assert.equal(sprite.customPos, null, '夹取结果不能被记成自定义位置');
});

test('切屏：自定义位置保留桌面坐标，越界才夹回可见区', () => {
  const { sprite, view, setPrimary } = loadSprite(true);
  assert.deepEqual(sprite.pos, { x: 3000 - PET_SIZE / 2, y: 600 - PET_HEIGHT / 2 }, '起点：中心在 (3000, 600)');

  const before = { ...view };
  setPrimary(3840);
  sprite.relayout(before);
  assert.deepEqual(sprite.pos, { x: 3000 - PET_SIZE / 2, y: 600 - PET_HEIGHT / 2 }, '临时主屏：世界坐标不变');

  const wide = { ...view };
  setPrimary(1920);
  sprite.relayout(wide);
  assert.deepEqual(sprite.pos, { x: 1919 - PET_SIZE / 2, y: 600 - PET_HEIGHT / 2 }, '超出新主屏后夹回右边缘');
  assert.notEqual(sprite.customPos, null, '自定义位置在会话内继续有效');
});
