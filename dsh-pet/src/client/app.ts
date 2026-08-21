// client 半侧「应用逻辑」：由 tsdown 内联进 lib/client.js 的 __ModuleLoader__ factory。
// 设计：makeFactory() 返回 DSH 的 factory 函数（f(require) => module），
//       react 通过 factory 的 require 取得（不走 ESM 顶部 import），
//       以匹配 DSH 的 window.__ModuleLoader__.load({ id, factory }) 加载方式。
import { pick, randomBetween, pickWeightedCategory } from './pickers';
import { stripJsonc, buildAnim, buildMinimalAnim, extractDefaultPets, resolvePets } from './config';
import { CANVAS_H, FEET_Y, HIT_BOX, DRAG_THRESHOLD } from './constants';
import { petBridge, makePetConfigSection, NS, zh, en } from './settings';
import type { PetConfigUI } from './settings';
import type { AnimConfig, Corner } from './types';
import type * as ReactNS from 'react';

/**
 * 返回 DSH 插件 factory：`(require) => module`。
 * 插件三件套（name / inject / apply）都在其返回的 module 上。
 */
export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    var module = { exports: {} as any };

    const react: typeof ReactNS = require('react');
    const { useEffect, useRef, useState } = react;
    const { jsx: h } = require('react/jsx-runtime');

    // ============================================================================
    // 内联 CSS —— 注入一次（官方插件标准做法）
    // ============================================================================
    const css = [
      '.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
      '.dsh-pet-root[data-corner="bottom-right"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
      '.dsh-pet-root[data-corner="bottom-left"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
      '.dsh-pet-root[data-corner="top-right"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
      '.dsh-pet-root[data-corner="top-left"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
      '.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}',
      '.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}',
      '.dsh-pet-video.is-front{opacity:1}',
      '.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:default;z-index:1}',
      '.dsh-pet-hit.dragging{cursor:grabbing}',
      '@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
    ].join('\n');
    const cssTag = 'dsh-pet/style.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-pet';
      tag.dataset.pluginCss = cssTag;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ============================================================================
    // 动作配置（唯一事实来源 = config.jsonc）
    // ============================================================================
    let ANIM: AnimConfig = buildMinimalAnim();

    // ============================================================================
    // PetCard 组件 —— 单个宠物实例（配置由容器 PetMulti 传入）
    // ============================================================================
    function PetCard({ cfg }: { cfg: PetConfigUI }) {
      // ---- 尺寸（由配置传入；容器/设置页更新后即时跟随）----
      const [size, setSize] = useState(cfg.size);
      const halfW = size / 2;
      const halfH = (size * 9) / 16 / 2;

      // ---- React 状态 ----
      const [anim, setAnim] = useState(ANIM.idle[0] ?? '');
      const [once, setOnce] = useState(true);
      const [facing, setFacing] = useState('left' as 'left' | 'right');
      const [dragging, setDragging] = useState(false);
      const [customPos, setCustomPos] = useState<null | { rx: number; ry: number }>(null);
      // 初始角落与边距（来自配置；可被容器更新覆盖）
      const [corner, setCorner] = useState<Corner>(cfg.corner);
      const [margin, setMargin] = useState({ x: cfg.marginX, y: cfg.marginY });

      // 配置变化即时跟随（容器重新合并 / 设置页保存后通过 petBridge.sync 触发）
      useEffect(() => {
        setSize(cfg.size);
        setCorner(cfg.corner);
        setMargin({ x: cfg.marginX, y: cfg.marginY });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [cfg.size, cfg.corner, cfg.marginX, cfg.marginY]);
      const [seq, setSeq] = useState(0);

      // ---- DOM / 状态 refs ----
      const rootRef = useRef<HTMLDivElement | null>(null);
      const stageRef = useRef<HTMLDivElement | null>(null);
      const videoARef = useRef<HTMLVideoElement | null>(null);
      const videoBRef = useRef<HTMLVideoElement | null>(null);
      const frontRef = useRef(0);
      const pendingRef = useRef<null | { anim: string; once: boolean; gen: number }>(null);
      const genRef = useRef(0);
      const dragRef = useRef({ active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 });
      const justDraggedRef = useRef(false);
      const animRef = useRef(anim);
      animRef.current = anim;

      const switchTo = (next: string, nextOnce: boolean) => {
        if (!next) return;
        const pending = pendingRef.current;
        if (pending && pending.anim === next && pending.once === nextOnce) return;
        const gen = ++genRef.current;
        pendingRef.current = { anim: next, once: nextOnce, gen };
        const target = frontRef.current === 0 ? videoBRef : videoARef;
        const el = target.current;
        if (!el) return;
        el.src = '/pet/thumb/' + encodeURIComponent(next) + '.webm';
        el.loop = !nextOnce;
        el.muted = true;
        el.autoplay = true;
        el.playsInline = true;
        el.onended = nextOnce ? handleEnded : null;
        el.load();
        const onReady = () => {
          el.removeEventListener('loadeddata', onReady);
          if (pendingRef.current?.gen !== gen) return;
          const old = frontRef.current === 0 ? videoARef : videoBRef;
          el.classList.add('is-front');
          if (old.current && old.current !== el) old.current.classList.remove('is-front');
          frontRef.current = frontRef.current === 0 ? 1 : 0;
          pendingRef.current = null;
          el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
          el.play().catch(() => {});
          if (pendingMoveRef.current) startMoveDrive(el);
        };
        el.addEventListener('loadeddata', onReady);
        if (el.readyState >= 2) onReady();
      };

      // ---- 状态驱动播放 ----
      useEffect(() => {
        switchTo(anim, once);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [anim, once, seq]);
      useEffect(() => () => stopMove(), []);
      useEffect(() => {
        const onResize = () => setCustomPos((prev) => (prev ? { ...prev } : prev));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // ---- 动画链：播完按权重选下一个 ----
      const pickNext = () => {
        const roll = Math.random();
        const wI = ANIM.weights.idle;
        const wT = ANIM.weights.turn;
        const wM = ANIM.weights.move;
        const topEnd = (wI + wT + wM) / 100;
        let kind = '';
        let next = '';
        if (roll < wI / 100) {
          kind = 'IDLE';
          next = pick(ANIM.idle, animRef.current);
          setAnim(next);
        } else if (roll < (wI + wT) / 100) {
          kind = 'TURN';
          next = pick(ANIM.turn, animRef.current);
          setAnim(next);
        } else if (roll < topEnd) {
          if (!tryMove()) {
            const cat = pickWeightedCategory(ANIM.categories, facingRef.current);
            kind = cat ? cat.id : 'FALLBACK';
            next = cat ? pick(cat.actions, animRef.current) : pick(ANIM.idle, animRef.current);
            setAnim(next);
          } else {
            kind = 'MOVES';
            next = '移动(池内随机)';
          }
        } else {
          const cat = pickWeightedCategory(ANIM.categories, facingRef.current);
          kind = cat ? cat.id : 'FALLBACK';
          next = cat ? pick(cat.actions, animRef.current) : pick(ANIM.idle, animRef.current);
          setAnim(next);
        }
        console.log('[dsh-pet] roll=' + roll.toFixed(4) + ' -> [' + kind + '] ' + next);
        setOnce(true);
        setSeq((s) => s + 1);
      };

      const handleEnded = () => {
        if (dragRef.current.active) return;
        if (ANIM.turn.includes(animRef.current)) {
          setFacing((f) => (f === 'left' ? 'right' : 'left'));
        }
        if (ANIM.drag.includes(animRef.current) || ANIM.clicks.includes(animRef.current)) {
          if (ANIM.idle.length) setAnim(pick(ANIM.idle, animRef.current));
          setOnce(true);
          setSeq((s) => s + 1);
          return;
        }
        pickNext();
      };

      // ---- 移动系统 ----
      const moveRef = useRef<number | null>(null);
      const moveTokenRef = useRef(0);
      const pendingMoveRef = useRef<null | { startRatio: number; startYRatio: number; targetRatio: number; dir: number; totalRatio: number; leadSec: number; tailSec: number }>(null);
      const customPosRef = useRef(customPos);
      customPosRef.current = customPos;

      const currentCenterX = () => {
        const cp = customPosRef.current;
        if (cp) return cp.rx * window.innerWidth;
        const rootEl = rootRef.current;
        if (rootEl) return rootEl.getBoundingClientRect().left + halfW;
        return window.innerWidth - 24 - halfW;
      };
      const currentCenterY = () => {
        const cp = customPosRef.current;
        if (cp) return cp.ry * window.innerHeight;
        const rootEl = rootRef.current;
        if (rootEl) return rootEl.getBoundingClientRect().top + halfH;
        return window.innerHeight - 20 - halfH;
      };

      const startMoveDrive = (el: HTMLVideoElement) => {
        const pm = pendingMoveRef.current;
        if (!pm || moveRef.current !== null) return;
        pendingMoveRef.current = null;
        const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
        const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
        const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
        const token = ++moveTokenRef.current;
        const step = () => {
          if (moveTokenRef.current !== token) return;
          const t = el.currentTime || 0;
          const rootEl = rootRef.current;
          if (rootEl) {
            const W = window.innerWidth;
            const H = window.innerHeight;
            let ratioX;
            if (t <= leadSec) ratioX = startRatio;
            else if (t >= duration - tailSec) ratioX = targetRatio;
            else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
            const px = ratioX * W;
            const py = startYRatio * H;
            rootEl.style.left = px - halfW + 'px';
            rootEl.style.top = py - halfH + 'px';
            rootEl.style.right = 'auto';
            rootEl.style.bottom = 'auto';
          }
          if (t < duration - tailSec) moveRef.current = requestAnimationFrame(step);
          else {
            moveRef.current = null;
            setCustomPos({ rx: targetRatio, ry: startYRatio });
          }
        };
        moveRef.current = requestAnimationFrame(step);
      };

      const tryMove = () => {
        if (moveRef.current !== null || pendingMoveRef.current) return true;
        const actions = ANIM.moves.actions;
        if (!actions.length) return false;
        const chosen = actions[Math.floor(Math.random() * actions.length)];
        const mp = Object.assign({}, ANIM.moves.default, chosen.params || {});
        const dir = (facingRef.current === 'right') !== ANIM.turn.includes(animRef.current) ? 1 : -1;
        const W = window.innerWidth;
        const cx = currentCenterX();
        const distance = randomBetween(mp.minDist, mp.maxDist);
        const target = cx + dir * distance;
        const leftBound = mp.margin + halfW;
        const rightBound = W - mp.margin - halfW;
        if (target < leftBound || target > rightBound) return false;
        pendingMoveRef.current = {
          startRatio: cx / W,
          startYRatio: currentCenterY() / window.innerHeight,
          targetRatio: target / W,
          dir,
          totalRatio: Math.abs(target - cx) / W,
          leadSec: mp.leadSec,
          tailSec: mp.tailSec,
        };
        setOnce(true);
        setAnim(chosen.name);
        return true;
      };
      const stopMove = () => {
        pendingMoveRef.current = null;
        moveTokenRef.current++;
        if (moveRef.current !== null) {
          cancelAnimationFrame(moveRef.current);
          moveRef.current = null;
        }
      };

      const facingRef = useRef<'left' | 'right'>(facing);
      facingRef.current = facing;

      // ---- 点击 vs 拖拽 ----
      const handlePointerDown = (e: any) => {
        e.currentTarget.classList.add('dragging');
        stopMove();
        e.currentTarget.setPointerCapture(e.pointerId);
        const rootEl = rootRef.current;
        let offX = 0;
        let offY = 0;
        if (rootEl) {
          const rr = rootEl.getBoundingClientRect();
          offX = e.clientX - (rr.left + rr.width / 2);
          offY = e.clientY - (rr.top + rr.height / 2);
        }
        dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY, offX, offY };
      };
      const handlePointerMove = (e: any) => {
        const d = dragRef.current;
        if (!d.active) return;
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        if (!d.dragging) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          d.dragging = true;
          setDragging(true);
          setOnce(true);
          if (ANIM.drag.length) setAnim(pick(ANIM.drag));
        }
        const rootEl = rootRef.current;
        if (rootEl) {
          rootEl.style.left = e.clientX - d.offX - halfW + 'px';
          rootEl.style.top = e.clientY - d.offY - halfH + 'px';
          rootEl.style.right = 'auto';
          rootEl.style.bottom = 'auto';
        }
        const stageEl = stageRef.current;
        if (stageEl) stageEl.style.transform = 'none';
      };
      const handlePointerUp = (e: any) => {
        const d = dragRef.current;
        const wasDragging = d.dragging;
        d.active = false;
        d.dragging = false;
        e.currentTarget.classList.remove('dragging');
        if (wasDragging) {
          justDraggedRef.current = true;
          setTimeout(() => {
            justDraggedRef.current = false;
          }, 100);
          setDragging(false);
          setCustomPos({ rx: (e.clientX - d.offX) / window.innerWidth, ry: (e.clientY - d.offY) / window.innerHeight });
          const stageEl = stageRef.current;
          if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)';
          if (ANIM.idle.length) setAnim(pick(ANIM.idle, animRef.current));
          setOnce(false);
        }
      };
      const handleClick = (_e: any) => {
        const d = dragRef.current;
        if (d.active || d.dragging || justDraggedRef.current) return;
        if (once && !ANIM.idle.includes(animRef.current)) return;
        stopMove();
        setOnce(true);
        if (ANIM.clicks.length) setAnim(pick(ANIM.clicks));
      };

      // ---- 渲染 ----
      const bottomPad = (size * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H;
      const stageStyle = dragging ? { transform: 'none' } : { transform: 'translateY(' + bottomPad + 'px)' };
      const rootStyle = customPos
        ? (() => {
            const rx = customPos.rx;
            const ry = customPos.ry;
            const left = Math.min(Math.max(rx * window.innerWidth - halfW, 0), window.innerWidth - size);
            const top = Math.min(Math.max(ry * window.innerHeight - halfH, 0), window.innerHeight - (size * 9) / 16);
            return { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
          })()
        : {};
      const commonVideoProps = { muted: true, playsInline: true, autoPlay: true, title: 'dsh-pet' };
      const hitProps = {
        className: 'dsh-pet-hit',
        style: {
          left: ((HIT_BOX.x0 / 640) * 100) + '%',
          top: ((HIT_BOX.y0 / 360) * 100) + '%',
          width: (((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100) + '%',
          height: (((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100) + '%',
        },
        onMouseEnter: (e: any) => {
          if (!dragRef.current.active) e.currentTarget.style.cursor = 'grab';
        },
        onMouseLeave: (e: any) => {
          if (!dragRef.current.active) e.currentTarget.style.cursor = 'default';
        },
        onClick: handleClick,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerUp,
        title: 'dsh-pet',
      };
      return h(
        'div',
        {
          ref: rootRef,
          className: 'dsh-pet-root',
          'data-corner': corner,
          'data-facing': facing,
          style: Object.assign(
            { '--dsh-pet-size': size + 'px', '--dsh-pet-mx': margin.x + 'px', '--dsh-pet-my': margin.y + 'px' },
            rootStyle,
          ),
          children: h('div', {
            ref: stageRef,
            className: 'dsh-pet-stage',
            style: stageStyle,
            children: [
              h('video', Object.assign({}, commonVideoProps, { ref: videoARef, className: 'dsh-pet-video is-front' })),
              h('video', Object.assign({}, commonVideoProps, { ref: videoBRef, className: 'dsh-pet-video' })),
              h('div', hitProps),
            ],
          }),
        },
      );
    }

    // ============================================================================
    // PetMulti 容器 —— 多开：拉取配置 → 合并默认+用户层 pets → 渲染多个 PetCard
    // ============================================================================
    function PetMulti() {
      const [pets, setPets] = useState<PetConfigUI[]>([]);
      const [ready, setReady] = useState(false);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const r1 = await fetch('/pet/config.jsonc');
            if (!r1.ok) return;
            const obj: any = JSON.parse(stripJsonc(await r1.text()));
            ANIM = buildAnim(obj);
            const defaults = extractDefaultPets(obj);
            // 用户覆盖层（设置页保存的完整宠物列表）
            let user: any = {};
            try {
              const r2 = await fetch('/pet/config');
              if (r2.ok && r2.status !== 204) user = await r2.json().catch(() => ({}));
            } catch { /* 无用户层时忽略 */ }
            const merged = resolvePets(defaults, user);
            if (!alive) return;
            petBridge.current = merged;
            petBridge.template = defaults.length ? defaults[0] : null;
            petBridge.sync = (list: PetConfigUI[]) => {
              setPets(list);
              petBridge.current = list;
            };
            setPets(merged);
            setReady(true);
          } catch { /* 失败静默：保持不渲染（或兜底） */ }
        })();
        return () => {
          alive = false;
          petBridge.sync = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      return ready ? pets.map((p) => h(PetCard, { key: p.id, cfg: p })) : null;
    }

    // ============================================================================
    // 插件主体（Cordis 插件三件套）
    // ============================================================================
    const name = 'pet';
    const inject = ['slots', 'locale'];
    function apply(ctx: any, _config: any) {
      // 本地化字典（设置页文案）
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pet: dictionaries');
      const t = ctx.locale.bind(NS);

      // 宠物 overlay（多开：容器渲染多个 PetCard）
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register(
          { name: 'shell.overlay', id: 'pet', order: 1000 },
          () => h(PetMulti, {}),
        );
      });

      // 设置页：「桌宠配置」（大小/位置，保存即时生效）
      const PetConfigSection = makePetConfigSection({ h, useState, t });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'pet-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
          PetConfigSection,
        );
      });
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
