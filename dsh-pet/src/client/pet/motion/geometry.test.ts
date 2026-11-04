/**
 * 宠物盒几何（src/client/pet/motion/geometry.ts）的契约测试：中心与包围盒两个方向互逆、
 * 度量随宽度线性缩放、命中区按画布换算、舞台与根节点的内联样式，以及越界摆放的可见下限。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { HIT_BOX, MIN_REACHABLE_PX } from '../../../shared/constants.ts';
import { bodyPixelBox } from '../../../shared/physics.ts';
import {
  boxToRatio,
  centerToBox,
  clampReachableBox,
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

describe('petStageStyle —— 舞台位移', () => {
  test('始终按脚垫下移：拖拽中也不取消，抓取点才不会相对光标偏移', () => {
    assert.deepEqual(petStageStyle(21.6), { transform: 'translateY(21.6px)' });
  });

  test('脚垫为 0：位移为 0，不产出额外偏移', () => {
    assert.deepEqual(petStageStyle(0), { transform: 'translateY(0px)' });
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

describe('clampReachableBox —— 越界摆放的可见下限', () => {
  const size = 462;
  const { bottomPad } = derivePetMetrics(size);
  const inset = bodyPixelBox({ x: 0, y: 0, size, bottomPad });

  /** 命中区与视口的交集尺寸（px），即「还剩多少点得到」。 */
  function visible(box: { x: number; y: number }): { w: number; h: number } {
    const body = bodyPixelBox({ x: box.x, y: box.y, size, bottomPad });
    return {
      w: Math.min(body.right, viewport.width) - Math.max(body.left, 0),
      h: Math.min(body.bottom, viewport.height) - Math.max(body.top, 0),
    };
  }

  test('右侧越界：命中区右缘超出视口 → 推回到只剩 24px 可见', () => {
    const box = clampReachableBox({ x: 5000, y: 200 }, viewport, { size, bottomPad });
    assert.equal(box.x, viewport.width - inset.left - MIN_REACHABLE_PX, '左缘应推到命中区留出下限');
    assert.ok(Math.abs(visible(box).w - MIN_REACHABLE_PX) < 1e-9, `可见宽应为 ${MIN_REACHABLE_PX}`);
    assert.equal(box.y, 200, '未越界的那一轴不动');
  });

  test('左侧越界：命中区左缘超出视口 → 推回到只剩 24px 可见', () => {
    const box = clampReachableBox({ x: -5000, y: 200 }, viewport, { size, bottomPad });
    assert.equal(box.x, MIN_REACHABLE_PX - inset.right, '右缘应推到命中区留出下限');
    assert.ok(Math.abs(visible(box).w - MIN_REACHABLE_PX) < 1e-9, `可见宽应为 ${MIN_REACHABLE_PX}`);
  });

  test('底部越界：命中区底边低于视口 → 推回到只剩 24px 可见', () => {
    const box = clampReachableBox({ x: 200, y: 5000 }, viewport, { size, bottomPad });
    assert.equal(box.y, viewport.height - inset.top - MIN_REACHABLE_PX, '顶边应推到命中区留出下限');
    assert.ok(Math.abs(visible(box).h - MIN_REACHABLE_PX) < 1e-9, `可见高应为 ${MIN_REACHABLE_PX}`);
  });

  test('顶部越界：命中区顶边高于视口 → 推回到只剩 24px 可见', () => {
    const box = clampReachableBox({ x: 200, y: -5000 }, viewport, { size, bottomPad });
    assert.equal(box.y, MIN_REACHABLE_PX - inset.bottom, '底边应推到命中区留出下限');
    assert.ok(Math.abs(visible(box).h - MIN_REACHABLE_PX) < 1e-9, `可见高应为 ${MIN_REACHABLE_PX}`);
  });

  test('未越界：原样返回 → 不做任何位移', () => {
    const inside = { x: 400, y: 300 };
    assert.deepEqual(clampReachableBox(inside, viewport, { size, bottomPad }), inside);
  });

  test('极窄视口 + 小宠物：区间反向 → 该轴居中，不夹到错误一侧', () => {
    const narrow = { width: 5, height: 800 };
    const tiny = 100;
    const box = clampReachableBox({ x: 5000, y: 200 }, narrow, { size: tiny, bottomPad: 0 });
    assert.equal(box.x, (narrow.width - tiny) / 2, '容不下两倍下限时应按盒居中');
  });

  test('四角越界：两轴各自夹取 → 角上仍留 24px', () => {
    const box = clampReachableBox({ x: 5000, y: 5000 }, viewport, { size, bottomPad });
    const seen = visible(box);
    assert.ok(Math.abs(seen.w - MIN_REACHABLE_PX) < 1e-9, `可见宽应为 ${MIN_REACHABLE_PX}`);
    assert.ok(Math.abs(seen.h - MIN_REACHABLE_PX) < 1e-9, `可见高应为 ${MIN_REACHABLE_PX}`);
  });
});
