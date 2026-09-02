// 宠物页面：单个宠物实例（PetCard）+ 多开容器（PetMulti）。
// 工厂形态与 settings.ts 一致：client 半侧不能顶层 import react，
// react 能力由 DSH 运行时注入（rt），组件在工厂内制造。
// 配置唯一入口 = GET /dsh-pet-7340/config 的**成品聚合**（host readAllConfig 保证绝对正确）：
// PetMulti 一次拉取 → flattenConfigPets 拍平成渲染列表，PetCard 直接读字段，零校验零兜底。
// 纯逻辑（选择/移动几何/余额/拍平）来自 src/shared —— 与桌面模式共用同一份源码。
import { pick, rollKind, pickCategoryAction } from '../shared/pickers';
import { planMove } from '../shared/motion';
import { flattenConfigPets, isWebVisible } from '../shared/config';
import { balanceEventIndex, balancePercent, fetchBalanceState, type BalanceState } from '../shared/balance';
import { fetchWhisperState, fetchWhisperTrigger } from '../shared/whisper';
import { makeBalanceBubble, makeWhisperBubble } from './bubble';
import { clickScore, SCORE_MIN_SPEED, mountScorePopup, spawnScoreBurst } from '../shared/score-popup';
import { CANVAS_H, FEET_Y, HIT_BOX, DRAG_THRESHOLD, PET_REF_WIDTH } from '../shared/constants';
// 统一右键菜单：与桌面共用同一份组件（树 + 渲染 + 样式，src/shared/menu.ts）
import {
  buildMenuTree,
  mountContextMenu,
  isNoMirrorAnimation,
  MENU_CSS,
  type MenuLeaf,
  type MenuNode,
} from '../shared/menu';
// 对话弹窗：与桌面共用同一份组件（数据经 host /chat 读写同一份记忆）
import { mountChatDialog } from '../shared/chat';
import { petBridge } from './settings';
// 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹）：两端共用同一份纯计算（src/shared/physics.ts）
import {
  estimateReleaseVelocity,
  springStep,
  throwBounds,
  throwStep,
  trimTrail,
  collidePet,
  bodyPixelBox,
  rectsOverlap,
  SQ_DURATION_MS,
  SQ_SQUASH,
  squashScale,
  landingSquash,
  type DragSample,
  type PetCollisionSlot,
  type ThrowState,
} from '../shared/physics';
import type { Animations, Corner, Pet, PhysicsParams, Weights } from '../shared/types';
import type * as ReactNS from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 运行期宠物：拍平后的成品实例——条目级字段（动画池/权重/刷新周期/物理参数）已吹入，必填 */
export type RuntimePet = Pet & {
  animations: Animations;
  animationWeights: Weights;
  eventsRefreshSec: Record<string, number>;
  physics: PhysicsParams;
};

/** 播放动画扩展名：唯一播放/发布格式 webm（VP9-alpha），源码写死、不做运行时判断。
 *  Safari/HEVC(.mov) 兼容属 fork 定制（仓库保留流水线 scripts/encode_hevc_alpha.sh），
 *  插件本体不发布、不支持 .mov。 */
const THUMB_EXT = '.webm';

/** 余额气泡展示时长（ms）：定时自动消失，与动画生命周期解耦 */
const BUBBLE_DURATION_MS = 10 * 1000;

/** 内联 CSS —— 注入一次（官方插件标准做法） */
const css = [
  '.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
  '.dsh-pet-root[data-corner="bottom-right"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="bottom-left"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-right"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-left"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}',
  '.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}',
  '.dsh-pet-video.is-front{opacity:1}',
  '.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:url("/dsh-pet-7340/pic/cursor-grab.png") 16 16, grab;z-index:1}',
  '.dsh-pet-hit.dragging{cursor:url("/dsh-pet-7340/pic/cursor-grabbing.png") 16 16, grabbing}',
  '@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
  // 统一右键菜单样式（与桌面注入同一份 MENU_CSS）
  MENU_CSS,
].join('\n');
const cssTag = 'dsh-pet/style.css';
function injectCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = cssTag;
    tag.textContent = css;
    document.head.appendChild(tag);
  }
}

/**
 * 制造宠物页面组件（工厂，与 makePetConfigSection 同理：react 由运行时注入）。
 * @param rt 运行时注入的 react 能力（h=jsx / useState / useEffect / useRef）
 * @returns PetMulti 多开容器组件（内部渲染多个 PetCard）
 */
export function makePetUI(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}): () => ReactNode {
  const { h, useState, useEffect, useRef } = rt;
  injectCss();

  /** 余额气泡（哑组件：数据与显隐由 PetCard 传入） */
  const BalanceBubble = makeBalanceBubble({ h });
  /** 碎碎念气泡（哑组件：文本与显隐由 PetCard 传入） */
  const WhisperBubble = makeWhisperBubble({ h });

  /** 单个宠物实例（配置由容器 PetMulti 传入；碎碎念轮询/触发/气泡完全自理） */
  function PetCard({
    cfg,
    balance,
    balanceTick,
    arena,
  }: {
    cfg: RuntimePet;
    balance: BalanceState | null;
    balanceTick: number;
    arena: ReactNS.MutableRefObject<{ slots: Record<string, PetCollisionSlot> }>;
  }) {
    // ---- 尺寸（由配置传入；容器/设置页更新后即时跟随）----
    const [size, setSize] = useState(cfg.size);
    const halfW = size / 2;
    const halfH = (size * 9) / 16 / 2;
    // 舞台脚底垫高（宠物站立于脚底线）：命中框 y、碰撞 body 框、渲染 stage 位移共用
    const bottomPad = (size * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H;
    // 动画池与权重：拍平时已把所属条目的池吹进 cfg（文件宠物自带完整独立池；主宠物用 main 条目
    // 即内置默认池）——成品绝对正确，直接读，不做任何回落
    const petAnims = cfg.animations;
    const petWeights = cfg.animationWeights;

    // ---- React 状态 ----
    const [anim, setAnim] = useState(petAnims.idle[0] ?? '');
    const [once, setOnce] = useState(true);
    const [facing, setFacing] = useState('left' as 'left' | 'right');
    const [dragging, setDragging] = useState(false);
    const [customPos, setCustomPos] = useState<null | { rx: number; ry: number }>(null);
    // 初始角落与边距（来自配置；可被容器更新覆盖）
    const [corner, setCorner] = useState<Corner>(cfg.position.corner);
    const [margin, setMargin] = useState({ x: cfg.position.marginX, y: cfg.position.marginY });
    // 余额气泡显隐（事件触发时显示，10s 后定时自动消失）
    const [bubbleOn, setBubbleOn] = useState(false);
    const bubbleTimerRef = useRef<number | null>(null);
    // 碎碎念气泡（独立于余额气泡：文本气泡与余额行气泡互不干扰，各自 10s 显隐）
    const [whisperBubbleOn, setWhisperBubbleOn] = useState(false);
    const whisperBubbleTimerRef = useRef<number | null>(null);
    // 碎碎念当前文本（本宠物独立生成的句子）
    const [whisperText, setWhisperText] = useState<string | null>(null);
    // 右键菜单（统一自绘组件）：当前挂载的 close() 句柄，卸载/重开前清理
    const menuRef = useRef<{ close: () => void } | null>(null);
    // 对话弹窗（与桌面共用 shared 组件）：当前挂载的 close() 句柄，卸载/重开前清理
    const chatRef = useRef<{ close: () => void } | null>(null);

    // 配置变化即时跟随（容器重新合并 / 设置页保存后通过 petBridge.sync 触发）
    useEffect(() => {
      setSize(cfg.size);
      setCorner(cfg.position.corner);
      setMargin({ x: cfg.position.marginX, y: cfg.position.marginY });
    }, [cfg.size, cfg.position.corner, cfg.position.marginX, cfg.position.marginY]);
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
    // 拖拽抛掷物理状态：轨迹样本 / 包围盒左上角实时 px / 弹簧目标与速度 / 弹簧跟随 rAF / 抛掷 rAF
    const dragTrailRef = useRef<DragSample[]>([]);
    const boxPxRef = useRef<{ x: number; y: number } | null>(null);
    const dragTargetRef = useRef<{ x: number; y: number } | null>(null);
    const dragVelRef = useRef({ vx: 0, vy: 0 });
    const dragFollowRef = useRef<number | null>(null);
    const dragFollowTokenRef = useRef(0);
    const throwRef = useRef<number | null>(null);
    const throwTokenRef = useRef(0);
    // 抛掷实时状态（宠物间碰撞查询用：每帧抛掷积分后同步，落定清空）
    const throwStateRef = useRef<ThrowState | null>(null);
    // 按下瞬间已触发过积分（pointerdown 即触发；防止松开的 click 再触发一次/再播点击动画）
    const pressScoreFiredRef = useRef(false);
    // Q 弹挤压（点击回应 / 抛掷落地）：rAF + 待压标记（等新动画真正成为前台再压，压的是新首帧）
    const squashRef = useRef<number | null>(null);
    const squashTokenRef = useRef(0);
    const pendingSquashRef = useRef(false);
    const animRef = useRef(anim);
    animRef.current = anim;

    const switchTo = (next: string, nextOnce: boolean) => {
      if (!next) return;
      const pending = pendingRef.current;
      if (pending && pending.anim === next && pending.once === nextOnce) {
        // 防重命中（单动画点击时目标=当前动画，不重播）：仍消费 Q 弹标记，压当前前台视频，
        // 保证「点击唯一动画」时挤压反馈不丢（与桌面端同构）。
        if (pendingSquashRef.current) {
          pendingSquashRef.current = false;
          const front = frontRef.current === 0 ? videoARef : videoBRef;
          if (front.current) startSquash(front.current);
        }
        return;
      }
      const gen = ++genRef.current;
      pendingRef.current = { anim: next, once: nextOnce, gen };
      const target = frontRef.current === 0 ? videoBRef : videoARef;
      const el = target.current;
      if (!el) return;
      el.src =
        '/dsh-pet-7340/thumb/' +
        encodeURIComponent(cfg.assetRoot ?? cfg.id) +
        '/' +
        encodeURIComponent(next) +
        THUMB_EXT;
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
        if (old.current && old.current !== el) {
          old.current.classList.remove('is-front');
          // 拆雷：降级为背景的视频继续播完会触发它身上残留的 onended → handleEnded，
          // 掐断当前前台动画（历史上表现为随机急速跳转/雪崩）。清 handler + 停播彻底消除。
          old.current.onended = null;
          old.current.pause();
        }
        frontRef.current = frontRef.current === 0 ? 1 : 0;
        pendingRef.current = null;
        el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        el.play().catch(() => {});
        // 点击 Q 弹：等新动画就位后才压（压的是新点击动画的首帧，与桌面一致）
        if (pendingSquashRef.current) {
          pendingSquashRef.current = false;
          startSquash(el);
        }
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
    useEffect(
      () => () => {
        stopMove();
        stopDragFollow();
        stopThrow();
        stopSquash();
      },
      [],
    );
    useEffect(
      () => () => {
        if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
        if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
      },
      [],
    );
    // 卸载时关闭可能开着的右键菜单与对话弹窗（挂载的 DOM 一并清理）
    useEffect(
      () => () => {
        if (menuRef.current) {
          menuRef.current.close();
          menuRef.current = null;
        }
        if (chatRef.current) {
          chatRef.current.close();
          chatRef.current = null;
        }
      },
      [],
    );
    // 余额事件：容器拉取成功后递增 balanceTick → 按档位播放事件动画 + 弹气泡
    // （仅启用余额功能的宠物触发：未启用则该宠物完全不播余额动画、不显示气泡；
    //   无效/不支持按设计不触发动画，错误由容器侧显式上报）
    const prevTickRef = useRef(0);
    useEffect(() => {
      if (!cfg.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫
      if (balanceTick === 0 || balanceTick === prevTickRef.current) return;
      prevTickRef.current = balanceTick;
      if (!balance || !balance.ok) return;
      const p = balancePercent(balance);
      if (p === undefined) return; // 当前数据源没有百分比语义（如 DeepSeek 余额），不触发档位动画
      const pool = petAnims.events?.balance;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
        return;
      }
      const idx = balanceEventIndex(p);
      const name = pool[idx];
      if (!name) {
        console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
        return;
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' balance pet=' +
          cfg.id +
          ' p=' +
          p.toFixed(1) +
          '% -> [档' +
          idx +
          '] ' +
          name,
      );
      stopMove();
      setBubbleOn(true);
      // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
      setOnce(true);
      setAnim(name);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [balanceTick]);

    // 碎碎念：本宠物独立轮询 /whisper?pet=<id> —— host 按宠物独立生成（用本种类人设）、按宠物节流。
    // 首拉仅记基线（不触发，避免页面加载/刷新时重放）；之后 ts 变化（本宠物新周期的新句）才触发动画+气泡；
    // 失败/未配置静默跳过（不弹错误气泡）。每只宠物独立轮询 = 各自周期、各自人设、各自一句话。
    const whisperTextRef = useRef<string | null>(null);
    const prevWhisperTsRef = useRef(0);
    useEffect(() => {
      if (!cfg.whisperEnabled) return; // 未启用碎碎念 -> 该宠物对碎碎念事件完全免疫
      let alive = true;
      let hasBaseline = false;
      const refresh = async () => {
        try {
          const state = await fetchWhisperState('/dsh-pet-7340/whisper?pet=' + encodeURIComponent(cfg.id));
          if (!alive) return;
          if (state.ok) {
            if (!hasBaseline) {
              hasBaseline = true; // 首次仅记基线：避免启动/刷新时重放历史事件
              prevWhisperTsRef.current = state.ts;
              whisperTextRef.current = state.text;
              return;
            }
            if (state.ts !== prevWhisperTsRef.current) {
              prevWhisperTsRef.current = state.ts;
              whisperTextRef.current = state.text;
              triggerWhisper(state.text);
            }
          } else {
            console.warn(
              '[dsh-pet] 碎碎念生成失败 pet=' +
                cfg.id +
                ' reason=' +
                state.reason +
                (state.message ? ' ' + state.message : ''),
            );
          }
        } catch (e) {
          if (alive) console.warn('[dsh-pet] 碎碎念拉取异常 pet=' + cfg.id, e);
        }
      };
      void refresh();
      const intervalMs = Math.max(1000, (cfg.eventsRefreshSec.whisper ?? 3600) * 1000);
      const timer = window.setInterval(() => void refresh(), intervalMs);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cfg.id, cfg.whisperEnabled]);

    // 命令触发气泡（/chat 斜杠命令）：1s 轻量轮询 /broadcast?pet=<id>，ts 变化即弹气泡。
    // 与碎碎念周期轮询独立（host 广播缓存是另一条通道）：手动触发语义不受 whisperEnabled 门控
    const prevBroadcastTsRef = useRef(0);
    useEffect(() => {
      let alive = true;
      let hasBaseline = false;
      const refresh = async () => {
        try {
          const r = await fetch('/dsh-pet-7340/broadcast?pet=' + encodeURIComponent(cfg.id), { cache: 'no-store' });
          if (!alive || !r.ok) return;
          const d = (await r.json().catch(() => null)) as { ok?: unknown; text?: unknown; ts?: unknown } | null;
          if (!d || d.ok !== true) return;
          const ts = typeof d.ts === 'number' ? d.ts : 0;
          if (!hasBaseline) {
            // 首拉无条件记基线（含 ts=0）：若 ts=0 提前 return 会跳过基线建立，
            // 导致第一条命令广播被当成基线吃掉（该条永不弹）
            hasBaseline = true;
            prevBroadcastTsRef.current = ts;
            return;
          }
          if (ts === 0 || ts === prevBroadcastTsRef.current) return; // 无广播 / 无变化
          prevBroadcastTsRef.current = ts;
          if (typeof d.text === 'string' && d.text) triggerWhisper(d.text);
        } catch {
          /* 广播轮询失败静默：下一周期再试 */
        }
      };
      void refresh();
      const timer = window.setInterval(() => void refresh(), 1000);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cfg.id]);

    // 碎碎念触发（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（10s 消失，与动画解耦）
    const triggerWhisper = (text: string) => {
      const pool = petAnims.events?.whisper;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
        return;
      }
      const name = pool[Math.floor(Math.random() * pool.length)];
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' whisper pet=' +
          cfg.id +
          ' -> [' +
          name +
          '] 「' +
          text +
          '」',
      );
      stopMove();
      setWhisperText(text);
      setWhisperBubbleOn(true);
      // 气泡 10s 定时消失（与动画解耦；重复触发先清旧定时器）
      if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
      whisperBubbleTimerRef.current = window.setTimeout(() => setWhisperBubbleOn(false), BUBBLE_DURATION_MS);
      setOnce(true);
      setAnim(name);
    };
    useEffect(() => {
      const onResize = () => setCustomPos((prev) => (prev ? { ...prev } : prev));
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    // ---- 动画链：播完按权重选下一个 ----
    const pickNext = () => {
      const animations = petAnims;
      const animationWeights = petWeights;
      const roll = Math.random();
      const k = rollKind(roll, animationWeights);
      let kind: string;
      let next: string;
      if (k === 'idle') {
        kind = 'IDLE';
        next = pick(animations.idle, animRef.current);
        setAnim(next);
      } else if (k === 'turn') {
        kind = 'TURN';
        next = pick(animations.turn, animRef.current);
        setAnim(next);
      } else if (k === 'move') {
        const moved = tryMove();
        if (moved === false) {
          const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
          kind = act.id;
          next = act.name;
          setAnim(next);
        } else {
          kind = 'MOVES';
          // 成功返回具体动作名；占用中返回 true（已有一场移动在进行，不重播、不另设动画）
          next = typeof moved === 'string' ? moved : '移动进行中(不重播)';
        }
      } else {
        const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
        kind = act.id;
        next = act.name;
        setAnim(next);
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' facing=' +
          facingRef.current +
          ' roll=' +
          roll.toFixed(4) +
          ' -> [' +
          kind +
          '] ' +
          next,
      );
      setOnce(true);
      setSeq((s) => s + 1);
    };

    const handleEnded = (e?: Event) => {
      // 只认前台视频触发的 ended：后台（被降级停播）视频即便有残留事件也一律丢弃，防止掐断当前动画
      const evEl = e && (e.currentTarget as HTMLVideoElement | null);
      if (evEl && !evEl.classList.contains('is-front')) return;
      const animations = petAnims;
      if (dragRef.current.active) return;
      // 事件动画播完：回 idle（与 drag/clicks 同分支，不进入随机链）；气泡由定时器自动消失，与动画解耦
      const isEvent = Object.values(animations.events ?? {}).some((pool) => pool.includes(animRef.current));
      if (isEvent) {
        if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
        return;
      }
      if (animations.turn.includes(animRef.current)) {
        const next = facing === 'left' ? 'right' : 'left';
        setFacing(next);
        facingRef.current = next; // 立即同步：翻转后的 pickNext 用新朝向过滤 noMirror（右侧不选文字类）
      }
      if (animations.drag.includes(animRef.current) || animations.clicks.includes(animRef.current)) {
        if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
        return;
      }
      pickNext();
    };

    // ---- 移动系统 ----
    const moveRef = useRef<number | null>(null);
    const moveTokenRef = useRef(0);
    const pendingMoveRef = useRef<null | {
      startRatio: number;
      startYRatio: number;
      targetRatio: number;
      dir: number;
      totalRatio: number;
      leadSec: number;
      tailSec: number;
    }>(null);
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

    /** 尝试发起一次移动：占用中返回 true（不重播），无法移动返回 false，成功返回动作名（供日志显示具体动作）。
     *  preferredName 传入时固定使用该动画（右键菜单点播移动动画），否则与随机链一致随机从 moves.actions 选。 */
    const tryMove = (preferredName?: string): boolean | string => {
      if (moveRef.current !== null || pendingMoveRef.current || throwRef.current !== null) return true;
      const moves = petAnims.moves;
      const actions = moves.actions;
      if (!actions.length) return false;
      const chosen = preferredName
        ? (actions.find((a) => a.name === preferredName) ?? null)
        : actions[Math.floor(Math.random() * actions.length)];
      if (!chosen) return false;
      const mp = Object.assign({}, moves.default, chosen.params || {});
      const dir = (facingRef.current === 'right') !== petAnims.turn.includes(animRef.current) ? 1 : -1;
      const W = window.innerWidth;
      // 移动距离随宠物缩放：config 的 minDist/maxDist 是基准尺寸（462px 宽）下的 px，
      // 按 实际size/基准 等比缩放 —— 小宠物挪小步、大宠物挪大步，与人物自身大小匹配
      const distScale = size / PET_REF_WIDTH;
      const plan = planMove({
        cx: currentCenterX(),
        cy: currentCenterY(),
        W,
        H: window.innerHeight,
        dir,
        minDist: mp.minDist * distScale,
        maxDist: mp.maxDist * distScale,
        margin: mp.margin,
        halfW,
        sideAllow,
      });
      if (!plan) return false;
      pendingMoveRef.current = {
        ...plan,
        dir,
        leadSec: mp.leadSec,
        tailSec: mp.tailSec,
      };
      setOnce(true);
      setAnim(chosen.name);
      return chosen.name;
    };
    const stopMove = () => {
      pendingMoveRef.current = null;
      moveTokenRef.current++;
      if (moveRef.current !== null) {
        cancelAnimationFrame(moveRef.current);
        moveRef.current = null;
      }
    };

    // ---- 拖拽抛掷物理（与桌面 renderer.js 同构；纯计算在 shared/physics.ts）----
    /** 停止弹簧跟随（不碰 dragState：指针捕获期间由 pointerdown/up 独立管理） */
    const stopDragFollow = () => {
      dragFollowTokenRef.current++;
      if (dragFollowRef.current !== null) {
        cancelAnimationFrame(dragFollowRef.current);
        dragFollowRef.current = null;
      }
      dragTargetRef.current = null;
      dragVelRef.current = { vx: 0, vy: 0 };
    };
    /** 停止抛掷（宠物在空中被抓住/点菜单/回家时立即定格在当前落点）。
     *  同时清速度状态 throwStateRef——否则「抓住后温柔放下」会残留最后一次飞行速度，
     *  静止的宠物点一下就误判为飞行中。点击积分用的飞行动态由 pointerdown 提前记录。 */
    const stopThrow = () => {
      throwTokenRef.current++;
      if (throwRef.current !== null) {
        cancelAnimationFrame(throwRef.current);
        throwRef.current = null;
      }
      throwStateRef.current = null;
    };
    /** rAF 弹簧跟随：包围盒朝拖拽目标（指针-抓取偏移）过阻尼追赶，抹平高频抖动 */
    const startDragFollow = (rootEl: HTMLDivElement) => {
      if (dragFollowRef.current !== null) return;
      const token = ++dragFollowTokenRef.current;
      let last = performance.now();
      const step = () => {
        if (dragFollowTokenRef.current !== token) return;
        const target = dragTargetRef.current;
        if (!target) {
          dragFollowRef.current = null;
          return;
        }
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        const vel = dragVelRef.current;
        let x = boxPxRef.current?.x ?? 0;
        let y = boxPxRef.current?.y ?? 0;
        vel.vx = springStep(vel.vx, x, target.x, dt, cfg.physics.throwPower);
        vel.vy = springStep(vel.vy, y, target.y, dt, cfg.physics.throwPower);
        x += vel.vx * dt;
        y += vel.vy * dt;
        boxPxRef.current = { x, y };
        rootEl.style.left = x + 'px';
        rootEl.style.top = y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
        dragFollowRef.current = requestAnimationFrame(step);
      };
      dragFollowRef.current = requestAnimationFrame(step);
    };
    /** 抛掷驱动：重力 + 边缘反弹 + 落地摩擦，落定后提交 customPos（飞行中只改 DOM，避免逐帧 React 重渲染） */
    const startThrow = (px: number, py: number, vx: number, vy: number) => {
      stopDragFollow();
      stopMove();
      const bounds = throwBounds({ W: window.innerWidth, H: window.innerHeight, size, sideAllow });
      const token = ++throwTokenRef.current;
      let state: ThrowState = { x: px, y: py, vx, vy };
      let last = performance.now();
      let prevGrounded = false; // 落地 Q 弹：只在空中→地面转换帧触发一次
      const rootEl = rootRef.current;
      const step = () => {
        if (throwTokenRef.current !== token) return;
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        const fallingVy = state.vy; // 本帧积分前的竖直速度（正=下落）：即落地冲击速度
        const res = throwStep(state, dt, bounds, cfg.physics);
        state = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
        throwStateRef.current = state;
        // ---- 宠物间碰撞（仅 petCollision 开启）：飞行中的自己被甩出时撞到其它宠物 ----
        if (cfg.physics.petCollision) {
          const myBody = bodyPixelBox({ x: state.x, y: state.y, size, bottomPad });
          for (const slotId of Object.keys(arena.current.slots)) {
            if (slotId === cfg.id) continue;
            const slot = arena.current.slots[slotId];
            const otherBox = slot.getBox();
            if (!otherBox) continue;
            const otherBody = bodyPixelBox({
              x: otherBox.x,
              y: otherBox.y,
              size: slot.size,
              bottomPad: slot.bottomPad,
            });
            if (!rectsOverlap(myBody, otherBody)) continue;
            const vel = slot.getVel();
            const hit = collidePet(
              { x: state.x, y: state.y, vx: state.vx, vy: state.vy, size },
              { x: otherBox.x, y: otherBox.y, vx: vel.vx, vy: vel.vy, size: slot.size },
            );
            if (hit) {
              // 飞行方：按动量结果继续弹开；被撞方：回调其 onHit 让被撞宠物以新初速抛出去
              state.vx = hit.fvx;
              state.vy = hit.fvy;
              throwStateRef.current = state;
              slot.onHit(hit.hvx, hit.hvy);
              break; // 一帧只处理一次碰撞（避免连锁触发抖动）
            }
          }
        }
        if (rootEl) {
          rootEl.style.left = res.x + 'px';
          rootEl.style.top = res.y + 'px';
          rootEl.style.right = 'auto';
          rootEl.style.bottom = 'auto';
        }
        boxPxRef.current = { x: res.x, y: res.y };
        customPosRef.current = {
          rx: (res.x + halfW) / window.innerWidth,
          ry: (res.y + halfH) / window.innerHeight,
        };
        // 落地 Q 弹：只在空中→地面转换帧触发一次，力度随冲击速度（轻落 0.8 ~ 重砸 0.55）
        const grounded = res.y >= bounds.maxY - 1;
        if (res.bounced && grounded && !prevGrounded) {
          const frontEl = frontRef.current === 0 ? videoARef.current : videoBRef.current;
          if (frontEl) startSquash(frontEl, landingSquash(fallingVy));
        }
        prevGrounded = grounded;
        if (res.atRest) {
          throwRef.current = null;
          throwStateRef.current = null;
          setCustomPos(customPosRef.current);
          return;
        }
        throwRef.current = requestAnimationFrame(step);
      };
      throwRef.current = requestAnimationFrame(step);
    };
    /** 被撞回调（宠物间碰撞）：被其它飞行中宠物撞到 → 停当前动作，从落点以新初速抛出去（全复用现有物理） */
    const startThrowLatestRef = useRef<(px: number, py: number, vx: number, vy: number) => void>(() => {});
    startThrowLatestRef.current = startThrow;
    const onPetHit = (vx: number, vy: number) => {
      stopMove();
      stopDragFollow();
      stopThrow();
      const bx = boxPxRef.current;
      let sx = 0;
      let sy = 0;
      if (bx) {
        sx = bx.x;
        sy = bx.y;
      } else {
        const r = rootRef.current?.getBoundingClientRect();
        if (r) {
          sx = r.left;
          sy = r.top;
        }
      }
      startThrowLatestRef.current(sx, sy, vx, vy);
    };
    // 共享碰撞站场注册（只在本宠物参与时注册；卸载清理）。getVel 用最新抛掷状态；
    // onHit 经 startThrowLatestRef 转发，杜绝陈旧闭包（startThrow 每次渲染重建）。
    useEffect(() => {
      const arenaSlots = arena.current.slots;
      arenaSlots[cfg.id] = {
        size,
        bottomPad,
        getBox: () => {
          if (boxPxRef.current) return boxPxRef.current;
          const r = rootRef.current?.getBoundingClientRect();
          return r ? { x: r.left, y: r.top } : null;
        },
        getVel: () =>
          throwRef.current !== null && throwStateRef.current
            ? { vx: throwStateRef.current.vx, vy: throwStateRef.current.vy }
            : { vx: 0, vy: 0 },
        onHit: onPetHit,
      };
      return () => {
        delete arenaSlots[cfg.id];
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cfg.id, size, bottomPad, arena]);
    /** Q 弹挤压：前台视频垂直压扁（贴地锚定，transform-origin:bottom）再回弹；
     *  与桌面同构，曲线在 shared（squashScale）。depth = 下压幅度（点击固定 0.55；
     *  落地按冲击速度 landingSquash 动态取）。reduce-motion 时跳过。 */
    const startSquash = (el: HTMLVideoElement, depth: number = SQ_SQUASH) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const token = ++squashTokenRef.current;
      if (squashRef.current !== null) cancelAnimationFrame(squashRef.current);
      const origin = el.style.transformOrigin;
      el.style.transformOrigin = 'bottom';
      const t0 = performance.now();
      const step = () => {
        if (squashTokenRef.current !== token) return;
        const u = Math.min((performance.now() - t0) / SQ_DURATION_MS, 1);
        const scale = squashScale(u, depth);
        el.style.transform = (facingRef.current === 'right' ? 'scaleX(-1) ' : '') + 'scaleY(' + scale + ')';
        if (u < 1) {
          squashRef.current = requestAnimationFrame(step);
        } else {
          squashRef.current = null;
          el.style.transformOrigin = origin;
          // 恢复纯镜像（若期间 switchTo 重置过 transform，也以镜像为准）
          el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        }
      };
      squashRef.current = requestAnimationFrame(step);
    };
    const stopSquash = () => {
      squashTokenRef.current++;
      if (squashRef.current !== null) {
        cancelAnimationFrame(squashRef.current);
        squashRef.current = null;
      }
    };

    const facingRef = useRef<'left' | 'right'>(facing);
    facingRef.current = facing;

    // ---- 点击 vs 拖拽 ----
    const handlePointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      // 只认左键：右键进入拖拽判定会与右键菜单打架（右键不拖拽，两端一致）
      if (e.button !== 0) return;
      // 抓取速度日志：stopThrow 之前读，否则飞行速度就没了；静止时记录 0
      const grabState = throwStateRef.current;
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' grab vx=' +
          (grabState ? Math.round(grabState.vx) : 0) +
          ' vy=' +
          (grabState ? Math.round(grabState.vy) : 0) +
          ' |v|=' +
          (grabState ? Math.round(Math.hypot(grabState.vx, grabState.vy)) : 0),
      );
      // 点击积分：**按下瞬间即触发**（不等松开）。读取 stopThrow 之前的飞行速度，
      // 在飞行中且达标 → 立即粒子爆发 + 积分弹窗；pressScoreFiredRef 标记本次按下已触发，
      // 松开的 click 据此不再重复弹、也不再播普通点击动画。
      pressScoreFiredRef.current = false;
      if (grabState) {
        const grabSpeed = Math.hypot(grabState.vx, grabState.vy);
        if (grabSpeed >= SCORE_MIN_SPEED) {
          const sc = clickScore(grabSpeed, size);
          pressScoreFiredRef.current = true;
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' click-score speed=' +
              Math.round(grabSpeed) +
              ' size=' +
              size +
              ' -> +' +
              sc,
          );
          spawnScoreBurst(e.clientX, e.clientY);
          mountScorePopup({ x: e.clientX, y: e.clientY, score: sc, speed: grabSpeed, size });
        }
      }
      // 空中抓取：停掉抛掷/漫游/弹簧跟随，从当前落点开始新拖拽
      stopThrow();
      stopDragFollow();
      stopMove();
      dragTrailRef.current = [];
      e.currentTarget.classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
      const rootEl = rootRef.current;
      let offX = 0;
      let offY = 0;
      if (rootEl) {
        const rr = rootEl.getBoundingClientRect();
        offX = e.clientX - (rr.left + rr.width / 2);
        offY = e.clientY - (rr.top + rr.height / 2);
        boxPxRef.current = { x: rr.left, y: rr.top };
      }
      dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY, offX, offY };
    };
    const handlePointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d.active) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.dragging = true;
        setDragging(true);
        setOnce(true);
        if (petAnims.drag.length) {
          const name = pick(petAnims.drag);
          console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [DRAG] ' + name);
          setAnim(name);
        }
      }
      // 记录指针轨迹（初速估算用；两端同构，桌面记录 screenX/Y）
      const now = performance.now();
      dragTrailRef.current = trimTrail([...dragTrailRef.current, { t: now, x: e.clientX, y: e.clientY }], now);
      // 弹簧目标 = 指针 - 抓取偏移 - half（包围盒左上角），跟随循环逐帧追赶（不再硬贴指针）
      dragTargetRef.current = { x: e.clientX - d.offX - halfW, y: e.clientY - d.offY - halfH };
      const rootEl = rootRef.current;
      if (rootEl) startDragFollow(rootEl);
      const stageEl = stageRef.current;
      if (stageEl) stageEl.style.transform = 'none';
    };
    const handlePointerUp = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      const wasDragging = d.dragging;
      d.active = false;
      d.dragging = false;
      e.currentTarget.classList.remove('dragging');
      stopDragFollow();
      if (wasDragging) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 100);
        setDragging(false);
        const stageEl = stageRef.current;
        if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)';
        if (petAnims.idle.length) setAnim(pick(petAnims.idle, animRef.current));
        setOnce(false);
        // 释放位置 = 弹簧跟随的实时包围盒左上角（不是指针目标：跟手滞后时落点跟随宠物实际位置）
        const bx = boxPxRef.current;
        const px = bx ? bx.x : e.clientX - d.offX - halfW;
        const py = bx ? bx.y : e.clientY - d.offY - halfH;
        // 初速估算：够快就抛掷（重力+边缘反弹+落地摩擦），否则原地放下
        const vel = estimateReleaseVelocity(dragTrailRef.current, performance.now(), cfg.physics);
        dragTrailRef.current = [];
        if (vel) {
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' release vx=' +
              Math.round(vel.vx) +
              ' vy=' +
              Math.round(vel.vy) +
              ' |v|=' +
              Math.round(Math.hypot(vel.vx, vel.vy)),
          );
          // 抛掷：飞行期间由 startThrow 的 rAF 直接写 left/top，落定后才提交 customPos
          startThrow(px, py, vel.vx, vel.vy);
        } else {
          // 原地放下：提交 customPos → React 按 rootStyle（含边界夹取）重排位置
          setCustomPos({ rx: (px + halfW) / window.innerWidth, ry: (py + halfH) / window.innerHeight });
        }
      }
    };
    const handleClick = () => {
      const d = dragRef.current;
      if (d.active || d.dragging || justDraggedRef.current) return;
      // 积分判定已在 pointerdown（按下即触发）完成：
      // 本次按下已触发过积分 → 只收手停住、**不**再播普通点击动画（粒子+弹窗即反馈）
      if (pressScoreFiredRef.current) {
        pressScoreFiredRef.current = false;
        stopThrow();
        stopMove();
        return;
      }
      stopThrow(); // 点击飞行中的宠物 = 收手停住（再播点击回应）
      stopMove();
      setOnce(true);
      if (!petAnims.clicks.length) return;
      const name = pick(petAnims.clicks);
      console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [CLICK] ' + name);
      pendingSquashRef.current = true; // 等新点击动画切到前台后 Q 弹（压新首帧）
      // 单动画点击（目标=当前播放）时 React 状态不变不会触发 useEffect 重放：
      // 递增 seq 强制 switchTo 走一遍（防重分支负责在动画相同时消费 Q 弹标记）
      setSeq((s) => s + 1);
      setAnim(name);
    };

    // ---- 右键菜单（统一自绘组件：树 + 渲染 + 样式与桌面共用 src/shared/menu.ts） ----
    // 注意：菜单是独立浮层，只在宠物命中区拦截右键（preventDefault + stopPropagation），
    // 绝不进入/改动 DSH 页面自己的菜单；浏览器端只有「碎碎念 / 回到初始位置 + 动作」——
    // 无「打开网站 / 查看余额」（打开网站=就在网页里；查看余额已由对话框 /balance 命令实现）。
    const handleMenuAction = (leaf: MenuLeaf) => {
      if (leaf.action === 'whisper') {
        // 手动碎碎念：强制 host 立即新生成一句并展示（绕过节流缓存；失败显式告警，不伪造文案）。
        // 手动触发不受 whisperEnabled 限制——该字段只关自动周期轮询，手动永远可用。
        console.info('[dsh-pet] 菜单触发碎碎念 pet=' + cfg.id);
        fetchWhisperTrigger('/dsh-pet-7340/whisper/trigger?pet=' + encodeURIComponent(cfg.id))
          .then((state) => {
            if (state.ok) {
              triggerWhisper(state.text);
            } else {
              console.warn(
                '[dsh-pet] 碎碎念手动触发失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''),
              );
            }
          })
          .catch((e) => console.warn('[dsh-pet] 碎碎念手动触发异常', e));
        return;
      }
      if (leaf.action === 'chat') {
        // 对话：最简输入框（shared 组件，与桌面同一份）——回车发送后弹窗消失，
        // 回复用**碎碎念同款显示**（说话动画 + 白色气泡 10s），只多一步用户输入。
        // 记忆经 host /chat 读写（memory.json，浏览器/桌面同一实例共享同一份记忆）。
        // 弹窗跟随宠物：基准是**身体命中区**（.dsh-pet-hit，与气泡同一定位源——
        // 桌宠在视频中间，视频框右上角 ≠ 宠物右上角），取身体右上角，超出视口自动夹回。
        if (chatRef.current) chatRef.current.close();
        const hitRect = stageRef.current?.querySelector('.dsh-pet-hit')?.getBoundingClientRect();
        chatRef.current = mountChatDialog({
          petId: cfg.id,
          baseUrl: '/dsh-pet-7340/chat',
          x: hitRect ? hitRect.right + 6 : window.innerWidth - 256,
          y: hitRect ? hitRect.top + 6 : 8,
          onReply: (reply) => {
            console.info('[dsh-pet] 对话回复 pet=' + cfg.id + '「' + reply + '」');
            triggerWhisper(reply); // 复用碎碎念链路：随机说话动画 + 气泡 10s 消失
          },
          onClose: () => {
            chatRef.current = null;
          },
        });
        return;
      }
      if (leaf.action === 'home') {
        // 回到初始位置：停漫游/移动/抛掷，清掉拖拽/漫游留下的会话位置，回配置角落
        stopThrow();
        stopMove();
        setCustomPos(null);
        return;
      }
      if (!leaf.anim) return;
      // 文字类（noMirror）朝右站姿是镜像的：点播前强制朝左，避免文字镜像（与随机链"朝右不选文字"同语义）
      if (isNoMirrorAnimation(petAnims.categories, leaf.anim) && facingRef.current === 'right') {
        setFacing('left');
      }
      // 点播移动动画：走真实移动（与随机移动同一套：边界检查 / 随机距离 / leadSec·tailSec 时段 / dir 计算），
      // 仅"选哪个动画"由菜单决定；边界内挪不动（false）退化为纯播放，仍能看到该动画
      if (petAnims.moves.actions.some((a) => a.name === leaf.anim)) {
        if (tryMove(leaf.anim) === false) {
          stopMove();
          setOnce(true);
          setAnim(leaf.anim);
        }
        return;
      }
      stopMove();
      setOnce(true);
      setAnim(leaf.anim);
    };
    const handleContextMenu = (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      // 工具项（碎碎念——手动触发**不受 whisperEnabled 限制**，该字段只影响自动周期轮询；
      // 回到初始位置，两端共用）+ 动作树（动作→分类→具体动画）
      const tree: MenuNode[] = [
        { label: '碎碎念', action: 'whisper' },
        { label: '对话', action: 'chat' },
        { label: '回到初始位置', action: 'home' },
        ...buildMenuTree(petAnims),
      ];
      if (!tree.length) return;
      e.preventDefault();
      e.stopPropagation(); // 不触碰 DSH 页面任何菜单/右键处理
      const d = dragRef.current;
      if (d.active || d.dragging || justDraggedRef.current) return;
      stopThrow(); // 菜单弹出前停住飞行中的宠物
      stopMove(); // 菜单悬停期间宠物不漫游
      if (menuRef.current) menuRef.current.close();
      menuRef.current = mountContextMenu({
        tree,
        x: e.clientX,
        y: e.clientY,
        onAction: handleMenuAction,
        // 菜单被点外/Esc 关闭（非菜单项路径）：句柄置空，避免残留引用
        onClose: () => {
          if (menuRef.current) menuRef.current = null;
        },
      });
    };

    // ---- 渲染 ----
    // 左右透明边余量（视频盒内宠物身体居中）：夹取按"身体"贴边——宠物能走到屏幕边缘，身体永不越界
    const sideAllow = (HIT_BOX.x0 / 640) * size;
    const stageStyle = dragging ? { transform: 'none' } : { transform: 'translateY(' + bottomPad + 'px)' };
    const rootStyle = customPos
      ? (() => {
          const rx = customPos.rx;
          const ry = customPos.ry;
          // 拖拽位置即松手位置：不做边界夹取——宠物可被拖到屏幕任意位置（含贴边/出界），
          // 松手不会被拉回；漫游/抛掷路径自身目标已界内，不受影响。
          return {
            left: rx * window.innerWidth - halfW + 'px',
            top: ry * window.innerHeight - halfH + 'px',
            right: 'auto',
            bottom: 'auto',
          };
        })()
      : {};
    const commonVideoProps = { muted: true, playsInline: true, autoPlay: true, title: cfg.name };
    const hitProps = {
      className: 'dsh-pet-hit',
      style: {
        left: (HIT_BOX.x0 / 640) * 100 + '%',
        top: (HIT_BOX.y0 / 360) * 100 + '%',
        width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + '%',
        height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + '%',
      },
      onClick: handleClick,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      onContextMenu: handleContextMenu,
      title: cfg.name,
    };
    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-root',
      'data-corner': corner,
      'data-facing': facing,
      style: Object.assign(
        { '--dsh-pet-size': size + 'px', '--dsh-pet-mx': margin.x + 'px', '--dsh-pet-my': margin.y + 'px' },
        rootStyle,
      ),
      children: [
        // 余额气泡（仅启用余额功能的宠物渲染；显示与否由 bubbleOn 控制）
        balance && balance.ok && cfg.balanceEnabled ? h(BalanceBubble, { state: balance, on: bubbleOn }) : null,
        // 碎碎念/对话气泡：**不受 whisperEnabled 限制**（该字段只关自动周期轮询的触发，
        // 见上头 useEffect 的 319 行门控）；whisperText 只由 triggerWhisper 设置——
        // 自动轮询被门控后不会触发，所以这里任何说话气泡（碎碎念/对话回复）都照常渲染
        whisperText ? h(WhisperBubble, { text: whisperText, on: whisperBubbleOn }) : null,
        h('div', {
          ref: stageRef,
          className: 'dsh-pet-stage',
          style: stageStyle,
          children: [
            h('video', Object.assign({}, commonVideoProps, { ref: videoARef, className: 'dsh-pet-video is-front' })),
            h('video', Object.assign({}, commonVideoProps, { ref: videoBRef, className: 'dsh-pet-video' })),
            h('div', hitProps),
          ],
        }),
      ],
    });
  }

  /** 多开容器：一次拉取成品配置 → 拍平 → 渲染多个 PetCard */
  function PetMulti() {
    const [pets, setPets] = useState<Pet[]>([]);
    const [ready, setReady] = useState(false);
    // 共享碰撞站场（宠物间碰撞）：每只 PetCard 注册自己的槽位；飞行中的宠物在 startThrow
    // 每帧读数碰撞。纯 ref 同步，不触发 React 重渲染。
    const arenaRef = useRef<{ slots: Record<string, PetCollisionSlot> }>({ slots: {} });
    // 文件宠物（非 main 条目的实例）：加载后填充；设置页 sync 过来的列表不含它们，这里统一合并回去
    const extrasRef = useRef<Pet[]>([]);
    // main 条目的条目级字段（设置页保存来的可编辑列表是裸实例，回填动画池/权重/周期用）
    const mainConfRef = useRef<Record<string, unknown>>({});
    // 主条目刷新周期（余额轮询等全局节奏用；合并器已填内置默认）
    const mainRefreshRef = useRef<Record<string, number>>({});
    // 余额状态（容器统一拉取，PetCard 共享；balanceTick 每次成功拉取递增，驱动事件动画）
    const [balance, setBalance] = useState<BalanceState | null>(null);
    const [balanceTick, setBalanceTick] = useState(0);
    // 碎碎念：轮询下沉到每只 PetCard（各自按自己的周期拉取 /whisper?pet=<id>，人设/文本/触发全部独立），
    // 容器不再持有共享状态——与「每只宠物单独触发对话」的产品语义一致。

    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          // 唯一配置入口：host readAllConfig 的成品聚合（绝对正确、字段填满），一次拉取，零校验零兜底
          const r = await fetch('/dsh-pet-7340/config');
          if (!r.ok) throw new Error('config HTTP ' + r.status);
          const merged = (await r.json()) as Record<string, Record<string, unknown>>;
          const flattened = flattenConfigPets(merged);
          if (!alive) return;
          mainConfRef.current = merged.main ?? {};
          mainRefreshRef.current = (merged.main?.eventsRefreshSec as Record<string, number> | undefined) ?? {};
          // 文件宠物单独留一份：设置页保存/恢复默认后自动合并回来
          extrasRef.current = flattened.filter((p) => p.extra);
          petBridge.current = flattened;
          // 「添加宠物」模板 = main 条目 pets[0]（内置默认或用户覆盖后的主宠物）
          petBridge.template = Array.isArray(merged.main?.pets)
            ? ((merged.main.pets as Pet[])[0] ?? undefined)
            : undefined;
          petBridge.sync = (list: Pet[]) => {
            // 设置页编辑的是 main 条目实例（裸实例，无条目级字段）：这里补吹 main 的
            // 动画池/权重/周期（与 flattenConfigPets 同规格），再合并文件宠物
            const mc = mainConfRef.current;
            const filled: Pet[] = list.map((p) => ({
              ...p,
              animations: mc.animations as Animations,
              animationWeights: mc.animationWeights as Weights,
              eventsRefreshSec: mc.eventsRefreshSec as Record<string, number>,
              assetRoot: 'main',
              extra: false,
            }));
            const next = [...filled, ...extrasRef.current];
            petBridge.current = next;
            setPets(next);
          };
          setPets(flattened);
          setReady(true);
        } catch (e) {
          console.error('[dsh-pet] 配置加载失败', e); // 成品拉取失败：显式报错，不静默隐藏
        }
      })();
      return () => {
        alive = false;
        petBridge.sync = () => {};
      };
    }, []);

    // 浏览器 overlay 只渲染 display ∈ {web, both} 的宠物；desktop / none 不参与网页显示
    const visiblePets = pets.filter((p) => isWebVisible(p.display));
    // 是否存在启用余额功能的宠物：全禁用时跳过余额轮询（不拉取 /dsh-pet-7340/balance，避免无意义的周期请求）
    const anyBalanceEnabled = visiblePets.some((p) => p.balanceEnabled);

    // 余额轮询：配置就绪（ready）且至少一只宠物启用余额后启动拉取一次，之后按 eventsRefreshSec.balance（秒）周期刷新；
    // 成功递增 balanceTick 触发事件动画；失败/不支持均不触发动画（错误显式 console.error，绝不显示伪造余额）
    useEffect(() => {
      if (!ready || !anyBalanceEnabled) return; // 未就绪 / 全宠物未启用余额：不启动轮询
      let alive = true;
      const refresh = async () => {
        try {
          const state = await fetchBalanceState();
          if (!alive) return;
          setBalance(state);
          if (state.ok) setBalanceTick((t) => t + 1);
          else if (state.reason === 'unsupported') {
            /* 无匹配服务商：按设计不显示、不播动画 */
          } else {
            console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
          }
        } catch (e) {
          if (alive) console.error('[dsh-pet] 余额拉取异常', e);
        }
      };
      void refresh();
      const intervalMs = Math.max(1000, (mainRefreshRef.current.balance ?? 1800) * 1000);
      const timer = window.setInterval(() => void refresh(), intervalMs);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [ready, anyBalanceEnabled]);
    // 手动 /balance 触发：1s 轻量轮询触发计数（host 端点响应头已禁止缓存），
    // 计数变化且余额启用时立即刷新余额并递增 balanceTick（与周期轮询同一触发路径）
    useEffect(() => {
      if (!ready || !anyBalanceEnabled) return;
      let alive = true;
      let prev = -1;
      const poll = async () => {
        try {
          const r = await fetch('/dsh-pet-7340/balance/trigger');
          if (!alive || !r.ok) return;
          const data = await r.json().catch(() => null);
          const count = data && typeof data.count === 'number' ? data.count : -1;
          if (count < 0) return;
          if (prev === -1) {
            prev = count; // 首次仅记基线：避免页面加载时重放历史触发
            return;
          }
          if (count === prev) return;
          prev = count;
          const state = await fetchBalanceState();
          if (!alive) return;
          setBalance(state);
          if (state.ok) setBalanceTick((t) => t + 1);
          else {
            console.error(
              '[dsh-pet] 手动触发余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''),
            );
          }
        } catch {
          /* 轻量轮询失败静默：下一周期再试 */
        }
      };
      void poll();
      const timer = window.setInterval(() => void poll(), 1000);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [ready, anyBalanceEnabled]);

    return ready
      ? visiblePets.map((p) => h(PetCard, { key: p.id, cfg: p as RuntimePet, balance, balanceTick, arena: arenaRef }))
      : null;
  }

  return PetMulti;
}
