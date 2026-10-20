// 宠物页面：单个宠物实例（PetCard）+ 多开容器（PetMulti）。
// 工厂形态与 settings.ts 一致：client 半侧不能顶层 import react，
// react 能力由 DSH 运行时注入（rt），组件在工厂内制造。
// 配置唯一入口 = GET /dsh-pet-7340/config 的**成品聚合**（host readAllConfig 保证绝对正确）：
// PetMulti 一次拉取 → flattenConfigPets 拍平成渲染列表，PetCard 直接读字段，零校验零兜底。
// 纯逻辑（选择/移动几何/余额/拍平）来自 src/shared —— 与桌面模式共用同一份源码。
import {
  pick,
  rollKind,
  pickCategoryAction,
  pickSlot,
  isEventAnim,
  poolIncludes,
  nextWorkStatusAnim,
} from '../shared/pickers';
import { planMove } from '../shared/motion';
import { flattenConfigPets, isWebVisible } from '../shared/config';
import { balanceEventIndex, balancePercent, decideBalanceNotice, type BalanceState } from '../shared/balance';
// 轮询统一状态 S：前端唯一的数据来源与渲染入口（拉取 / 拍平 / 比对都在 shared，两端同一份）
import {
  fetchState,
  flattenCounters,
  postAction,
  readBalance,
  readSay,
  readAnim,
  readPosition,
  readThrow,
  readLock,
  readWorkStatus,
  takeChanged,
  type PollState,
  type PositionMode,
  type SayCue,
  type LockState,
  type PetFacing,
} from '../shared/state';
import { WORK_STATUS_INDEX, type WorkStatusSnapshot } from '../shared/work-status';
import { makeBalanceBubble, makeWhisperBubble } from './bubble';
import { clickScore, SCORE_MIN_SPEED, mountScorePopup, spawnScoreBurst } from '../shared/score-popup';
import { CANVAS_H, FEET_Y, HIT_BOX, DRAG_THRESHOLD, PET_REF_WIDTH, ANIMATION_EXT } from '../shared/constants';
// 统一右键菜单：与桌面共用同一份组件（树 + 渲染 + 样式，src/shared/menu.ts）
import {
  buildMenuTree,
  displayMenuBranch,
  mountContextMenu,
  isNoMirrorAnimation,
  MENU_CSS,
  type MenuLeaf,
  type MenuNode,
} from '../shared/menu';
// 悬浮提示：与桌面共用同一份样式与摆位判据（替代原先挂在命中层上的原生 title 提示）
import { TOOLTIP_CLASS, TOOLTIP_CSS, TOOLTIP_GAP_RATIO, tooltipPlacement } from '../shared/tooltip';
// 对话弹窗：与桌面共用同一份组件（数据经 host /chat 读写同一份记忆）
import { mountChatDialog } from '../shared/chat';
import { registerPose } from './pose';
import { registerProgress } from './progress';
// 字体（全局配置 font）：种类 → CSS 字体栈、字号 → 最终 px。换算只在 shared 一处，
// 与桌面端共用同一份（fontStackOf / resolveFontPx），避免两端各算一套后漂移。
import { fontStackOf, resolveFontPx } from '../shared/fonts';
import { petBridge } from './settings';
import { notifyFromFrame } from './notify';

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
  throwVelocity,
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

/** 播放动画扩展名 = 共享常量（src/shared/constants.ts 的 ANIMATION_EXT，默认 .webm）。
 *  macOS Safari/WKWebView 需改共享常量/产物为 .mov（HEVC-with-Alpha）后自构建。 */
const THUMB_EXT = ANIMATION_EXT;

/** 余额气泡展示时长（ms）：定时自动消失，与动画生命周期解耦 */
const BUBBLE_DURATION_MS = 10 * 1000;

/** /state 长轮询的挂起时长（ms）：宿主在"版本没变"时最多挂这么久。
 *  1s 是**前端自己定的下限**——空闲时请求率因此与改造前完全一致（1 req/s），
 *  而叶子一变宿主立刻返回，前端不必再等满一拍。 */
const STATE_WAIT_MS = 1000;

/** 老宿主 / 请求失败时的轮询间隔（ms）。老宿主不认识 since/timeout，会**立刻**返回全量，
 *  不退避就是忙等；网络失败同理。 */
const STATE_FALLBACK_MS = 1000;

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
  // 触屏拖拽必需：缺 touch-action:none 时浏览器把手势判成页面滚动并发 pointercancel，
  // 宠物就不跟手指走；两条 -webkit-* 抑制长按选中与 iOS 长按呼出系统菜单
  '.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:url("/dsh-pet-7340/pic/cursor-grab.png") 16 16, grab;z-index:1;touch-action:none;-webkit-user-select:none;-webkit-touch-callout:none}',
  '.dsh-pet-hit.dragging{cursor:url("/dsh-pet-7340/pic/cursor-grabbing.png") 16 16, grabbing}',
  '@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
  // 统一右键菜单样式（与桌面注入同一份 MENU_CSS）
  MENU_CSS,
  // 悬浮提示样式（与桌面注入同一份 TOOLTIP_CSS）
  TOOLTIP_CSS,
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
    balanceNoticeTick,
    balanceManual,
    workStatus,
    workStatusTick,
    say,
    sayTick,
    animCue,
    animCueTick,
    posCue,
    posCueTick,
    throwCue,
    throwCueTick,
    lock,
    lockTick,
    arena,
  }: {
    cfg: RuntimePet;
    balance: BalanceState | null;
    balanceTick: number;
    balanceNoticeTick: number;
    /** 这次余额是不是**用户手动要的**（右键「查看余额」/ `/balance` 命令；host 在叶子里标 manual）。
     *  手动请求一律给答复：即使本宠物关掉了 balanceEnabled，也要弹气泡（开关只关自动轮询）。 */
    balanceManual: boolean;
    workStatus: WorkStatusSnapshot | null;
    workStatusTick: number;
    /** 本宠物的「说话指令」（碎碎念/命令气泡/对话回复/清空，容器从 S 分发下来）。
     *  `kind: 'clear'` = 收起气泡（POST /bubble/clear）；其余 = 弹一个气泡。 */
    say?: SayCue & { seq: number };
    sayTick: number;
    /** 本宠物的「点播动画」指令（其他插件经 POST /anim 写进 S；容器从 S 分发下来）。
     *  注意与组件内既有的 `anim`（**当前正在播的**动画名）区分：这个只是"要播什么"的指令。
     *  `name` 与 `url` **恰好一个**（host 判定层保证）：`name` = 池内名字，交给菜单动作处理函数
     *  （镜像修正 / 移动类走真实位移）；`url` = 第三方自带的完整地址，直接换源播一次、
     *  **不走菜单语义**（裸地址没有"是不是文字类 / 是不是移动类"这些属性）。
     *  `facing` = 调用方**显式指定**的朝向（可选）：undefined = 没指定 → **不动朝向**（不是回落 left）。 */
    animCue?: { name?: string; url?: string; seq: number; playbackId?: string; facing?: PetFacing };
    animCueTick: number;
    /** 本宠物的「位置」指令（其他插件经 POST /position 写进 S；容器从 S 分发下来）。
     *  `x`/`y` 是宠物**中心**的归一化坐标（0~1，host 写入前已夹取）；
     *  `mode` 决定走哪条路，`duration` 只有 `line` 模式才有意义（其余模式恒为 0）。 */
    posCue?: { x: number; y: number; mode: PositionMode; duration: number; seq: number };
    posCueTick: number;
    /** 本宠物的「抛掷」指令（其他插件经 POST /throw 写进 S；容器从 S 分发下来）。
     *  `angle` 单位度（`0` = 正右，逆时针为正）；`power` 是力度倍率。 */
    throwCue?: { angle: number; power: number; seq: number };
    throwCueTick: number;
    /** 本宠物的「占用锁」状态（其他插件经 POST /lock 写进 S；容器从 S 分发下来，issue #122 第 4 项）。
     *  `locked: true` = 第三方正占用这只宠物：本组件据此**冻结自己**（随机链不掷骰、暂停自播动画、
     *  忽略自动来源的余额/工作状态表现）。**`expiresAt` 是唯一真相**——宿主不会到点推送"锁没了"，
     *  这里自己定时解除（见 shared/state.ts 的 readLock）。 */
    lock?: LockState;
    lockTick: number;
    arena: ReactNS.MutableRefObject<{ slots: Record<string, PetCollisionSlot> }>;
  }) {
    // ---- 尺寸（由配置传入；容器/设置页更新后即时跟随）----
    const [size, setSize] = useState(cfg.size);
    // 字号（全局配置 font）：按本宠物尺寸算好最终 px 注入 root（气泡与悬浮提示读它）。
    // 随 size / cfg.font 变化即时重算——followPet 关闭时结果与 size 无关（见 resolveFontPx）。
    const fontPx = resolveFontPx(cfg.font, size);
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
    // 悬浮提示显隐（鼠标进/出命中区翻转；指针捕获期间由拖拽逻辑主动收起，见 handlePointerDown）
    const [tipOn, setTipOn] = useState(false);
    const tipRef = useRef<HTMLDivElement | null>(null);
    const [customPos, setCustomPos] = useState<null | { rx: number; ry: number }>(null);
    // 初始角落与边距（来自配置；可被容器更新覆盖）
    const [corner, setCorner] = useState<Corner>(cfg.position.corner);
    const [margin, setMargin] = useState({ x: cfg.position.marginX, y: cfg.position.marginY });
    // 余额气泡显隐（事件触发时显示，10s 后定时自动消失）
    const [bubbleOn, setBubbleOn] = useState(false);
    const bubbleTimerRef = useRef<number | null>(null);
    // 碎碎念气泡（显隐定时器与余额气泡各自独立：10s 各自计时互不干扰；渲染走单槽优先级）
    const [whisperBubbleOn, setWhisperBubbleOn] = useState(false);
    const whisperBubbleTimerRef = useRef<number | null>(null);
    // 碎碎念当前文本（本宠物独立生成的句子）+ 配图名称（开启配图时由 host 随机抽定，随文本一起来）
    const [whisperText, setWhisperText] = useState<string | null>(null);
    const [whisperImage, setWhisperImage] = useState<string | undefined>(undefined);
    /** 配图的 url 形态（第三方自带地址；与 whisperImage 二选一，见 triggerWhisper） */
    const [whisperUrl, setWhisperUrl] = useState<string | undefined>(undefined);
    // 工作状态气泡：DSH 会话状态联动（workStatusEnabled 开启时）——终态 10s 自动收起、非终态常驻
    const [workBubbleOn, setWorkBubbleOn] = useState(false);
    const workBubbleTimerRef = useRef<number | null>(null);
    const [workText, setWorkText] = useState<string | null>(null);
    // 右键菜单（统一自绘组件）：当前挂载的 close() 句柄，卸载/重开前清理
    const menuRef = useRef<{ close: () => void } | null>(null);
    // 对话弹窗（与桌面共用 shared 组件）：当前挂载的 close() 句柄，卸载/重开前清理
    const chatRef = useRef<{ close: () => void } | null>(null);

    // 配置变化即时跟随（容器重新合并 / 设置页保存后通过 petBridge.reload 触发）
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
    /** 「这一段直接播这个地址」的一次性交接位（POST /anim 的 url 形态，issue #122 第 1 条）。
     *  为什么用 ref 而不是 state：它只在**设置它的那一拍**有效——switchTo 一进来就取走并清空，
     *  之后任何一次普通换源都不会误用上一个地址（换成 state 的话，"清空"本身会再触发一次 effect）。 */
    const cueUrlRef = useRef<string | null>(null);
    // 播放回执（issue #122 第 3 项）：待归属的第三方点播编号**随 anim 一起经 state 下发**。
    // 为什么用 state 而不是 ref：目标动画与当前动画相同时客户端有防重语义（不换源），
    // ref 会把这个编号留下、串到后续某次自播动画的换源上；state 变化本身会驱动 effect 再跑一趟，
    // 那一趟正好落进防重分支，于是"本来就在播"也能被如实回成 playing。
    const [cuePlayback, setCuePlayback] = useState<string | null>(null);
    /** 当前正在播的第三方点播编号（null = 自播动画，不上报）；播完 / 失败 / 被打断后清空 */
    const playingPlaybackRef = useRef<string | null>(null);
    const genRef = useRef(0);
    // ---- 占用锁（issue #122 第 4 项）----
    // `frozenRef` = 本宠物此刻是否被第三方占用（冻结）。初值就从叶子算：页面刷新时若正处在
    // 占用期间，第一帧就该是冻的，而不是先动一下再冻。
    // **用 ref 而不是 state**：冻结/解冻只影响"播什么、动不动"，不参与渲染；而随机链入口
    // （pickNext）与几个事件 effect 都在更早的闭包里读它，读 ref 才是"此刻"。
    const frozenRef = useRef(lock?.locked === true && lock.expiresAt > Date.now());
    /** 解冻定时器：宿主不会到点推送"锁没了"，这里按叶子里的 expiresAt 自己解除 */
    const lockTimerRef = useRef<number | null>(null);
    const dragRef = useRef({
      active: false,
      dragging: false,
      sx: 0,
      sy: 0,
      offX: 0,
      offY: 0,
      // 触屏长按定时器（只有触摸/笔走这条路径，见 handlePointerDown）；null = 当前没有待触发的长按
      lpTimer: null as ReturnType<typeof setTimeout> | null,
    });
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
    // workStatus 最新值同步：handleEnded 的 onended 闭包注册时可能早于状态更新，护栏用 ref 读当前值
    const workStatusRef = useRef(workStatus);
    workStatusRef.current = workStatus;
    // fetch+blob 素材加载：两个视频槽各自的 blob URL（换新前 revoke 旧 URL，卸载时全部 revoke）
    const blobUrlRef = useRef<{ a: string | null; b: string | null }>({ a: null, b: null });
    // 卸载竞态防护：mountedRef 由 effect 维护（兼容 StrictMode 双挂载）；inflightRef 记录在途 fetch，
    // 卸载时统一 abort——否则卸载后完成的 fetch 会再创建 blob URL 且无人 revoke（泄漏到页面销毁）。
    const mountedRef = useRef(false);
    const inflightRef = useRef<AbortController[]>([]);

    /**
     * 播放回执上报（issue #122 第 3 项）：把这一段点播的**真实**状态告诉 host。
     *
     * 只对第三方点播（带 playbackId）上报；自播动画（随机链 / 点击 / 拖拽 / 碎碎念 / 余额…）不报。
     * 为什么必须有这一层：host 只知道"受理了"，不知道播没播完——动画在浏览器里播，只有这里知道真相。
     * 失败静默（postAction 从不抛）+ 一条 warn：回执是附加能力，绝不能因为它把播放本身搞挂。
     */
    const reportPlayback = (playbackId: string, status: string, reason?: string): void => {
      void postAction(
        '/dsh-pet-7340/playback/' + encodeURIComponent(playbackId) + '/report',
        reason === undefined ? { status } : { status, reason },
      ).then((ok: boolean) => {
        if (!ok) {
          console.warn('[dsh-pet] 播放回执未送达 pet=' + cfg.id + ' id=' + playbackId + ' status=' + status);
        }
      });
    };

    const switchTo = (next: string, nextOnce: boolean, cuePlaybackId: string | null) => {
      // 一次性消费：立刻清掉待归属编号（清空会再跑一趟本 effect，那一趟 cuePlaybackId 为 null，
      // 落进下面的防重分支，无副作用）
      if (cuePlaybackId !== null) setCuePlayback(null);
      // 「这一段直接播这个地址」同样一次性取走并清空。**必须早于任何 return**——否则防重分支
      // 提前返回时它会留到下一次普通换源上，把那个动画误播成这个地址。
      const cueUrl = cueUrlRef.current;
      cueUrlRef.current = null;
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
        // 这次点播的目标**本来就在播**（没有换源，但确实在播）→ 如实回 playing，
        // 否则调用方只能干等到 timeout（host 对终态幂等，重复上报无害）
        if (cuePlaybackId !== null) {
          playingPlaybackRef.current = cuePlaybackId;
          reportPlayback(cuePlaybackId, 'playing');
        }
        return;
      }
      const gen = ++genRef.current;
      pendingRef.current = { anim: next, once: nextOnce, gen };
      const target = frontRef.current === 0 ? videoBRef : videoARef;
      const el = target.current;
      if (!el) return;
      // 诊断：事件池动画被切换（含 workStatus 触发/循环续播/其他事件顶替），once 反映 loop 语义
      const inEvents = isEventAnim(petAnims.events, next);
      if (inEvents) {
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            cfg.id +
            ' switch ' +
            next +
            ' once=' +
            nextOnce,
        );
      }
      // 素材地址两条路（issue #122 第 1 条）：url 形态直接用第三方给的**完整地址**（宿主已卡在
      // http/https）；name 形态照旧按「素材根 + 名字」拼（名字即文件名）。下面的 fetch + blob
      // 一段两条路共用，不做区分——正常请求 URL 就是。
      const assetUrl =
        cueUrl ??
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
      // 元素级失败（解码 / 格式不支持）：既有实现**完全没有检测**（只表现为"点了没反应"），
      // 这里补一条回执——只上报，不改播放控制（换源时与 onended 一起清掉，见 onReady）
      el.onerror = cuePlaybackId === null ? null : () => reportPlayback(cuePlaybackId, 'failed', 'decode-error');
      // 素材加载走 fetch+blob：一次拿全整文件，绕开 video 流式加载在 DSH WebServer 上偶发的
      // stalled/连接竞争（用户环境实测：慢点 5 次全部 stall、动画永不切换）。10s 超时兜底。
      // cache 用默认策略：服务端 cache-control 是 max-age=3600（src/host/index.ts:140），有效期内
      // 本来就不走网络；**不能用 force-cache**——它会连过期条目也照用，用户把
      // $DSH_HOME/dsh-pet/main-animation/webm/ 里的自定义动画换成同名文件后会一直看到旧动画。
      const targetIsB = frontRef.current === 0;
      const ac = new AbortController();
      inflightRef.current.push(ac);
      const fetchTimer = window.setTimeout(() => ac.abort(), 10000);
      fetch(assetUrl, { cache: 'default', signal: ac.signal })
        .then((r) => {
          if (!r.ok) throw new Error('asset HTTP ' + r.status);
          return r.blob();
        })
        .then((blob) => {
          window.clearTimeout(fetchTimer);
          const ix = inflightRef.current.indexOf(ac);
          if (ix !== -1) inflightRef.current.splice(ix, 1);
          if (!mountedRef.current) return; // 已卸载：不再创建 blob URL / 不操作已 detach 的 video
          if (pendingRef.current?.gen !== gen) return; // 已被更新的切换覆盖：丢弃本次加载
          const slot = targetIsB ? 'b' : 'a';
          const oldUrl = blobUrlRef.current[slot];
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          const obj = URL.createObjectURL(blob);
          blobUrlRef.current[slot] = obj;
          el.src = obj;
          el.load();
        })
        .catch((err) => {
          window.clearTimeout(fetchTimer);
          const ix = inflightRef.current.indexOf(ac);
          if (ix !== -1) inflightRef.current.splice(ix, 1);
          if (!mountedRef.current) return; // 卸载后的 abort：静默
          if (pendingRef.current?.gen !== gen) return; // 已被更新的切换覆盖
          pendingRef.current = null; // 释放挂起的 pending：后续点击不再被困在防重/覆盖循环里
          // 素材没拿到 → 这一段点播不可能播起来，如实回 failed（而不是让调用方干等）
          if (cuePlaybackId !== null) {
            if (playingPlaybackRef.current === cuePlaybackId) playingPlaybackRef.current = null;
            reportPlayback(cuePlaybackId, 'failed', 'asset-load');
          }
          console.warn(
            '[dsh-pet] 素材加载失败 pet=' +
              cfg.id +
              ' anim=' +
              next +
              '：' +
              (err instanceof Error ? err.message : String(err)) +
              '（已释放本次切换）',
          );
        });
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
          old.current.onerror = null;
          old.current.pause();
          // 被换下去的那一段若属第三方点播且没播完 → 如实回 cancelled。
          // （"被新点播顶掉"由 host 在受理时直接标记，这里补的是**非点播**打断：
          //   点击 / 拖拽 / 碎碎念 / 余额 / 工作状态 / 空闲回收。）
          const outgoing = playingPlaybackRef.current;
          if (outgoing !== null && outgoing !== cuePlaybackId) {
            reportPlayback(outgoing, 'cancelled', 'superseded');
          }
        }
        frontRef.current = frontRef.current === 0 ? 1 : 0;
        pendingRef.current = null;
        playingPlaybackRef.current = cuePlaybackId;
        el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        el.play()
          .then(() => {
            // 只有 play() 兑现才代表"确实开始出画"（loadeddata 只代表可解码）
            if (cuePlaybackId !== null) reportPlayback(cuePlaybackId, 'playing');
          })
          .catch(() => {
            // 自动播放被拒 / 元素不可播：既有实现静默吞掉 → 现在如实回 failed（不改播放控制）
            if (cuePlaybackId === null) return;
            if (playingPlaybackRef.current === cuePlaybackId) playingPlaybackRef.current = null;
            reportPlayback(cuePlaybackId, 'failed', 'play-rejected');
          });
        // 点击 Q 弹：等新动画就位后才压（压的是新点击动画的首帧，与桌面一致）
        if (pendingSquashRef.current) {
          pendingSquashRef.current = false;
          startSquash(el);
        }
        if (pendingMoveRef.current) startMoveDrive(el);
      };
      el.addEventListener('loadeddata', onReady);
    };

    // ---- 状态驱动播放 ----
    useEffect(() => {
      switchTo(anim, once, cuePlayback);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anim, once, seq, cuePlayback]);
    useEffect(() => {
      mountedRef.current = true;
      // 「实况」口子（issue #122 第 1 条）：把这一页里这只宠物的实时位置/朝向注册给 Cordis 只读
      // 服务 `petApi7340`（见 ./pose）。**按需读**——消费者每次调用都走这个闭包取当前值，所以走位、
      // 抛掷、拖拽**中途**也能读到，不是快照。
      // 坐标与 POST /position 同一口径：宠物**中心**的归一化 0~1。
      const unregisterPose = registerPose(cfg.id, () => ({
        x: currentCenterX() / window.innerWidth,
        y: currentCenterY() / window.innerHeight,
        facing: facingRef.current,
      }));
      // 「播放进度」口子（issue #122 第 2 条）：侧栏要跟着视频时间走，得按帧读，做成 HTTP 就是每秒
      // 几十次回环，所以走同一个 Cordis 入口（见 ./progress）。读的是**前台**那个 video：A/B 双缓冲
      // 切换期间 back 元素还停在上一段的位置，读它会跳。
      const unregisterProgress = registerProgress(cfg.id, () => {
        const el = frontRef.current === 0 ? videoARef.current : videoBRef.current;
        const playbackId = playingPlaybackRef.current;
        const anim = animRef.current;
        if (el === null) {
          // 首帧还没挂上元素：给出可解析的零值，别让调用方拿到 undefined
          return { playbackId, anim, currentTime: 0, duration: 0, paused: true, buffering: false };
        }
        // duration 在元数据就绪前是 NaN；传给第三方没法处理，统一成 0
        const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        return {
          playbackId,
          anim,
          currentTime: el.currentTime,
          duration,
          paused: el.paused,
          buffering: el.readyState < 3 || el.seeking,
        };
      });
      const bu = blobUrlRef.current;
      const inflight = inflightRef.current;
      return () => {
        mountedRef.current = false;
        unregisterPose(); // 卸载即摘除：口子静默失效比读到陈旧值安全
        unregisterProgress();
        for (const c of inflight) c.abort();
        inflight.length = 0;
        stopMove();
        stopDragFollow();
        stopThrow();
        stopSquash();
        if (bu.a) URL.revokeObjectURL(bu.a);
        if (bu.b) URL.revokeObjectURL(bu.b);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载/卸载各跑一次：闭包读的是 refs 与稳定 props
    }, []);
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
    // 余额事件：容器拉取成功后递增 balanceTick → 按档位播放事件动画 + 弹气泡。
    // 两条门控分得很清楚：
    //  - 弹气泡：**手动请求**（右键「查看余额」/ `/balance` 命令，host 在叶子里标了 manual）无条件弹——
    //    用户问了就得有答复，哪怕这只宠物关了 balanceEnabled、哪怕服务商没有百分比语义；
    //    自动轮询则要求 balanceEnabled 且有百分比依据。与碎碎念同一条原则：开关只关自动，不关手动。
    //  - 档位动画：始终只属于启用余额的宠物（关掉开关的宠物不该因为被点了一次菜单就突然演一遍）。
    const prevTickRef = useRef(0);
    useEffect(() => {
      if (balanceTick === 0 || balanceTick === prevTickRef.current) return;
      prevTickRef.current = balanceTick;
      // 占用锁：锁生效时**不看自动余额**（那是宠物自己的行为）；**手动**请求照常放行
      // （用户右键「查看余额」/ `/balance` 命令——用户交互优先，这是既定口径）。
      // 判在 tick 消费**之后**：占用期间这一拍就当过去了，解冻后不补播（事件是瞬时的）。
      if (frozenRef.current && !balanceManual) return;
      if (!balance || !balance.ok) return;
      if (!cfg.balanceEnabled && !balanceManual) return; // 自动轮询受开关门控；手动无条件通过
      const p = balancePercent(balance);
      if (balanceManual || p !== undefined) {
        setBubbleOn(true);
        // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
        if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
        bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
      }
      if (!cfg.balanceEnabled) return; // 档位动画只属于启用余额的宠物
      if (p === undefined) return; // 当前数据源没有百分比语义（如 DeepSeek 余额），不触发档位动画
      const pool = petAnims.events?.balance;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
        return;
      }
      const idx = balanceEventIndex(p);
      const slot = pool[idx];
      if (!slot) {
        console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
        return;
      }
      const name = pickSlot(slot, animRef.current); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复）
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
      setOnce(true);
      setAnim(name);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [balanceTick]);

    // 余额不可用（服务商未登记 / 缺凭证 / 抓取失败）：容器判定该提示时递增 balanceNoticeTick
    // → 本宠物只弹「文字说明」气泡，不播档位动画（非 ok 没有百分比语义，档位动画无从映射）。
    // 门控：自动轮询要求 balanceEnabled；**手动请求无条件弹**（用户问了就该有答复，包括"服务商不支持"这件事）。
    const prevNoticeRef = useRef(0);
    useEffect(() => {
      if (!cfg.balanceEnabled && !balanceManual) return; // 自动轮询受开关门控；手动无条件通过
      if (balanceNoticeTick === 0 || balanceNoticeTick === prevNoticeRef.current) return;
      prevNoticeRef.current = balanceNoticeTick;
      // 占用锁：同上面那条余额事件——自动来源不看，手动请求照常（用户问了就得有答复）
      if (frozenRef.current && !balanceManual) return;
      if (!balance || balance.ok) return;
      setBubbleOn(true);
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [balanceNoticeTick]);

    // 工作状态联动：容器统一轮询 /state 的 sections.workStatus 递增 workStatusTick → 本宠物（workStatusEnabled 开启时）
    // 按 events.workStatus 档位播动画 + 弹文本气泡。
    // 气泡驻留语义：thinking/working/result/waiting（"事情还没完"）常驻显示，直到状态切走；
    //   success/error（"这事结束了"）10s 自动收起；
    //   state=null（空闲，回合 aborted 等）收起气泡回待机。
    // 动画循环语义：进行中档位循环播（once=false），终态档位播一遍（once=true）回 idle 链。
    const prevWorkTickRef = useRef(0);
    // 调试日志：上一档位（null=空闲；undefined=启动后首次触发，显示为 null）
    const prevWorkStateRef = useRef<string | null | undefined>(undefined);
    useEffect(() => {
      if (!cfg.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫
      if (workStatusTick === 0 || workStatusTick === prevWorkTickRef.current) return;
      prevWorkTickRef.current = workStatusTick;
      // 占用锁：锁生效时不响应工作状态（它是**自动**来源——任务事件驱动的，没有"用户手动要"这条路）。
      // 判在 tick 消费**之后**：占用期间的状态变化当过去了，解冻时由 applyFreeze 的
      // resumeWorkStatusAnim() 重新对齐**当前**状态，所以不会停在旧档位上。
      // 注意这里不挡宿主：`sections.workStatus` 是所有宠物共用一份，宿主"跳过写入"会连带静音
      // 别的宠物（issue #122 要的是"只控制指定 main"），所以按宠物在渲染端忽略。
      if (frozenRef.current) return;
      if (!workStatus || workStatus.state === null) {
        // 调试：状态回空闲（仅打印切换日志；动画改成"播完即停"，见下）
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            cfg.id +
            ' ' +
            (prevWorkStateRef.current ?? 'null') +
            '->null    播完即停（回待机，收起气泡）',
        );
        prevWorkStateRef.current = null;
        // 回空闲：把正在**循环播**的进行中档位动画改成"播完即停"。
        // 进行中档位走 setOnce(false)（el.loop=true、el.onended=null），ended 永不触发；而这里不切
        // 动画（原设计"由常规动画链回待机"），链因此拿不到推进信号 —— 宠物会一直卡在那段工作动画上，
        // 不交互就回不去（issue #61 报告的症状）。这里只把当前段改成播完即停：它结束后自然走
        // handleEnded → resumeWorkStatusAnim() 返回 false → 回 idle；工作期间的原生 loop 不受影响。
        // 与桌面端 runtime/electron-helper/events.js 的空闲分支同一处修复，两端语义保持一致。
        if (poolIncludes(petAnims.events?.workStatus ?? [], animRef.current)) {
          const front = frontRef.current === 0 ? videoARef.current : videoBRef.current;
          if (front) {
            front.loop = false;
            front.onended = handleEnded;
          }
        }
        // 空闲：收起常驻气泡
        if (workBubbleTimerRef.current !== null) window.clearTimeout(workBubbleTimerRef.current);
        workBubbleTimerRef.current = null;
        setWorkText(null);
        setWorkBubbleOn(false);
        return;
      }
      const pool = petAnims.events?.workStatus;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
        return;
      }
      const idx = WORK_STATUS_INDEX[workStatus.state];
      const slot = pool[idx];
      if (slot === undefined) {
        console.error('[dsh-pet] work-status 档位索引越界：state=' + workStatus.state + ' idx=' + idx);
        return;
      }
      const name = pickSlot(slot, animRef.current); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复）
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' ' +
          (prevWorkStateRef.current ?? 'null') +
          '->' +
          workStatus.state +
          '    ' +
          name,
      );
      const stateChanged = prevWorkStateRef.current !== workStatus.state;
      prevWorkStateRef.current = workStatus.state;
      stopMove();
      // 气泡文本：任务详情（todo/write 提供，如"正在做 X"）优先，否则从条目级配置
      // workStatusTexts[档位]（数组）随机抽一句；整字段/整档缺失 = 不弹文本，只播动画。
      const textGroup = Array.isArray(cfg.workStatusTexts) ? cfg.workStatusTexts[idx] : undefined;
      const configuredText =
        Array.isArray(textGroup) && textGroup.length > 0
          ? textGroup[Math.floor(Math.random() * textGroup.length)]
          : undefined;
      // 文本总是更新（任务详情可能在同一状态下变化）
      setWorkText(workStatus.task ?? configuredText ?? null);
      const terminal = workStatus.state === 'success' || workStatus.state === 'error';
      // 气泡点亮/收起只在状态变化时动作：同状态后续 tick（todo 文案更新、其它会话事件搅动 ts）
      // 不重新点亮**已自动收起的终态气泡**——否则"任务完成"的气泡会被后续 ts 变化反复弹回（Bug 2）；
      // 非终态同状态 tick 气泡本就常驻，无需重复点亮。
      if (stateChanged) {
        setWorkBubbleOn(true);
        if (workBubbleTimerRef.current !== null) window.clearTimeout(workBubbleTimerRef.current);
        workBubbleTimerRef.current = terminal
          ? window.setTimeout(() => setWorkBubbleOn(false), BUBBLE_DURATION_MS)
          : null; // 非终态：常驻，不设自动收起
      }
      // 循环语义：终态播一遍回 idle（once=true）；非终态单候选档位 once=false 无限循环；
      // 非终态多候选档位 once=true 播一遍 → ended 由 handleEnded 护栏轮换到下一候选（长时间状态不单段重复）
      const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
      setOnce(terminal || rotating);
      setAnim(name);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workStatusTick]);

    // 说话（碎碎念周期 / 命令气泡 / 对话回复 / 清空**四合一**）：容器统一轮询 /state 后，把属于
    // 本宠物的 pets.<id>.say 分发下来；seq 变化即执行——`clear` 形态收起气泡，其余弹气泡。
    // 改造前这里是两条独立轮询（/whisper 周期 + /broadcast 1s）、host 侧也是两个缓存；
    // 现在只有一个数据源（S），"首拉记基线"由容器统一处理。
    // 不受 whisperEnabled 门控：那个字段只关自动周期，命令/对话的手动语义永远可用。
    const prevSaySeqRef = useRef(0);
    useEffect(() => {
      if (!say || say.seq === prevSaySeqRef.current) return;
      prevSaySeqRef.current = say.seq;
      if (say.kind === 'clear') {
        clearWhisperBubble();
        return;
      }
      triggerWhisper(say.text, say.image, say.url, say.duration, say.anim);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sayTick]);

    // 点播动画（其他插件经 POST /anim 写进 S）：容器统一轮询后把属于本宠物的
    // pets.<id>.anim 分发下来；seq 变化即播——**走与右键菜单完全同一个处理函数**，
    // 所以"镜像修正 / 移动类走真实位移 / 其余播一遍"的语义天然一致，这里不重写一遍。
    const prevAnimSeqRef = useRef(0);
    useEffect(() => {
      if (!animCue || animCue.seq === prevAnimSeqRef.current) return;
      prevAnimSeqRef.current = animCue.seq;
      // 朝向（POST /anim 的 facing，可选）：**必须在换源之前落地**——switchTo 是在 onReady 里按
      // facingRef.current 贴 scaleX(-1) 的，晚一步就赶不上这一趟。
      // 且必须连 facingRef **一起立即同步**：setFacing 是异步的，只调它的话本次 switchTo 读到的
      // 还是旧朝向（与 handleEnded 里 turn 翻转同一个道理）。
      // **没传 facing 就一个字都不动**：保持宠物当前朝向，而不是回落 left。
      const explicitFacing = animCue.facing !== undefined;
      if (animCue.facing !== undefined) {
        setFacing(animCue.facing);
        facingRef.current = animCue.facing;
      }
      // url 形态（issue #122 第 1 条）：第三方自带的素材地址。**不走 handleMenuAction**——
      // 那套是菜单语义（文字类先强制朝左的镜像修正、移动类走真实位移），裸地址没有这些属性。
      // 这里只做"插播一段"：停掉漫游/移动，换源播一次，播完由 handleEnded 回到正常动画链
      // （与菜单点一下的 once 语义相同）。
      if (animCue.url !== undefined) {
        stopMove();
        cueUrlRef.current = animCue.url;
        setOnce(true);
        setSeq((s) => s + 1); // 同一个地址连播两次时 React 状态不变，递增 seq 强制 switchTo 走一遍
        setAnim(animCue.url);
        setCuePlayback(animCue.playbackId ?? null);
        return;
      }
      if (animCue.name === undefined) return;
      // keepFacing：显式指定的朝向优先于"文字类强制朝左"那条镜像修正
      handleMenuAction({ label: animCue.name, anim: animCue.name }, animCue.playbackId, explicitFacing);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [animCueTick]);

    // 位置指令（其他插件经 POST /position 写进 S）：容器统一轮询后把属于本宠物的
    // pets.<id>.position 分发下来；seq 变化即执行。用户正按着宠物时整拍丢弃（见 applyPositionCue）。
    const prevPosSeqRef = useRef(0);
    useEffect(() => {
      if (!posCue || posCue.seq === prevPosSeqRef.current) return;
      prevPosSeqRef.current = posCue.seq;
      applyPositionCue(posCue.x, posCue.y, posCue.mode, posCue.duration);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [posCueTick]);

    // 抛掷指令（其他插件经 POST /throw 写进 S）：同上，seq 变化即执行。
    const prevThrowSeqRef = useRef(0);
    useEffect(() => {
      if (!throwCue || throwCue.seq === prevThrowSeqRef.current) return;
      prevThrowSeqRef.current = throwCue.seq;
      applyThrowCue(throwCue.angle, throwCue.power);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [throwCueTick]);

    /** 收起说话气泡（`POST /bubble/clear` 的落点）。
     *  **只动气泡**：正在播的动画、余额气泡、工作状态气泡都不碰——气泡与动作是两把锁、
     *  分别释放（issue #122 第 5 条）。顺带清掉文本/配图，免得残留内容在下次渲染时闪一下。 */
    const clearWhisperBubble = () => {
      if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
      whisperBubbleTimerRef.current = null;
      setWhisperBubbleOn(false);
      setWhisperText(null);
      setWhisperImage(undefined);
    };

    // 碎碎念触发（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（与动画解耦）。
    // image：host 侧随机抽定的配图名称（未开配图/池为空则 undefined）——与文本同一次触发一起来。
    // duration / anim：`POST /broadcast` 的两个新参数（issue #122 第 5 条）。两者**互相独立**：
    //   - `anim === false` 时整段跳过动画联动——不查池、不换源，也不 stopMove()
    //     （stopMove 属于"开始播这段动画"的一部分，不是弹气泡的副作用）。
    //     于是配置里缺 events.whisper 时，只弹气泡这条路照样走得通。
    //   - `duration === 0` 表示"这一条不显示"：**不动当前已在显示的气泡**
    //     （要收起它请用 POST /bubble/clear，两件事不重叠）。
    // image / url：配图的两种形态，二选一（host 判定层保证）。image = 该条目表情包池内的名称
    // （按素材根拼路径取），url = 第三方自带的完整地址（直接用）。判别位在字段名上，不靠嗅探。
    const triggerWhisper = (text: string, image?: string, url?: string, duration?: number, anim?: boolean) => {
      let name: string | null = null;
      if (anim !== false) {
        const pool = petAnims.events?.whisper;
        if (!pool || pool.length === 0) {
          console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
          return;
        }
        // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机
        name = pickSlot(pick(pool, animRef.current), animRef.current);
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' whisper pet=' +
          cfg.id +
          (name === null ? ' （不联动动画）' : ' -> [' + name + ']') +
          ' 「' +
          text +
          '」',
      );
      // 先起动画：它与气泡时长是两个独立参数（duration=0 时动画照播、只是不弹泡）
      if (name !== null) {
        stopMove();
        setOnce(true);
        setAnim(name);
      }
      if (duration === 0) return;
      setWhisperText(text);
      setWhisperImage(image);
      setWhisperUrl(url);
      setWhisperBubbleOn(true);
      // 气泡定时消失（与动画解耦；重复触发先清旧定时器）
      if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
      whisperBubbleTimerRef.current = window.setTimeout(
        () => setWhisperBubbleOn(false),
        duration ?? BUBBLE_DURATION_MS,
      );
    };
    useEffect(() => {
      const onResize = () => setCustomPos((prev) => (prev ? { ...prev } : prev));
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    // ---- 动画链：播完按权重选下一个 ----
    const pickNext = () => {
      // 占用锁（issue #122 第 4 项）：锁生效时**不掷骰**。这里是随机链的**唯一**入口
      // （只有动画播完才会走到），所以一句判断就把随机动画、随机转向、自主走位一起停住——
      // 宠物停在最后一帧，等持锁者的下一条指令（那走 /anim，不经这里）。
      if (frozenRef.current) return;
      const animations = petAnims;
      const animationWeights = petWeights;
      const roll = Math.random();
      // 宠物固定（pets[].fixedEnabled）：掷骰时把「转向 / 移动」两档权重按 0 算——随机链不再让
      // 宠物自己翻朝向或走开（份额自然并入随机小动作）。右键菜单点播与 /anim 接口不走这里，
      // 故不受影响（见 handleMenuAction）。
      const k = rollKind(roll, animationWeights, { fixed: cfg.fixedEnabled });
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

    // 互动打断后恢复：workStatus 非终态（thinking/working/result/waiting）期间，点击/拖拽等瞬时
    // 互动结束应立即回到对应档位循环动画（打断-恢复语义）；无状态/终态返回 false 不接管，
    // 调用方走原逻辑（回 idle / 随机池）。
    const resumeWorkStatusAnim = (): boolean => {
      // 占用锁：冻结期间不许由这条路把工作状态动画点回来。它读的是**实时**状态（`workStatusRef`），
      // 跟 `workStatusTick` 无关——持锁者每投一次带 `anim` 的气泡，说话动画播完就会经 handleEnded
      // 走到这里。自防一道，是为了让"冻结期间不恢复档位动画"成为**这个函数自己的契约**，
      // 而不是靠每个调用方都记得先判冻结。解冻路径不受影响：`applyFreeze(false)` 是先把
      // `frozenRef` 置 false 再调这里。
      if (frozenRef.current) return false;
      const ws = workStatusRef.current;
      if (!ws || !ws.state || ws.state === 'success' || ws.state === 'error') return false;
      const pool = petAnims.events?.workStatus;
      if (!pool || pool.length === 0) return false;
      const idx = WORK_STATUS_INDEX[ws.state];
      const slot = pool[idx];
      if (slot === undefined) return false;
      const name = pickSlot(slot, animRef.current); // 互动结束后恢复档位循环：数组槽位档内随机（避开当前正播动画）
      console.log(
        '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' 互动结束恢复状态动画: ' + name,
      );
      // 多候选档位恢复后同样走 ended 轮换（once=true 播一遍 → 护栏换下一候选）；单候选/单动画维持无限循环
      setOnce(Array.isArray(slot) && slot.length > 1);
      setAnim(name);
      return true;
    };

    const handleEnded = (e?: Event) => {
      // 只认前台视频触发的 ended：后台（被降级停播）视频即便有残留事件也一律丢弃，防止掐断当前动画
      const evEl = e && (e.currentTarget as HTMLVideoElement | null);
      if (evEl && !evEl.classList.contains('is-front')) return;
      // 播放回执：前台视频真的播完了 → 如实回 ended。放在拖拽守卫**之前**：
      // "播完了"是既成事实，拖拽守卫管的是动画链怎么推进，不该影响回执的准确性。
      const donePlayback = playingPlaybackRef.current;
      if (donePlayback !== null) {
        playingPlaybackRef.current = null; // 先清再上报：后续链式换源不该把它当成"被打断"
        reportPlayback(donePlayback, 'ended');
      }
      const animations = petAnims;
      if (dragRef.current.active) return;
      // 占用锁（issue #122 第 4 项）：冻结期间**动画链一律不推进**——事件动画播完就停在最后一帧。
      //
      // 为什么必须挡在这一行：下面四条路都会换源播放，而它们读的是**当前工作状态**
      // （`workStatusRef`），跟 `workStatusTick` 无关——所以上面那个 effect 的门禁拦不住它们：
      //   ① 非终态多候选档位播完自动轮换（还会一直轮换下去）；
      //   ② 非终态单候选意外 ended 就续播同一段；
      //   ③ 事件动画（余额/碎碎念/**说话**）播完 → 恢复工作状态档位；
      //   ④ 点击/拖拽动画播完 → 恢复工作状态档位。
      // ③ 是最容易撞上的：持锁者每投一次带 `anim` 的气泡（默认就是 true），说话动画播完就走到这里，
      // 把工作状态动画点回来——只要用户在跑任务，冻结就形同虚设。
      // 播放回执已经在上面上报，不受这一行影响。
      if (frozenRef.current) return;
      // 事件动画播完：回 idle（与 drag/clicks 同分支，不进入随机链）；气泡由定时器自动消失，与动画解耦
      const isEvent = isEventAnim(animations.events, animRef.current);
      // 工作状态循环护栏：非终态档位（thinking/working/result/waiting）期间，workStatus 事件动画
      // 禁止“播完回 idle”——一旦意外触发 ended（loop 被某种原因掐断/once 被误置 true），
      // 立即重设循环续播，直到状态真正切走（success/error/空闲）。其余事件动画仍按原语义回 idle。
      const wsNow = workStatusRef.current;
      if (isEvent && wsNow && wsNow.state && wsNow.state !== 'success' && wsNow.state !== 'error') {
        // 多候选档位：播完一段自动轮换到下一候选（排除当前段，避免连抽）——长时间状态不单段重复
        const nextWork = nextWorkStatusAnim(animations.events?.workStatus ?? [], animRef.current);
        if (nextWork !== null) {
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' workStatus 档内轮换: ' +
              animRef.current +
              ' -> ' +
              nextWork,
          );
          setOnce(true); // 保持 once=true：下一段播完再 ended → 再轮换
          setAnim(nextWork);
          setSeq((s) => s + 1);
          return;
        }
        // 单候选/单动画档位（意外 ended：loop 被掐断/once 误置 true）：原护栏语义续播同一段
        if (poolIncludes(animations.events?.workStatus ?? [], animRef.current)) {
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' workStatus 循环续播: ' +
              animRef.current,
          );
          setOnce(false);
          setSeq((s) => s + 1);
          return;
        }
      }
      if (isEvent) {
        // 诊断：事件动画 ended 落地（余额/碎碎念/终态 workStatus 走到这里；非终态走上面护栏续播）
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            cfg.id +
            ' 事件动画播完 ended anim=' +
            animRef.current +
            ' ws=' +
            ((workStatusRef.current && workStatusRef.current.state) || 'null'),
        );
        // 事件动画播完但 workStatus 仍处于非终态（余额/碎碎念等抢占播完）：立即恢复档位循环动画，
        // 绝不留进随机链——否则长事件期间当前状态不变（ts 不变），随机链会一直播到状态切换才被拉回
        if (resumeWorkStatusAnim()) return;
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
        // 互动动画播完：workStatus 非终态时恢复状态循环，否则回 idle（原语义）
        if (resumeWorkStatusAnim()) return;
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
      // 朝向 → 走路方向：**只看当前 facing**。原式是 `(facingRef.current === 'right') !==
      // petAnims.turn.includes(animRef.current)`，那个 XOR 是用来补"turn 播完 setFacing 异步、
      // 紧随的 pickNext 还读到旧 facing"（见 handleEnded）。1ea84ee 起 handleEnded 已立即同步
      // facingRef，旧朝向不复存在，XOR 反而把方向多翻一次：turn 播完朝右，这里算出 dir=-1，
      // 于是镜像朝右、人往左走。故删掉。
      const dir = facingRef.current === 'right' ? 1 : -1;
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
      // 位置指令的弹簧也是一种"自主移动"：任何停走路的地方都该把它一并停掉，否则两套运动系统会
      // 同时改 DOM 位置（用户拖拽 / 抛掷 / 事件动画 / 菜单点播都会走到这）。
      stopPosFollow();
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

    // ---- 位置 / 抛掷指令（其他插件经 POST /position、POST /throw 写进 S）----
    // 两条都是**指令**，与上面的 animCue 同族：容器统一轮询后按宠物 id 分发，seq 变化即执行。
    // 这里不新写运动学——位置按 mode 走三条既有路径（instant / spring / line），抛掷复用 startThrow。
    /** 位置指令的跟随 rAF（spring 与 line 共用同一个句柄）。与拖拽跟手分开：拖拽没有终点
     *  （指针一直喂目标），这条有终点，收敛/到点后必须自己收掉，否则 rAF 永远转下去。 */
    const posFollowRef = useRef<number | null>(null);
    const posFollowTokenRef = useRef(0);

    const stopPosFollow = () => {
      posFollowTokenRef.current++;
      if (posFollowRef.current !== null) {
        cancelAnimationFrame(posFollowRef.current);
        posFollowRef.current = null;
      }
    };

    /**
     * 执行一条位置指令：把宠物**中心**挪到归一化坐标 (rx, ry)。
     * `mode` 三选一——`instant` 一帧到位并提交 customPos；`spring` 走拖拽那套过阻尼弹簧；
     * `line` 在 `duration` 毫秒里**直线**走完（`duration <= 0` 等同 instant）。
     * 用户正按着宠物（`active` 含点击与拖拽）时**整拍丢弃**——手指底下的东西不该跑；
     * 这与动画链的守卫同一语义（见 handleEnded）。丢弃是静默的：接口早已回过 ok。
     */
    const applyPositionCue = (rx: number, ry: number, mode: PositionMode, duration: number) => {
      if (dragRef.current.active) return; // 用户交互优先
      stopThrow(); // 先显式接管：停掉飞行与走路（stopMove 顺带停掉上一次的位置跟随）
      stopMove();
      // 中心 → 包围盒左上角 px（与下面提交 customPos 时的换算互逆）
      const px = rx * window.innerWidth - halfW;
      const py = ry * window.innerHeight - halfH;
      const rootEl = rootRef.current;
      if (!rootEl || mode === 'instant' || (mode === 'line' && duration <= 0)) {
        boxPxRef.current = { x: px, y: py };
        setCustomPos({ rx, ry });
        return;
      }
      const token = ++posFollowTokenRef.current;
      /** 落笔：写 ref + 四个 style（弹簧与直线两条路共用；原先是各写一遍） */
      const paint = (x: number, y: number) => {
        boxPxRef.current = { x, y };
        rootEl.style.left = x + 'px';
        rootEl.style.top = y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      };
      if (mode === 'line') {
        // 直线补间：在**像素空间**插值——按归一化比例插值会把斜线走歪（视口非正方时两轴缩放不同）
        const from = boxPxRef.current ?? { x: px, y: py };
        const t0 = performance.now();
        const step = () => {
          if (posFollowTokenRef.current !== token) return;
          const p = Math.min((performance.now() - t0) / duration, 1);
          if (p >= 1) {
            // 精确落位：终点不留残余偏差（弹簧那条靠收敛阈值收尾，这条靠 p 到 1）
            paint(px, py);
            posFollowRef.current = null;
            setCustomPos({ rx, ry });
            return;
          }
          paint(from.x + (px - from.x) * p, from.y + (py - from.y) * p);
          posFollowRef.current = requestAnimationFrame(step);
        };
        posFollowRef.current = requestAnimationFrame(step);
        return;
      }
      // spring：过阻尼弹簧跟随——没有行程时间，靠收敛判定自己收尾
      let last = performance.now();
      const vel = { vx: 0, vy: 0 };
      const step = () => {
        if (posFollowTokenRef.current !== token) return;
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        let x = boxPxRef.current?.x ?? px;
        let y = boxPxRef.current?.y ?? py;
        vel.vx = springStep(vel.vx, x, px, dt, cfg.physics.throwPower);
        vel.vy = springStep(vel.vy, y, py, dt, cfg.physics.throwPower);
        x += vel.vx * dt;
        y += vel.vy * dt;
        paint(x, y);
        // 收敛判定：足够近且足够慢 → 精确落位并提交。拖拽跟手靠指针松手结束，这条得自己判。
        if (Math.abs(px - x) < 0.5 && Math.abs(py - y) < 0.5 && Math.abs(vel.vx) < 1 && Math.abs(vel.vy) < 1) {
          paint(px, py);
          posFollowRef.current = null;
          setCustomPos({ rx, ry });
          return;
        }
        posFollowRef.current = requestAnimationFrame(step);
      };
      posFollowRef.current = requestAnimationFrame(step);
    };

    /**
     * 执行一条抛掷指令：角度（度，`0` = 正右，逆时针为正）+ 力度倍率 → 初速度，交给 startThrow。
     * 下游（重力 / 反弹 / 地面摩擦 / 落地 Q 弹 / 宠物间碰撞 / 落定提交位置）全是**既有行为**，
     * 本接口不引入任何新物理。不设死区：接口是明确命令，power 再小也照抛。
     */
    const applyThrowCue = (angleDeg: number, power: number) => {
      if (dragRef.current.active) return; // 用户交互优先
      const { vx, vy } = throwVelocity(angleDeg, power);
      const box = boxPxRef.current ?? { x: currentCenterX() - halfW, y: currentCenterY() - halfH };
      startThrow(box.x, box.y, vx, vy);
    };
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

    // ---- 悬浮提示：贴光标显示（与原生 title 的观感一致） ----
    /** 把提示框摆到光标右下（右边/下边装不下自动翻边并夹回视口内）。
     *  直接写 DOM style 而不走 React 状态：鼠标每动一下都更新状态会让整个 PetCard 重渲染，
     *  代价远大于这一次样式写入（root 的位置也是这么直接写的）。
     *  bounds 用视口——提示是 position:fixed，坐标就是 clientX/clientY 这一套。 */
    const placeTip = (clientX: number, clientY: number): void => {
      const tipEl = tipRef.current;
      if (!tipEl) return;
      const viewport = document.documentElement;
      const p = tooltipPlacement(
        { x: clientX, y: clientY },
        { w: tipEl.offsetWidth, h: tipEl.offsetHeight },
        { x: 0, y: 0, w: viewport.clientWidth, h: viewport.clientHeight },
        size * TOOLTIP_GAP_RATIO,
      );
      tipEl.style.left = p.x + 'px';
      tipEl.style.top = p.y + 'px';
    };

    // ---- 占用锁：冻结 / 解冻（issue #122 第 4 项）----
    //
    // 锁在宿主内存里，渲染端靠 S 的 `pets.<id>.lock` 叶子知道它。**宿主不会到点推一次"锁没了"**
    // （它那一侧的过期是懒判的），所以这里按叶子里的 `expiresAt` 自己定时解除——两端的"到点"因此同源。
    //
    // 冻结期间**只有三件事被挡住**，且都在渲染端：
    //   ① 随机链（pickNext 一句判断，随机动画/随机转向/自主走位全在它后面）；
    //   ② 当前正在播的自播动画（暂停，定在当前帧）；
    //   ③ **自动**来源的余额与工作状态表现（见各自 effect 里的判断；手动请求与显式指令照常）。
    // 显式指令（say / anim / position / throw 四个叶子）**一概不挡**——那些是持锁者（或用户手动）
    // 明确要的，正是占用要保护的东西。
    /** 冻结 / 解冻的**实际动作**（只在真的翻转时做事：挂载那一次不动作，否则平白补播一段 idle） */
    const applyFreeze = (next: boolean): void => {
      if (frozenRef.current === next) return;
      frozenRef.current = next;
      const el = frontRef.current === 0 ? videoARef.current : videoBRef.current;
      const stamp = '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id;
      if (next) {
        // 停住正在播的那一段：宿主停不掉一段视频，"完全静止"只能由渲染端执行。
        // 光堵随机链入口不够——那个入口只在动画**播完**时才被调用，不暂停的话会把当前这段播完才停。
        stopMove();
        el?.pause();
        // 播放回执（issue #122 第 3 项）：冻结**打断了**正在播的那一次第三方点播——如实回
        // `cancelled`，而不是让回执一直挂着 `playing`（那会让挂 `?wait=ended` 的调用方白等一个
        // timeout：这一场永远不会 ended）。为什么是"打断"而不是"暂停"：解冻走的是回 idle /
        // 恢复档位（= 换源顶掉它），**不会把它接回来**，所以它确实不会再播完。
        // 顺序与 onReady 里那条 superseded 一致：先清 playingPlaybackRef 再上报，
        // 免得后续换源又把同一个编号当成"被顶掉"再报一次。
        const interrupted = playingPlaybackRef.current;
        if (interrupted !== null) {
          playingPlaybackRef.current = null;
          reportPlayback(interrupted, 'cancelled', 'frozen');
        }
        console.log(stamp + ' 占用锁生效：冻结（随机链停 + 当前动画暂停）');
        return;
      }
      console.log(stamp + ' 占用锁解除：恢复');
      // 解冻：回到"该播什么就播什么"——非终态工作状态回档位循环，否则回 idle 一次，
      // 播完由 handleEnded 接回随机链（与点击/拖拽结束后的恢复同一条路）。
      if (resumeWorkStatusAnim()) return;
      if (petAnims.idle.length) {
        setAnim(pick(petAnims.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
      }
    };

    useEffect(() => {
      if (lockTimerRef.current !== null) {
        window.clearTimeout(lockTimerRef.current);
        lockTimerRef.current = null;
      }
      // `expiresAt` 已经过去 = 没有锁：页面刷新后才拿到一份陈旧叶子时必须这么判，不能只看 locked
      const expiresAt = lock?.locked === true ? lock.expiresAt : 0;
      applyFreeze(expiresAt > Date.now());
      if (expiresAt <= Date.now()) return;
      lockTimerRef.current = window.setTimeout(
        () => {
          lockTimerRef.current = null;
          applyFreeze(false);
        },
        Math.max(0, expiresAt - Date.now()),
      );
      return () => {
        if (lockTimerRef.current !== null) {
          window.clearTimeout(lockTimerRef.current);
          lockTimerRef.current = null;
        }
      };
      // applyFreeze 每次渲染都是新函数，但它读的全是 ref 与稳定 setter，刻意不进依赖
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lockTick, lock]);

    // ---- 点击 vs 拖拽 ----
    const handlePointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      // 只认左键：右键进入拖拽判定会与右键菜单打架（右键不拖拽，两端一致）
      if (e.button !== 0) return;
      // 占用锁（issue #122 第 4 项）：用户**点了或拖了**这只宠物 = 用户接管，立刻撤掉第三方占用。
      // 这是唯一一处"渲染端 → 宿主"的锁上报——宿主看不见鼠标，而锁在它手里（见 /lock/release 的
      // force 形态）。先本地解冻再上报：叶子回来还有一次往返，等它会让宠物"点了半天才动"；
      // 此刻 frozenRef 为真说明确实有锁，所以这次 force 释放必然成功，乐观是安全的。
      if (frozenRef.current) {
        if (lockTimerRef.current !== null) {
          window.clearTimeout(lockTimerRef.current);
          lockTimerRef.current = null;
        }
        applyFreeze(false);
        void postAction('/dsh-pet-7340/lock/release?pet=' + encodeURIComponent(cfg.id), { force: true });
      }
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
      // 收起悬浮提示：指针捕获期间 pointerleave 不会触发，不主动收就会一直挂在宠物头上跟着跑
      setTipOn(false);
      const rootEl = rootRef.current;
      let offX = 0;
      let offY = 0;
      if (rootEl) {
        const rr = rootEl.getBoundingClientRect();
        offX = e.clientX - (rr.left + rr.width / 2);
        offY = e.clientY - (rr.top + rr.height / 2);
        boxPxRef.current = { x: rr.left, y: rr.top };
      }
      dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY, offX, offY, lpTimer: null };
      // 触屏长按 500ms 打开右键菜单：复用同一套按下判定。手指移动超过 8px 即取消；
      // 鼠标与笔不走这条分支（它们本来就有右键，无需长按替代）。
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
        const lpEl = e.currentTarget;
        const lpId = e.pointerId;
        const lpX = e.clientX;
        const lpY = e.clientY;
        dragRef.current.lpTimer = setTimeout(() => {
          dragRef.current.lpTimer = null;
          const dl = dragRef.current;
          if (!dl.active || dl.dragging) return;
          // 结束本次按压：松手时既不抛掷也不播点击动画（pressScoreFiredRef 标记为已处理）
          dl.active = false;
          pressScoreFiredRef.current = true;
          if (lpEl.hasPointerCapture(lpId)) lpEl.releasePointerCapture(lpId);
          console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [TOUCH-MENU]');
          // 与鼠标右键同一个入口：派发 contextmenu 交给 handleContextMenu
          lpEl.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: lpX,
              clientY: lpY,
              button: 2,
            }),
          );
        }, 500);
      }
    };
    const handlePointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      // 提示跟随光标：必须在拖拽早退之前——拖拽期间提示本来就收起了，但非拖拽的每次移动都要跟上
      if (tipOn) placeTip(e.clientX, e.clientY);
      const d = dragRef.current;
      if (!d.active) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      // 长按窗口内手指移动超过 8px 即取消（拖拽阈值 DRAG_THRESHOLD 不动）
      if (d.lpTimer && Math.hypot(dx, dy) > 8) {
        clearTimeout(d.lpTimer);
        d.lpTimer = null;
      }
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
      // pointercancel 也走这个处理器（见 JSX onPointerCancel），所以长按定时器在这里一并清掉
      if (d.lpTimer) {
        clearTimeout(d.lpTimer);
        d.lpTimer = null;
      }
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
        // 拖拽松手：workStatus 非终态时恢复状态循环；否则播一遍待机 → ended → 回随机链
        // （once=true；旧实现 once=false 无限循环，ended 永不触发、随机链永远回不来——历史卡死 bug）
        if (!resumeWorkStatusAnim()) {
          if (petAnims.idle.length) setAnim(pick(petAnims.idle, animRef.current));
          setOnce(true);
        }
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
      // 提示复位：点击/拖拽期间收起的悬浮提示，指针仍在命中区内就恢复——指针捕获期间
      // pointerleave 不触发，不复位就得把鼠标移出去再移回来才重现（与桌面 onPointerUp 同一处理）。
      // 先按松手位置摆好再显示，否则会重现上一次的位置。
      const hitRect = e.currentTarget.getBoundingClientRect();
      if (
        e.clientX >= hitRect.left &&
        e.clientX <= hitRect.right &&
        e.clientY >= hitRect.top &&
        e.clientY <= hitRect.bottom
      ) {
        placeTip(e.clientX, e.clientY);
        setTipOn(true);
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
    // 绝不进入/改动 DSH 页面自己的菜单。浏览器端工具项 = 查看余额 / 碎碎念 / 对话 / 回到初始位置
    // （无「打开网站」——宠物就在网页里；无「重载配置」——刷新页面即可）。
    /** `keepFacing` = 调用方已**显式指定**朝向（POST /anim 的 facing）：跳过下面"文字类动画
     *  点播前强制朝左"那条镜像修正——显式值优先。右键菜单点播不传（保持原语义）。 */
    const handleMenuAction = (leaf: MenuLeaf, playbackId?: string, keepFacing = false) => {
      if (leaf.action === 'show-balance') {
        // 查看余额（与桌面菜单同一套语义）：POST 动作端点让 host 立即刷新一次并写入 S（manual 标记随数据一起写）。
        // 结果**这里什么都不用做**：写叶子会让版本号变，挂着的长轮询那一拍立刻返回并展示（0 延迟）。
        // 动作端点不回数据：余额只有一个出口（/state 的 sections.balance），与碎碎念同一条契约。
        console.info('[dsh-pet] 菜单查看余额 pet=' + cfg.id);
        postAction('/dsh-pet-7340/balance')
          .then((ok: boolean) => {
            if (!ok) console.warn('[dsh-pet] 余额刷新动作未成功 pet=' + cfg.id);
          })
          .catch((e: unknown) => console.warn('[dsh-pet] 余额刷新异常', e));
        return;
      }
      if (leaf.action === 'whisper') {
        // 手动碎碎念：POST 动作端点让 host 立即新生成一句（写进 S）。
        // 动作**不回文本**——文本随"版本号变化"唤醒的那一拍长轮询到达并弹气泡（0 延迟）。
        // 手动触发不受 whisperEnabled 限制——该字段只关自动周期，手动永远可用。
        console.info('[dsh-pet] 菜单触发碎碎念 pet=' + cfg.id);
        // surface 必填：本页面就是网页端
        postAction('/dsh-pet-7340/whisper?pet=' + encodeURIComponent(cfg.id) + '&surface=web')
          .then((ok: boolean) => {
            if (!ok) console.warn('[dsh-pet] 碎碎念手动触发失败 pet=' + cfg.id);
          })
          .catch((e: unknown) => console.warn('[dsh-pet] 碎碎念手动触发异常', e));
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
          surface: 'web',
          x: hitRect ? hitRect.right + 6 : window.innerWidth - 256,
          y: hitRect ? hitRect.top + 6 : 8,
          onSent: () => {
            // 发送成功：回复已写进 S → 版本号变 → 挂着的长轮询立刻返回并弹气泡（0 延迟）
            console.info('[dsh-pet] 对话已发送 pet=' + cfg.id);
          },
          onClose: () => {
            chatRef.current = null;
          },
        });
        return;
      }
      if (leaf.action === 'set-display') {
        // 显示位置：POST 到宿主写配置，成功后再用**权威成品**重拉配置。
        // 改成不含 web 的值（仅桌面/都不）时 visiblePets 会把它过滤掉——宠物即从页面消失。
        const display = leaf.display;
        if (!display) return;
        console.info('[dsh-pet] 菜单切换显示位置 pet=' + cfg.id + ' display=' + display);
        void fetch('/dsh-pet-7340/pet-display', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: cfg.id, display }),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error('pet-display HTTP ' + r.status);
            const body = (await r.json()) as Record<string, unknown>;
            // 业务失败是 **HTTP 200 + `{ok:false, reason}`**（缺 id / display 非法 / 宠物不存在 /
            // 写盘失败全走这一条）——只看状态码会把失败体当成成品聚合喂给 reload。
            if (body.ok === false) throw new Error('pet-display 被拒：' + String(body.reason ?? ''));
            // 响应体就是改动后的成品聚合（与设置页保存同路），直接交给 reload。
            // **必须传它**：不传参时 reload 会再拉一次 GET /config，那次请求可能拿回陈旧配置，
            // 现场表现就是"浏览器端要刷新才生效"。
            petBridge.reload(body as Record<string, Record<string, unknown>>);
          })
          .catch((e: unknown) => console.warn('[dsh-pet] 显示位置切换失败', e));
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
      // 回执归属：这一段动画若来自第三方点播，编号要跟着这次换源一起下发（自播动画传 null，
      // 顺带把上一次的编号清掉，避免陈旧编号串到自播动画上）
      const cuePlaybackId = playbackId ?? null;
      // 文字类（noMirror）朝右站姿是镜像的：点播前强制朝左，避免文字镜像（与随机链"朝右不选文字"同语义）。
      // `keepFacing` 时跳过：调用方已显式指定朝向，显式值优先（要 right 就给 right，哪怕文字会镜像）。
      if (!keepFacing && isNoMirrorAnimation(petAnims.categories, leaf.anim) && facingRef.current === 'right') {
        setFacing('left');
      }
      // 点播移动动画：走真实移动（与随机移动同一套：边界检查 / 随机距离 / leadSec·tailSec 时段 / dir 计算），
      // 仅"选哪个动画"由菜单决定；边界内挪不动（false）退化为纯播放，仍能看到该动画
      if (petAnims.moves.actions.some((a) => a.name === leaf.anim)) {
        if (tryMove(leaf.anim) === false) {
          stopMove();
          setOnce(true);
          setAnim(leaf.anim);
          setCuePlayback(cuePlaybackId);
        } else if (cuePlaybackId !== null) {
          // 移动系统接管：这条路径**不换视频源**（宠物走真实位移），本段点播不会真的播起来。
          // 如实回 failed/busy，而不是让调用方干等到 timeout。
          reportPlayback(cuePlaybackId, 'failed', 'busy');
        }
        return;
      }
      stopMove();
      setOnce(true);
      setAnim(leaf.anim);
      setCuePlayback(cuePlaybackId);
    };
    const handleContextMenu = (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      // 工具项（查看余额 / 碎碎念 / 对话 / 回到初始位置，与桌面端同一套）+ 动作树（动作→分类→具体动画）。
      // 「查看余额」**无条件显示**（与桌面端一致）：即使该宠物关了 balanceEnabled 也能点——手动请求不受开关限制
      //（该开关只关自动轮询与档位动画），与碎碎念「手动触发不受 whisperEnabled 限制」同一条原则。
      const tree: MenuNode[] = [
        { label: '查看余额', action: 'show-balance' },
        { label: '碎碎念', action: 'whisper' },
        { label: '对话', action: 'chat' },
        { label: '回到初始位置', action: 'home' },
        // 显示位置（仅网页/仅桌面/两者/都不）：与桌面端注入**同一份**子菜单。
        // 改成不含 web 的值（仅桌面/都不）后，本宠物会随即从 visiblePets 里消失——字面意义上的"自己走掉"。
        displayMenuBranch(),
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
    // ---- 气泡单槽（同一时刻只渲染一个）----
    // 三种气泡共用同一套定位 CSS（bubble.ts 的 .dsh-pet-bubble：同一个 left/bottom/z-index），
    // 同时渲染只会叠在同一个坐标上互相遮盖——所以这里按优先级挑一个出来渲染，其余不挂载。
    // 优先级：终态任务 > 碎碎念/对话 > 余额 > 非终态任务。
    // 为什么终态任务不让位：完成/失败气泡只活 10s，被事件顶掉就彻底看不到了；非终态任务气泡
    // 常驻（不设自动收起），让位 10s 零损失。与桌面端 sprite.js 的 renderBubble 同一套优先级。
    const workTerminal = workStatus?.state === 'success' || workStatus?.state === 'error';
    const bubbleNode = (() => {
      if (workTerminal && workBubbleOn && workText && cfg.workStatusEnabled) {
        return h(WhisperBubble, { text: workText, on: workBubbleOn });
      }
      if (whisperBubbleOn && whisperText) {
        // assetRoot：配图**按名称**取时去哪个表情包目录链取（种类独占 → 用户目录 → 包内），
        // 与动画素材同一套归属；配图走 url 形态时不用它（直接用那个地址）
        return h(WhisperBubble, {
          text: whisperText,
          image: whisperImage,
          url: whisperUrl,
          assetRoot: cfg.assetRoot,
          on: whisperBubbleOn,
        });
      }
      if (bubbleOn && balance && (cfg.balanceEnabled || balanceManual)) {
        return h(BalanceBubble, { state: balance, on: bubbleOn });
      }
      if (workBubbleOn && workText && cfg.workStatusEnabled) {
        return h(WhisperBubble, { text: workText, on: workBubbleOn });
      }
      return null;
    })();
    const commonVideoProps = { muted: true, playsInline: true, autoPlay: true };
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
      onPointerEnter: (e: ReactNS.PointerEvent<HTMLDivElement>) => {
        placeTip(e.clientX, e.clientY); // 先摆位再显示：否则会先在兜底坐标闪一帧
        setTipOn(true);
      },
      onPointerLeave: () => setTipOn(false),
      onContextMenu: handleContextMenu,
      // 原先这里挂 title（原生系统提示）：已换成自绘浮层，但无障碍名称不能跟着丢
      'aria-label': cfg.name,
    };
    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-root',
      'data-corner': corner,
      'data-facing': facing,
      style: Object.assign(
        {
          '--dsh-pet-size': size + 'px',
          '--dsh-pet-mx': margin.x + 'px',
          '--dsh-pet-my': margin.y + 'px',
          // 字号（配置 font）：注入算好的最终 px —— 气泡与悬浮提示的 CSS 读这两个变量
          // （CSS 侧带原值回退，漏注入也不会坏，见 bubble.ts / tooltip.ts）
          '--dsh-pet-font-bubble': fontPx.bubble + 'px',
          '--dsh-pet-font-tip': fontPx.tip + 'px',
        },
        rootStyle,
      ),
      children: [
        // 气泡单槽（优先级见上）：余额「不可用」文字说明同样走这条通道——它只要求 balanceEnabled，
        // 不再要求 balance.ok（否则未登记余额接口的服务商完全没有反馈，这是该气泡的起因）；
        // 碎碎念/对话气泡**不受 whisperEnabled 限制**（该字段只关自动周期轮询的触发，见上头
        // useEffect 的门控）；whisperText 只由 triggerWhisper 设置，所以说话气泡照常渲染。
        bubbleNode,
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
        // 悬浮提示（替代原生 title）：元素常驻、只切 class——挂卸节点吃不到 .12s 淡入过渡；
        // 坐标由 placeTip 按光标直接写 style（这里刻意不传 style，免得 React 覆盖）。
        // 文本 = 宠物显示名（host 已保证非空）；pointer-events:none 见 TOOLTIP_CSS，
        // 否则它会挡住命中区，mouseenter/leave 互相打架导致闪烁。
        h('div', {
          ref: tipRef,
          className: TOOLTIP_CLASS + (tipOn ? ' is-on' : ''),
          'aria-hidden': 'true',
          children: cfg.name,
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
    // 余额状态（容器统一拉取，PetCard 共享；balanceTick 每次成功拉取递增，驱动事件动画；
    // balanceNoticeTick 每次「该提示不可用原因」递增，驱动文字说明气泡）
    const [balance, setBalance] = useState<BalanceState | null>(null);
    const [balanceTick, setBalanceTick] = useState(0);
    const [balanceNoticeTick, setBalanceNoticeTick] = useState(0);
    // 这次余额是不是**用户手动要的**（host 在叶子里标 manual）：下发给各宠物，
    // 决定「关了 balanceEnabled 的宠物要不要也答复」——手动请求无条件弹，开关只关自动。
    const [balanceManual, setBalanceManual] = useState(false);
    // 上次已提示的不可用原因（reason:provider）：自动轮询只在原因变化时再弹（判定在 src/shared，两端同一份）
    const noticeKeyRef = useRef<string | null>(null);
    // 余额结果 → 状态与气泡（周期刷新与手动触发**共用这一条路径**，避免各写一份后漂移）。
    // 存 ref 而非 useCallback：/state 轮询 effect 的依赖数组保持 [ready] 不变，
    // 同时规避引用每次渲染都变化导致的重复建 effect（本文件已有的 ref 同步写法）。
    // explicit：这次写入是不是手动触发的（host 在叶子里标了 manual，见 shared/state 的 readBalance）。
    const applyBalanceRef = useRef<(state: BalanceState, explicit: boolean) => void>(() => {});
    applyBalanceRef.current = (state, explicit) => {
      setBalance(state);
      setBalanceManual(explicit); // 手动标记随本次数据一起下发（每次到达都覆盖，人工标记不会滞留）
      if (state.ok) {
        setBalanceTick((t) => t + 1); // 成功：播档位动画 + 弹余额气泡
        return;
      }
      const { show, key } = decideBalanceNotice(state, noticeKeyRef.current, explicit);
      noticeKeyRef.current = key;
      if (show) setBalanceNoticeTick((t) => t + 1); // 弹文字说明气泡（不播动画）
      // 未登记服务商是配置事实（已由气泡说明），不再刷 console；其余原因照旧显式报错，绝不伪造余额
      if (state.reason !== 'unsupported') {
        console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
      }
    };
    // 工作状态：容器统一轮询 /state 的 sections.workStatus，快照 + tick 递增驱动各宠物播档位动画
    const [workStatus, setWorkStatus] = useState<WorkStatusSnapshot | null>(null);
    const [workStatusTick, setWorkStatusTick] = useState(0);
    // 说话（碎碎念 / 命令气泡 / 对话回复三合一）：容器统一轮询 /state 的 pets.<id>.say，
    // 按宠物分发到对应 PetCard（sayRef + sayTick；见下方统一轮询与 PetCard 的 say 分支）。

    // 字体族（全局配置 font.family）→ documentElement 上的全局变量：对话窗与得分弹窗挂在 body 下、
    // 继承不到宠物根容器，只能走全局；气泡与悬浮提示也一并从这里继承。
    // 多只宠物的 font 同值（配置只有一份），重复设置无副作用；列表为空（配置尚未加载）时不动。
    useEffect(() => {
      const family = pets[0]?.font?.family;
      if (family === undefined) return;
      document.documentElement.style.setProperty('--dsh-pet-font-family', fontStackOf(family));
    }, [pets]);

    useEffect(() => {
      let alive = true;
      /** 唯一填充点：host 成品聚合 → 渲染列表。初始加载与设置页保存/同步后重载都走这里——
       *  条目级字段（动画池/权重/刷新周期/物理参数/工作状态文案）只由 flattenConfigPets 吹入，
       *  容器不再自己拼任何字段（曾经的第二份补吹实现漏过 physics，导致新增/同步后拖不动）。 */
      const applyMerged = (merged: Record<string, Record<string, unknown>>): void => {
        const main = (merged as { main?: Record<string, unknown> } | null)?.main;
        // 形状校验：host 版本不匹配 / 响应体异常时显式抛错（初始加载报错，重载保留当前列表），
        // 绝不用空列表把已有宠物清空
        if (typeof main !== 'object' || main === null) {
          throw new Error('配置响应不是成品聚合（host 版本不匹配？）');
        }
        const flattened = flattenConfigPets(merged);
        petBridge.current = flattened;
        // 「添加宠物」模板 = main 条目 pets[0]（内置默认或用户覆盖后的主宠物）
        petBridge.template = Array.isArray(main.pets) ? ((main.pets as Pet[])[0] ?? undefined) : undefined;
        setPets(flattened);
      };
      /** 拉成品聚合：host readAllConfig 的输出（字段填满、绝对正确），客户端零校验零兜底 */
      const loadMerged = async (): Promise<Record<string, Record<string, unknown>>> => {
        // cache:'no-store' 与 fetchState 同口径：配置是动态的，任何形式的缓存命中都会让
        // 「发现版本变化 → 重拉」拿到旧值（响应端也已带 no-cache，请求端与响应端一起防）
        const r = await fetch('/dsh-pet-7340/config', { cache: 'no-store' });
        if (!r.ok) throw new Error('config HTTP ' + r.status);
        return (await r.json()) as Record<string, Record<string, unknown>>;
      };
      (async () => {
        try {
          const merged = await loadMerged();
          if (!alive) return;
          applyMerged(merged);
          setReady(true);
        } catch (e) {
          console.error('[dsh-pet] 配置加载失败', e); // 成品拉取失败：显式报错，不静默隐藏
        }
      })();
      // 设置页保存/同步后：host 已落盘，这里用权威成品重新拍平（传 merged 则直接用写接口的响应体，
      // 不必再拉一次；缺省自行 GET——同步等场景复用同一条路径）
      petBridge.reload = (merged) => {
        void (async () => {
          try {
            const next = merged ?? (await loadMerged());
            if (!alive) return;
            applyMerged(next);
          } catch (e) {
            console.error('[dsh-pet] 配置重载失败，保留当前渲染列表', e); // 显式报错，不清空已有宠物
          }
        })();
      };
      return () => {
        alive = false;
        petBridge.reload = () => {};
      };
    }, []);

    // 浏览器 overlay 只渲染 display ∈ {web, both} 的宠物；desktop / none 不参与网页显示
    const visiblePets = pets.filter((p) => isWebVisible(p.display));

    // ---- 统一轮询（GET /state，1s）：前端**唯一**的数据来源与渲染入口 ----
    // 每个叶子 = { counter, data }：首拉只记基线（不渲染——避免刷新页面时重放旧气泡），
    // 之后 counter 变了才渲染。分发到各功能（余额 / 工作状态 / 通知 / 说话）。
    // 为什么不再按"有没有启用某功能"决定要不要轮询：说话（命令触发）与宠物开关无关，
    // 今天每只宠物的 /broadcast 轮询本来就不受开关门控——统一后至少不比现在多。
    const [sayTick, setSayTick] = useState(0);
    const sayRef = useRef<Record<string, SayCue & { seq: number }>>({});
    const [animCueTick, setAnimCueTick] = useState(0);
    const animCueRef = useRef<
      Record<string, { name?: string; url?: string; seq: number; playbackId?: string; facing?: PetFacing }>
    >({});
    const [posCueTick, setPosCueTick] = useState(0);
    const posCueRef = useRef<
      Record<string, { x: number; y: number; mode: PositionMode; duration: number; seq: number }>
    >({});
    const [throwCueTick, setThrowCueTick] = useState(0);
    const throwCueRef = useRef<Record<string, { angle: number; power: number; seq: number }>>({});
    // 占用锁（issue #122 第 4 项）：容器统一轮询 pets.<id>.lock，按宠物分发到对应 PetCard。
    // 与那四个"指令"不同，这是**状态**：PetCard 读它决定要不要冻结自己（随机链停、暂停自播、
    // 忽略自动来源），并自己按 expiresAt 定时解除——宿主不会到点推一次"锁没了"。
    const [lockTick, setLockTick] = useState(0);
    const lockRef = useRef<Record<string, LockState>>({});
    useEffect(() => {
      if (!ready) return;
      let alive = true;
      let baseline: Record<string, number> | null = null;
      // 长轮询：since = 我手里这份 S 的版本号（undefined = 首拉，不带参数 → 立刻拿全量）
      let since: number | undefined;
      // 宿主支持长轮询吗？响应带 counter = 支持；不带 = **老宿主**——它不认识 since/timeout，
      // 会立刻返回全量，这时必须退回固定间隔轮询，否则就成忙等了。
      let longPoll = true;
      /** 应用一份 S：首拉只记基线，之后按 counter 变化逐个分发 */
      const applyState = (s: PollState) => {
        if (baseline === null) {
          baseline = flattenCounters(s); // 首拉：只记基线，不渲染
          return;
        }
        for (const { path, leaf } of takeChanged(s, baseline)) {
          if (leaf.data === null) continue;
          if (path === 'sections.config') {
            // 配置被别处改过 → 重拉配置重拍平。**唯一的写方是 POST /pet-display**
            // （桌面端右键改显示位置）——那个改动不是本页面发起的，只能靠这个信号知道。
            // 叶子 data 恒为 {}（纯信号），配置本体太大不能塞进 /state，所以这里再拉一次。
            // 长轮询下这个信号一到就醒，比改造前的 1s 更快。
            petBridge.reload(); // 内部 GET /config（该响应已带 no-cache）→ applyMerged → visiblePets 重算
          } else if (path === 'sections.balance') {
            const hit = readBalance(leaf);
            if (hit) applyBalanceRef.current(hit.state, hit.manual);
          } else if (path === 'sections.workStatus') {
            const snap = readWorkStatus(leaf);
            if (snap) {
              setWorkStatus(snap);
              setWorkStatusTick((t) => t + 1); // 任何变化都触发（含回到空闲：用于收起常驻气泡）
            }
          } else if (path === 'sections.notify') {
            // 系统通知（单槽：同一秒多条只留最后一条，由 host 决定）→ 弹 toast（内部有开关/聚焦/权限门）
            notifyFromFrame(leaf.data);
          } else if (path.startsWith('pets.') && path.endsWith('.say')) {
            // 说话叶子：路径形如 pets.<id>.say。宠物 id **允许含点号**，所以按前缀/后缀切片，
            // 绝不 split('.')（那会把 id 切碎、派发给不存在的宠物）。
            const petId = path.slice('pets.'.length, -'.say'.length);
            const said = readSay(leaf);
            if (said) {
              sayRef.current[petId] = { ...said, seq: (sayRef.current[petId]?.seq ?? 0) + 1 };
              setSayTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.anim')) {
            // 点播动画叶子：路径形如 pets.<id>.anim。同样按前缀/后缀切片，绝不 split('.')。
            // 每次写入 counter 都递增，所以同一个动画连点两次也会分发两次（重播）。
            const petId = path.slice('pets.'.length, -'.anim'.length);
            const hit = readAnim(leaf);
            if (hit) {
              animCueRef.current[petId] = {
                name: hit.name,
                url: hit.url,
                playbackId: hit.playbackId,
                facing: hit.facing,
                seq: (animCueRef.current[petId]?.seq ?? 0) + 1,
              };
              setAnimCueTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.position')) {
            // 位置指令叶子：路径形如 pets.<id>.position（同样按前缀/后缀切片，绝不 split('.')）
            const petId = path.slice('pets.'.length, -'.position'.length);
            const hit = readPosition(leaf);
            if (hit) {
              posCueRef.current[petId] = { ...hit, seq: (posCueRef.current[petId]?.seq ?? 0) + 1 };
              setPosCueTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.throw')) {
            // 抛掷指令叶子：路径形如 pets.<id>.throw
            const petId = path.slice('pets.'.length, -'.throw'.length);
            const hit = readThrow(leaf);
            if (hit) {
              throwCueRef.current[petId] = { ...hit, seq: (throwCueRef.current[petId]?.seq ?? 0) + 1 };
              setThrowCueTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.lock')) {
            // 占用锁叶子：路径形如 pets.<id>.lock（同样按前缀/后缀切片，绝不 split('.')）。
            // 与上面四个不同，它是**状态**不是指令：PetCard 读它决定要不要冻结自己，
            // 并按叶子里的 expiresAt 自己定时解除（宿主侧过期是懒判的，不会推"锁没了"）。
            const petId = path.slice('pets.'.length, -'.lock'.length);
            const hit = readLock(leaf);
            if (hit) {
              lockRef.current[petId] = hit;
              setLockTick((t) => t + 1);
            }
          }
        }
      };
      // 自调度循环：**请求 → 处理 → 立刻再请求**。宿主侧在没变化时挂起，所以这个循环
      // 空闲时是 1 请求/秒（与改造前一致），有变化时立刻收到——不需要"前端动作后叫醒一拍"
      // 那套了：动作端点都会写叶子 → 版本变 → 挂着的这一拍自己就返回了。
      const loop = async () => {
        while (alive) {
          let s: PollState | null = null;
          try {
            s = await fetchState(
              undefined,
              longPoll && since !== undefined ? { since, timeoutMs: STATE_WAIT_MS } : undefined,
            );
          } catch {
            /* 轻量轮询失败静默：下一拍再试 */
          }
          if (!alive) return;
          if (s) {
            longPoll = typeof s.counter === 'number';
            if (longPoll) since = s.counter;
            applyState(s);
          }
          // 长轮询命中（或首拉）→ 立刻再请求，宿主已经替我们等过了；
          // 失败 / 老宿主 → 退避一个间隔（不退避就是忙等）。
          if (!s || !longPoll) await new Promise((r) => setTimeout(r, STATE_FALLBACK_MS));
        }
      };
      void loop();
      return () => {
        alive = false;
      };
    }, [ready]);

    return ready
      ? visiblePets.map((p) =>
          h(PetCard, {
            key: p.id,
            cfg: p as RuntimePet,
            balance,
            balanceTick,
            balanceNoticeTick,
            balanceManual,
            workStatus,
            workStatusTick,
            say: sayRef.current[p.id],
            sayTick,
            animCue: animCueRef.current[p.id],
            animCueTick,
            posCue: posCueRef.current[p.id],
            posCueTick,
            throwCue: throwCueRef.current[p.id],
            throwCueTick,
            lock: lockRef.current[p.id],
            lockTick,
            arena: arenaRef,
          }),
        )
      : null;
  }

  return PetMulti;
}
