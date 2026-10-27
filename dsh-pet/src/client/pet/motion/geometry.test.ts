/**
 * 宠物盒几何（src/client/pet/motion/geometry.ts）的契约测试：中心与包围盒两个方向互逆、
 * 度量随宽度线性缩放、命中区按画布换算，以及舞台与根节点的内联样式。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { HIT_BOX } from '../../../shared/constants.ts';
import {
  boxToRatio,
  centerToBox,
  clampPetBox,
  derivePetMetrics,
  PET_HIT_STYLE,
  petRootStyle,
  petStageStyle,
} from './geometry.ts';

const viewport = { width: 1280, height: 800 };
const half = { w: 130, h: 73 };

describe('centerToBox / boxToRatio —— 中心与包围盒换算', () => {
  test('中心→左上角：减去各自的半宽半高', () => {
    assert.deepEqual(centerToBox({ rx: 0.5, ry: 0.5 }, viewport, half), { x: 640 - 130, y: 400 - 73 });
  });

  test('互逆：来回换算还原同一个中心（松手不跳位）', () => {
    for (const center of [
      { rx: 0.12, ry: 0.34 },
      { rx: 0.5, ry: 0.5 },
      { rx: 0.999, ry: 0.001 },
    ]) {
      const back = boxToRatio(centerToBox(center, viewport, half), viewport, half);
      assert.ok(Math.abs(back.rx - center.rx) < 1e-9, `rx 应还原：${back.rx}`);
      assert.ok(Math.abs(back.ry - center.ry) < 1e-9, `ry 应还原：${back.ry}`);
    }
  });

  test('宽高不等：半高不会混进横向换算', () => {
    const box = centerToBox({ rx: 0.5, ry: 0.5 }, viewport, half);
    assert.equal(box.x, viewport.width / 2 - half.w);
    assert.equal(box.y, viewport.height / 2 - half.h);
  });

  test('比例 0 / 1：允许盒一半出屏，不做夹取', () => {
    assert.deepEqual(centerToBox({ rx: 0, ry: 0 }, viewport, half), { x: -half.w, y: -half.h });
    assert.deepEqual(centerToBox({ rx: 1, ry: 1 }, viewport, half), {
      x: viewport.width - half.w,
      y: viewport.height - half.h,
    });
  });
});

describe('derivePetMetrics —— 由宽度推出盒子度量', () => {
  test('半宽半高：保持 16:9 盒的一半', () => {
    const m = derivePetMetrics(462);
    assert.equal(m.halfW, 231);
    assert.ok(Math.abs(m.halfH / m.halfW - 9 / 16) < 1e-9, `半高半宽之比应为 9/16：${m.halfH / m.halfW}`);
  });

  test('线性缩放：宽度翻倍，四个量都翻倍', () => {
    const one = derivePetMetrics(300);
    const two = derivePetMetrics(600);
    for (const key of ['halfW', 'halfH', 'bottomPad', 'sideAllow'] as const) {
      assert.ok(Math.abs(two[key] - one[key] * 2) < 1e-9, `${key} 应随宽度线性缩放`);
    }
  });

  test('脚底垫高小于半高：脚垫只吃掉盒底的一条留白', () => {
    const m = derivePetMetrics(462);
    assert.ok(m.bottomPad > 0 && m.bottomPad < m.halfH, `bottomPad=${m.bottomPad} 应落在 (0, halfH=${m.halfH})`);
  });

  test('左右余量小于半宽：贴边的是身体，不是整只透明盒', () => {
    const m = derivePetMetrics(462);
    assert.ok(m.sideAllow > 0 && m.sideAllow < m.halfW, `sideAllow=${m.sideAllow} 应落在 (0, halfW=${m.halfW})`);
  });

  test('零宽：四个量都退化为 0，不产出 NaN', () => {
    const m = derivePetMetrics(0);
    assert.deepEqual(m, { halfW: 0, halfH: 0, bottomPad: 0, sideAllow: 0 });
  });
});

describe('clampPetBox —— 静止身体命中区留在视口内', () => {
  test('四边与四角越界：把身体贴回视口边缘，允许视频透明留白越界', () => {
    const viewport = { width: 1280, height: 800 };
    for (const x of [-2000, 100, 2000]) {
      for (const y of [-2000, 100, 2000]) {
        assert.deepEqual(clampPetBox({ x, y }, viewport, 640), {
          x: x < 0 ? -200 : Math.min(x, 840),
          y: y < 0 ? -80 : Math.min(y, 435),
        });
      }
    }
  });

  test('命中区恰好贴边：不改变原地放下的位置', () => {
    for (const box of [
      { x: -200, y: -80 },
      { x: 840, y: 435 },
      { x: 300, y: 200 },
    ]) {
      assert.deepEqual(clampPetBox(box, viewport, 640), box);
    }
  });

  test('462px 宠物：静止舞台的脚垫计入底部边界', () => {
    const box = clampPetBox({ x: 2000, y: 2000 }, viewport, 462);
    assert.equal(box.x, 962.375);
    assert.equal(box.y, 536.515625);
    const { bottomPad } = derivePetMetrics(462);
    assert.equal(box.x + (440 / 640) * 462, viewport.width);
    assert.equal(box.y + (335 / 640) * 462 + bottomPad, viewport.height);
  });

  test('视口比身体还小：各轴居中，保留最大可点击面积', () => {
    const tiny = { width: 100, height: 100 };
    const placed = clampPetBox({ x: 2000, y: -2000 }, tiny, 640);
    assert.deepEqual(placed, { x: -270, y: -172.5 });
    assert.deepEqual(clampPetBox(placed, tiny, 640), placed);
    assert.equal((placed.x + 200 + placed.x + 440) / 2, tiny.width / 2);
    assert.equal((placed.y + 80 + placed.y + 365) / 2, tiny.height / 2);
  });

  test('只有纵向容不下身体：横向仍按原地放下的位置夹取', () => {
    assert.deepEqual(clampPetBox({ x: 300, y: 2000 }, { width: 1280, height: 100 }, 640), {
      x: 300,
      y: -172.5,
    });
  });
});

describe('petStageStyle —— 舞台位移', () => {
  test('拖拽中：取消脚垫位移，视频贴指针走', () => {
    assert.deepEqual(petStageStyle(true, 21.6), { transform: 'none' });
  });

  test('静止：按脚垫上移，让脚底落在命中框底边', () => {
    assert.deepEqual(petStageStyle(false, 21.6), { transform: 'translateY(21.6px)' });
  });
});

describe('petRootStyle —— 根节点定位', () => {
  test('未拖拽：返回空对象，位置交给角落与边距的 CSS 变量', () => {
    assert.deepEqual(petRootStyle(null, viewport, { w: 231, h: 130 }), {});
  });

  test('已拖拽：按归一化中心换算出左上角，并把另一侧归零', () => {
    assert.deepEqual(petRootStyle({ rx: 0.5, ry: 0.25 }, viewport, { w: 231, h: 130 }), {
      left: 640 - 231 + 'px',
      top: 200 - 130 + 'px',
      right: 'auto',
      bottom: 'auto',
    });
  });

  test('不做边界夹取：比例 0 / 1 允许盒一半出屏', () => {
    assert.equal(petRootStyle({ rx: 0, ry: 0 }, viewport, { w: 231, h: 130 }).left, -231 + 'px');
    assert.equal(petRootStyle({ rx: 1, ry: 1 }, viewport, { w: 231, h: 130 }).top, 800 - 130 + 'px');
  });
});

describe('PET_HIT_STYLE —— 命中区换算成百分比', () => {
  test('四个百分比与命中框在 640×360 画布上一致', () => {
    assert.deepEqual(PET_HIT_STYLE, {
      left: (HIT_BOX.x0 / 640) * 100 + '%',
      top: (HIT_BOX.y0 / 360) * 100 + '%',
      width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + '%',
      height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + '%',
    });
  });

  test('命中框不越出宠物盒', () => {
    const left = parseFloat(PET_HIT_STYLE.left as string);
    const top = parseFloat(PET_HIT_STYLE.top as string);
    const width = parseFloat(PET_HIT_STYLE.width as string);
    const height = parseFloat(PET_HIT_STYLE.height as string);
    assert.ok(left >= 0 && top >= 0, '左上角应在盒内');
    assert.ok(left + width <= 100 + 1e-9 && top + height <= 100 + 1e-9, '右下角应不出盒');
  });
});
