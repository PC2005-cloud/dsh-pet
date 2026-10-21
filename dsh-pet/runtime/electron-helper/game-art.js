/**
 * 「弹弓」画面层 —— 只做贴图（经典 script 全局 GameArt，game.js 调用）。
 *
 * 所有可见的东西都是位图素材（runtime/electron-helper/game-assets，规格与来源见 scripts/game-art/README.md）：
 *   - 弹弓 / 皮筋 / 皮兜 / 影子 / 木箱 / 碎片 / 木屑：按宠物原画的配色、线条与光照规格离线绘制；
 *   - 小泡泡（瞄准 / 飞行拖尾）：从宠物自己的动画「鲸鱼吐泡泡特效」里抠出来的原画。
 * 这里没有任何几何图形冒充美术：皮筋是把 band.png 沿两点拉伸贴上去（它确实要随拉伸变形），
 * 其余全是 drawImage。坐标都是逻辑场景像素（game.js 已把 ctx 变换到场景系）。
 */
'use strict';

const GameArt = (() => {
  const META = window.SLING_META;
  const DIR = './game-assets/';
  /** 绘制素材的密度：3 px / 场景逻辑像素（paint-*.py），四周各留 1 单位边 */
  const PX = 3;
  /** 画木箱时的标称尺寸（逻辑像素）：别的尺寸按比例缩放同一张图 */
  const NOMINAL = { crate: 54 };
  const BUBBLES = ['bubble-s1', 'bubble-s2', 'bubble-s3'];
  /** 小泡泡图里圆本身到图边的留白（px） */
  const BUBBLE_PAD = 3;

  const img = {};

  function load(name) {
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('素材加载失败：' + name));
      el.src = DIR + name + '.png';
    });
  }

  /** 预加载全部素材（开局前完成，避免第一帧缺图） */
  async function loadAll() {
    const names = [
      'sling',
      'band',
      'pouch',
      'shadow',
      'crate',
      'crate-cracked',
      'shard-1',
      'shard-2',
      'shard-3',
      'dust',
    ].concat(BUBBLES);
    const loaded = await Promise.all(names.map(load));
    names.forEach((n, i) => (img[n] = loaded[i]));
  }

  /** 叉尖（皮筋绑扎处）的场景坐标 */
  function tips(base) {
    return {
      back: { x: base.x + META.backTip[0], y: base.y + META.backTip[1] },
      front: { x: base.x + META.frontTip[0], y: base.y + META.frontTip[1] },
    };
  }

  function drawSling(ctx, base) {
    drawShadow(ctx, base.x + 2, base.y, 46, 0.9);
    ctx.drawImage(img.sling, base.x - META.origin[0], base.y - META.origin[1], META.size[0], META.size[1]);
  }

  /** 皮筋：band.png 沿 from→to 拉伸，厚度随拉伸变细 */
  function drawBand(ctx, from, to, thickness) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    ctx.save();
    ctx.translate(from.x, from.y);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.drawImage(img.band, -1, -thickness / 2, len + 2, thickness);
    ctx.restore();
  }

  function drawPouch(ctx, pos, angle) {
    const w = img.pouch.width / PX;
    const h = img.pouch.height / PX;
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(angle);
    ctx.drawImage(img.pouch, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** 柔和的接地影子（素材是画好的模糊椭圆） */
  function drawShadow(ctx, x, groundY, width, alpha) {
    if (alpha <= 0.01) return;
    const h = (width * img.shadow.height) / img.shadow.width;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(img.shadow, x - width / 2, groundY - h / 2, width, h);
    ctx.restore();
  }

  /**
   * 一只木箱：中心 (x, y)、宽 w、转角 angle；cracked = 用裂开的那张图。
   * 图四周各有 1 单位留白（描边不被裁），按 w / 标称宽等比缩放。
   */
  function drawBlock(ctx, kind, x, y, w, angle, cracked, alpha) {
    const im = img[kind + (cracked ? '-cracked' : '')];
    const k = w / NOMINAL[kind];
    const dw = (im.width / PX) * k;
    const dh = (im.height / PX) * k;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(im, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  /** 木箱碎开时飞出的木片（which = 0..2） */
  function drawShard(ctx, which, x, y, angle, scale, alpha) {
    const im = img['shard-' + (which + 1)];
    const w = (im.width / PX) * scale;
    const h = (im.height / PX) * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(im, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** 木屑烟尘 */
  function drawDust(ctx, x, y, scale, alpha, rot) {
    const w = (img.dust.width / PX) * scale;
    const h = (img.dust.height / PX) * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rot || 0);
    ctx.drawImage(img.dust, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** 小泡泡（瞄准提示 / 飞行拖尾）：圆的真实半径对齐到 r */
  function drawBubble(ctx, x, y, r, seed, alpha) {
    const im = img[BUBBLES[Math.abs(seed) % BUBBLES.length]];
    const size = im.width * ((2 * r) / (im.width - BUBBLE_PAD * 2));
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.drawImage(im, x - size / 2, y - size / 2, size, size);
    ctx.restore();
  }

  return { loadAll, tips, drawSling, drawBand, drawPouch, drawShadow, drawBlock, drawShard, drawDust, drawBubble };
})();
