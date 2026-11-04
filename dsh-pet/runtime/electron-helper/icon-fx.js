/**
 * 桌面图标碰撞（physics.iconCollision）的渲染端反馈：合成音效 + 冲击环。功能没开时主进程不会推任何消息，本文件不做事。
 *
 * 主进程图标世界在碰撞瞬间推 'pet:icon-fx'：
 *   { sound: true, kind: 'hit' | 'cushion', strength: 0~1 }   → 放一声
 *   { kind: 'hit', strength, x, y }（x/y = 本窗口内容区坐标，主进程单位）   → 在接触点闪一个冲击环
 * 声音是现场合成的（不带音频文件）：被打/互撞是短促的「咔」，撞屏幕边是低沉的「咚」。
 * 依赖 constants.js 的 toLocal（主进程单位 → 本窗口 CSS 像素）。
 */
'use strict';

(function () {
  if (!window.petBridge || !window.petBridge.onIconFx) return;

  let ctx = null;
  const audio = () => {
    if (ctx) return ctx;
    try {
      ctx = new window.AudioContext();
    } catch {
      ctx = null;
    }
    return ctx;
  };

  // 一声撞击：两个衰减的正弦（台球的「咔」由两个高频分量组成）+ 一小段噪声做起音
  function play(kind, strength) {
    const ac = audio();
    if (!ac) return;
    if (ac.state === 'suspended') void ac.resume();
    const t = ac.currentTime;
    const cushion = kind === 'cushion';
    const f1 = cushion ? 170 : 2300 + Math.random() * 300;
    const f2 = cushion ? 410 : 3700 + Math.random() * 400;
    const tau = cushion ? 0.02 : 0.007;
    const peak = Math.max(0.02, Math.min(1, strength)) * 0.5 * (cushion ? 0.7 : 0.9);
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(peak, t + 0.0006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + tau * 9);
    out.connect(ac.destination);
    for (const [f, w] of [
      [f1, 0.65],
      [f2, 0.35],
    ]) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = f;
      g.gain.value = w;
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + tau * 10);
    }
    // 起音噪声
    const n = Math.floor(ac.sampleRate * 0.006);
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n / 4)) * (cushion ? 0.15 : 0.35);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(out);
    src.start(t);
  }

  // 冲击环：盖满窗口、点击穿透的画布
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;';
  const g2 = canvas.getContext('2d');
  const rings = [];
  let raf = 0;
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const mount = () => {
    if (!canvas.isConnected && document.body) {
      document.body.appendChild(canvas);
      fit();
    }
  };
  window.addEventListener('resize', fit);

  const DURATION = 170;
  function frame() {
    const now = performance.now();
    g2.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      const p = (now - r.t0) / DURATION;
      if (p >= 1) {
        rings.splice(i, 1);
        continue;
      }
      const ease = 1 - Math.pow(1 - p, 3);
      const radius = r.max * (0.25 + 0.75 * ease);
      const alpha = (1 - p) * (1 - p);
      g2.lineWidth = 1.5 + 3.5 * r.s * (1 - p);
      g2.strokeStyle = 'rgba(255,255,255,' + (0.9 * alpha).toFixed(3) + ')';
      g2.beginPath();
      g2.arc(r.x, r.y, radius, 0, Math.PI * 2);
      g2.stroke();
      g2.strokeStyle = 'rgba(255,225,120,' + (0.85 * alpha).toFixed(3) + ')';
      g2.lineWidth = 2;
      for (let k = 0; k < 8; k++) {
        const a = r.rot + (k * Math.PI) / 4;
        const r0 = radius * 0.55;
        const r1 = radius * 0.88;
        g2.beginPath();
        g2.moveTo(r.x + Math.cos(a) * r0, r.y + Math.sin(a) * r0);
        g2.lineTo(r.x + Math.cos(a) * r1, r.y + Math.sin(a) * r1);
        g2.stroke();
      }
    }
    raf = rings.length ? requestAnimationFrame(frame) : 0;
  }

  window.petBridge.onIconFx((p) => {
    if (!p) return;
    if (p.sound) {
      play(p.kind, Number(p.strength) || 0.3);
      return;
    }
    const x = toLocal(Number(p.x));
    const y = toLocal(Number(p.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    mount();
    const s = Math.max(0.15, Math.min(1, Number(p.strength) || 0.3));
    rings.push({ x, y, s, max: 22 + 48 * s, t0: performance.now(), rot: Math.random() * Math.PI });
    if (rings.length > 6) rings.shift();
    if (!raf) raf = requestAnimationFrame(frame);
  });
})();
