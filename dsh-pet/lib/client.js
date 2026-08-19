/**
 * ============================================================================
 * dsh-pet 浏览器半侧（browser half）—— 宠物插件的"前端"部分
 * ============================================================================
 *
 * 【这个文件是什么】
 *   本文件是宠物在浏览器里运行的代码。它：
 *   1. 以官方规定的"客户端 bundle 形态"注册自己（window.__ModuleLoader__.load）
 *   2. 把宠物组件挂到 DSH 界面的 `shell.overlay` 槽位（右下角的浮动层）
 *   3. 负责宠物的所有视觉与交互：播放动画、随机行为、点击/拖拽、屏幕漫游
 *
 * 【为什么长这样（重要背景）】
 *   DSH 的浏览器插件必须是一个特殊格式的 JS 文件：
 *   - 用 `window.__ModuleLoader__.load({ id, factory })` 注册
 *   - factory 接收一个同步的 `require`，用它拿 React 和 DSH 提供的模块
 *   - **不能**自己打包 React（React 由 DSH 外壳提供，这里直接 require）
 *   - CSS 以字符串形式内联注入 <style> 标签
 *   官方插件（如 dsh-client-ui-goal）的 lib/client.js 就是这种形态，
 *   本文件是手写等价实现，零构建依赖，方便直接阅读和修改。
 *
 * 【动画文件从哪来】
 *   动画视频通过 /pet/thumb/<动画名>.webm 加载——这个路由由宿主半侧
 *   （lib/index.js）提供，把 assets/thumb/ 下的 WebM 文件发给浏览器。
 *
 * ============================================================================
 */
window.__ModuleLoader__.load({
	// 插件唯一 ID，必须与 package.json 里声明的一致
	id: 'dsh-pet',

	// factory：浏览器加载本 bundle 时执行，返回插件的导出
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ---- 从 DSH 外壳拿 React（不能自己打包） ----
		let react = require('react');
		let { useEffect, useRef, useState } = react;
		// jsx 是 React 18 的新 JSX 转换函数，这里起个别名 h 方便书写
		let { jsx: h } = require('react/jsx-runtime');

		// ============================================================================
		// 内联 CSS —— 注入一次，官方插件标准做法
		// ============================================================================
		// 说明：
		// - .dsh-pet-root       宠物的根容器，fixed 定位（相对视口），默认右下角
		// - .dsh-pet-stage      内部舞台，承载两个 video 的层叠
		// - .dsh-pet-video      动画视频；opacity 默认 0（隐藏），.is-front 时显示
		// - 双 video 层叠：一个显示、一个预加载，切换时交叉淡入避免闪空白
		const css = [
			// 根容器：fixed 固定定位、层级 40（在界面之上）、整体点击穿透（不挡界面操作）、禁止选中
			'.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
			// 四角定位：边距由 CSS 变量 --dsh-pet-mx/--dsh-pet-my 控制（默认右下 right24/bottom0）。
			// 角落仅在"没有自定义位置"（未拖拽/未移动）时生效——即"初始位置"。
			'.dsh-pet-root[data-corner="bottom-right"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
			'.dsh-pet-root[data-corner="bottom-left"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
			'.dsh-pet-root[data-corner="top-right"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
			'.dsh-pet-root[data-corner="top-left"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
			// 舞台：16:9（--dsh-pet-size 为宽度，默认 462px=高度260；高度自动 = 宽度×9/16），本身不响应鼠标
			'.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}',
			// 视频：铺满舞台、保持比例，**pointer-events:none 完全穿透**——
			// 交互统一由覆盖 HIT_BOX 区域的 .dsh-pet-hit 层负责，透明区域点击直达下层 UI。
			'.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}',
			// 显示中的视频（is-front 类）
			'.dsh-pet-video.is-front{opacity:1}',
			// 命中层：覆盖人物区域（HIT_BOX），是唯一可交互区域；光标跟随 + 拖拽抓取
			'.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:default;z-index:1}',
			'.dsh-pet-hit.dragging{cursor:grabbing}',
			// 朝向镜像说明：不用 CSS 全局规则（data-facing）控制镜像——facing 翻转会
			// 同步镜像所有 video（含仍在显示的旧视频），造成"旧帧被镜像"的闪烁。
			// 镜像改为在 switchTo 的 onReady 里按实际朝向给每个 video 设置 inline
			// transform（见 onReady）：新视频按新朝向显示、旧视频保持自己的 transform
			// 淡出，两者互不影响，facing 翻转时机因此无关紧要。
			// 无障碍：用户系统开启"减少动态效果"时关闭过渡动画
			'@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
		].join('\n');
		const cssTag = 'dsh-pet/style.css';
		// 只在页面还没有这个 style 标签时才注入（防止热重载/重复挂载时重复）
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-pet';
			tag.dataset.pluginCss = cssTag;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ============================================================================
		// 动画目录（animation catalog）—— 所有动画名和参数的"事实来源"
		// ============================================================================
		// 对齐说明：thumb 视频是 640×360（16:9）画布，人物的"脚底"在 y=330 处。
		// (360-330)/360 = 30/360 = 0.0833，与 2160x1215 母版 (1215-1115)/1215 比例一致，
		// 所以用这个比例做落地对齐，缩放后依然准确。
		const CANVAS_H = 360; // thumb 画布高度
		const FEET_Y = 330;   // thumb 画布上"脚底"的 y 坐标（人物站在 y=330 线上）

		// ---- 点击/拖拽命中矩形（thumb 640×360 像素坐标）----
		// normalize 已把全部动画的人物统一缩放居中。41 个动画站立帧 bbox 并集
		// 为 x:138~461, y:42~339，但并集被少数伸左手的动画撑宽，视觉上左边
		// 多出很多、右边多 ~25px。多数动画实际约 x:214~425（中心≈320），
		// 取对称整数范围 x:200~440（中心 320），y:50~335 贴近头顶/脚底。
		const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };

		// ==== 动作配置：唯一事实来源 = config.jsonc 的 animations/animationWeights ====
		// 保留一个"安全兜底待机名"，用于初始渲染 / 配置缺失时宠物不至于空白。
		const FALLBACK_IDLE = '待机呼吸休闲';
		let ANIM = {
			idle: [FALLBACK_IDLE],
			turn: [],
			drag: [],
			clicks: [],
			moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [] },
			categories: [],
			weights: { idle: 100, turn: 0, move: 0 },
		};
		// 从 config.jsonc 构建 ANIM（缺字段/写错尽量安全兜底；目录以配置为准）
		const applyAnimConfig = (obj) => {
			const a = obj && obj.animations;
			if (!a || typeof a !== 'object') return;
			const w = (obj && obj.animationWeights) || {};
			const strArr = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
			const idle = strArr(a.idle);
			if (!idle.length) idle.push(FALLBACK_IDLE); // 至少一个待机，避免空白
			const turn = strArr(a.turn);
			const drag = strArr(a.drag);
			const clicks = strArr(a.clicks);
			let mdef = { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 };
			let mActs = [];
			if (a.moves && typeof a.moves === 'object') {
				if (a.moves.default && typeof a.moves.default === 'object') mdef = Object.assign({}, mdef, a.moves.default);
				if (Array.isArray(a.moves.actions)) {
					const list = a.moves.actions.filter((x) => x && x.name).map((x) => ({
						name: String(x.name),
						params: x.params && typeof x.params === 'object' ? Object.assign({}, x.params) : undefined,
					}));
					if (list.length) mActs = list;
				}
			}
			let cats = [];
			if (Array.isArray(a.categories)) {
				const list = a.categories
					.filter((c) => c && c.id && Array.isArray(c.actions) && c.actions.length)
					.map((c) => ({ id: String(c.id), weight: Number(c.weight), noMirror: !!c.noMirror, actions: c.actions.map(String) }));
				if (list.length) cats = list;
			}
			ANIM = {
				idle, turn, drag, clicks,
				moves: { default: mdef, actions: mActs },
				categories: cats,
				weights: {
					idle: Number(w.idle) >= 0 ? Number(w.idle) : 10,
					turn: Number(w.turn) >= 0 ? Number(w.turn) : 5,
					move: Number(w.move) >= 0 ? Number(w.move) : 5,
				},
			};
		};

		// 生成 [min, max) 区间内的随机整数
		const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
		// 从字符串池里等概率随机抽一个；exclude 排除某个名字（避免连续重复）
		const pick = (pool, exclude) => {
			const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
			return entries[Math.floor(Math.random() * entries.length)];
		};
		// 按权重在分类池中选一个分类；noMirror 分类在镜像(facing=right)时被排除，剩余权重自动归一化
		const pickWeightedCategory = (facing) => {
			const cats = ANIM.categories.filter((c) => c.actions.length > 0);
			if (!cats.length) return null;
			const filtered = cats.filter((c) => !(c.noMirror && facing === 'right'));
			const eligible = filtered.length ? filtered : cats;
			const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
			let t = Math.random() * totalW;
			for (const c of eligible) {
				t -= c.weight;
				if (t <= 0) return c;
			}
			return eligible[eligible.length - 1];
		};
		// 剥除 JSONC 注释（// 与 /* */），得纯 JSON 字符串。仅用于插件自带配置（无含 // 的 URL 值）
		const stripJsonc = (src) =>
			src
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/(^|[^\\:])\/\/.*$/gm, '$1')
				.trim();

		// ============================================================================
		// Pet 组件 —— 宠物本体
		// ============================================================================
		/**
		 * 核心组件。职责：
		 * 1. 渲染"双缓冲"的一对 <video>（A/B 交替显示），切换动画时交叉淡入，永无空白帧
		 * 2. 状态机：待机 →（定时器随机）→ 转向/移动/动作；点击/拖拽可打断
		 * 3. 朝向（facing）渲染：right 时 CSS 镜像
		 *
		 * 参数 config：来自 patch 配置。当前 DSH 客户端配置管线尚未打通，
		 * 实际收到的是空对象，所以下面全部用 || 默认值兜底。
		 */
		function Pet({ config }) {
			// ---- 桌宠尺寸（默认 462px 宽；可由 /pet/config.jsonc 的 size 覆盖）----
			const [size, setSize] = useState(462); // 显示尺寸（px，宽度；高度=size×9/16）
			// 舞台 16:9：宽=size、高=size×9/16；中心偏移（定位/拖拽共用）
			const halfW = size / 2;
			const halfH = size * 9 / 16 / 2;

			// ---- React 状态 ----
			const [anim, setAnim] = useState(FALLBACK_IDLE);   // 当前动画名（配置加载后由 config 待机接管）
			const [once, setOnce] = useState(true);   // 是否一次性播放——链式模型全部一次性
			const [facing, setFacing] = useState('left'); // 朝向：left | right
			const [dragging, setDragging] = useState(false); // 是否正在拖拽
			// 自定义位置（拖拽/移动后宠物停留的视口坐标）；null = 回到默认角落
			const [customPos, setCustomPos] = useState(null);
			// 初始角落与边距（默认右下 right24/bottom0；可被 /pet/config.jsonc 覆盖）
			const [corner, setCorner] = useState('bottom-right');
			const [margin, setMargin] = useState({ x: 24, y: 0 });
			// 拉取 /pet/config.jsonc 应用位置配置；失败/缺失/写错均静默沿用代码默认
			useEffect(() => {
				fetch('/pet/config.jsonc')
					.then((r) => { if (!r.ok) throw new Error('config'); return r.text(); })
					.then((src) => {
						const obj = JSON.parse(stripJsonc(src));
						const sz = Number(obj && obj.size);
						if (Number.isFinite(sz) && sz > 0) setSize(sz);
						const p = obj && obj.position;
						if (p) {
							if (['top-left', 'top-right', 'bottom-left', 'bottom-right'].indexOf(p.corner) !== -1) setCorner(p.corner);
							const mx = Number(p.marginX);
							const my = Number(p.marginY);
							if (!Number.isNaN(mx)) setMargin((m) => ({ ...m, x: mx }));
							if (!Number.isNaN(my)) setMargin((m) => ({ ...m, y: my }));
						}
						// 应用动作配置（idle/turn/drag/clicks/moves/categories/weights）
						applyAnimConfig(obj);
						// 配置就绪后用待机动画启动（不依赖任何代码默认数据）
						if (ANIM && ANIM.idle && ANIM.idle.length) {
							setAnim(ANIM.idle[0]);
							setSeq((s) => s + 1);
						}
					})
					.catch(() => {});
			}, []);
			// 播放序号：每次切换 +1。即使连续选中同一个动画（如待机播完又选待机），
			// seq 变化也能保证 switchTo 重新执行、视频重新播放（否则 anim 没变 React 不重渲染）。
			const [seq, setSeq] = useState(0);
			// ---- DOM 引用 ----
			const rootRef = useRef(null);  // 根容器（fixed 定位）
			const stageRef = useRef(null); // 内部舞台（落地对齐）
			const videoARef = useRef(null); // 视频 A
			const videoBRef = useRef(null); // 视频 B
			// ---- 双缓冲/竞态相关 ref ----
			const frontRef = useRef(0);  // 当前显示的是哪个视频：0=A, 1=B
			const pendingRef = useRef(null); // 正在加载中的 {anim, once, gen}
			const genRef = useRef(0);    // 切换代数：每次切换 +1，用于识别"过期回调"
			// ---- 交互相关 ref ----
			const dragRef = useRef({ active: false, dragging: false, sx: 0, sy: 0 }); // 拖拽状态
			const justDraggedRef = useRef(false); // 刚拖拽完（用于抑制拖拽后的误点击）
			const animRef = useRef(FALLBACK_IDLE); // 动画名镜像（供异步回调读当前值）
			animRef.current = anim;

			// ============================================================================
			// 双缓冲切换（switchTo）—— 核心播放逻辑
			// ============================================================================
			// 思路：两个 video 层叠。切换动画时：
			//   1. 把目标动画 src 设到"非当前显示"的那个 video 上
			//   2. 等它 loadeddata（数据加载完成）
			//   3. 新 video 淡入（加 is-front），旧 video 淡出（去 is-front）
			//   4. frontRef 翻转，下次切换用另一个
			// 这样切换时旧画面一直显示到新画面就绪，永远不会闪空白。
			//
			// 竞态防护（重要）：快速连点/连续切换时，可能前一个动画还没加载完
			// 就又要切下一个。每个切换有一个递增的"代数" gen，loadeddata 回调
			// 执行时检查自己是否还是最新代——不是就放弃（避免两个 video 都被
			// 移除 is-front 而全部透明、宠物消失）。
			const switchTo = (next, nextOnce) => {
				if (!next) return; // 配置未加载（动画名为空）时不播放
				// 如果目标动画已经在加载中，直接跳过（避免重复加载）
				const pending = pendingRef.current;
				if (pending && pending.anim === next && pending.once === nextOnce) return;
				const gen = ++genRef.current; // 本次切换的代数
				pendingRef.current = { anim: next, once: nextOnce, gen };

				// 目标 video = 当前"非显示"的那个（front 是 A 就用 B，反之用 A）
				const target = frontRef.current === 0 ? videoBRef : videoARef;
				const el = target.current;
				if (!el) return;
				// 设置视频属性并开始加载
				el.src = '/pet/thumb/' + encodeURIComponent(next) + '.webm';
				el.loop = !nextOnce;           // 一次性动画不循环
				el.muted = true;               // 静音（动画无声音）
				el.autoplay = true;            // 自动播放
				el.playsInline = true;         // 行内播放（移动端不弹全屏）
				el.onended = nextOnce ? handleEnded : undefined; // 一次性动画播完 → 回待机
				el.load();

				// 数据加载完成后的回调
				const onReady = () => {
					el.removeEventListener('loadeddata', onReady);
					// 过期检查：如果期间又有更新的切换，本回调作废
					if (pendingRef.current?.gen !== gen) return;
					// 交换前后台：新 video 加 is-front（淡入），旧 video 移除（淡出）
					const old = frontRef.current === 0 ? videoARef : videoBRef;
					el.classList.add('is-front');
					// old !== el 守卫：防止把自己刚加的 is-front 又移除
					if (old.current && old.current !== el) old.current.classList.remove('is-front');
					frontRef.current = frontRef.current === 0 ? 1 : 0;
					pendingRef.current = null;
					// 按实际朝向设置新视频镜像（inline transform，不依赖全局 CSS）：
					// facing=right 时 scaleX(-1)。onReady 时 facingRef 已是翻转后的值
					// （setFacing 的渲染先于 switchTo 执行）；旧视频 transform 不动，
					// 淡出时保持原朝向，不会露出未镜像的原画面。
					el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
					el.play().catch(() => {}); // 开始播放（捕获自动播放策略异常）
					// 如果这是"计划中的移动"的动画，现在动画就绪了，
					// 开始驱动位置移动（见 startMoveDrive）
					if (pendingMoveRef.current) startMoveDrive(el);
				};
				el.addEventListener('loadeddata', onReady);
				// 如果视频已缓存就绪（readyState>=2），立即触发回调
				if (el.readyState >= 2) onReady();
			};

			// ============================================================================
			// 随机事件定时器 —— 待机时的"自主行为"
			// ---- 状态驱动播放：anim/once/seq 一变就切换视频 ----
			// seq 参与依赖：即使 anim/once 没变（连续选中同一动画），seq 变化也强制重播。
			useEffect(() => {
				switchTo(anim, once);
			}, [anim, once, seq]);

			// ---- 组件卸载时清理移动 rAF ----
			useEffect(() => () => { stopMove(); }, []);

			// ---- 窗口尺寸变化：重算比例位置（触发重渲染，宠物保持相对窗口位置） ----
			useEffect(() => {
				const onResize = () => {
					// 有自定义位置时，用同值 setCustomPos 触发重渲染；
					// 渲染逻辑会用新窗口尺寸 × 比例重算坐标。
					setCustomPos((prev) => (prev ? { ...prev } : prev));
				};
				window.addEventListener('resize', onResize);
				return () => window.removeEventListener('resize', onResize);
			}, []);

			// ============================================================================
			// 动画链：每次动画播完 → 按概率选下一个
			// ============================================================================
			// 链式模型（无常驻待机、无定时器）：
			//   每个动画（含待机动画）都是一次性播放，播完 handleEnded 触发，
			//   按概率选下一个：待机10% / 转向5% / 移动5% / 小动作20% / 玩耍20% / 吃什么20% / 时节20%。
			//   点击/拖拽打断的动画播完后先回待机（作为缓冲），待机播完再进随机链。
			const pickNext = () => {
				if (!ANIM) return; // 配置未加载：不进入动画链
				const roll = Math.random();
				// 顶层权重（百分比）：idle / turn / move，其余归给分类池
				const wI = ANIM.weights.idle;
				const wT = ANIM.weights.turn;
				const wM = ANIM.weights.move;
				const topEnd = (wI + wT + wM) / 100;
				let kind = '';
				let next = '';
				if (roll < wI / 100) { // 待机（idle 池内随机，一次性播放）
					kind = 'IDLE';
					next = pick(ANIM.idle, animRef.current);
					setAnim(next);
				} else if (roll < (wI + wT) / 100) { // 转向（turn 池；播完 handleEnded 里翻转 facing）
					kind = 'TURN';
					next = pick(ANIM.turn, animRef.current);
					setAnim(next);
				} else if (roll < topEnd) { // 移动：tryMove 先检查空间，不够则回退按权重随机分类
					if (!tryMove()) {
						const cat = pickWeightedCategory(facingRef.current);
						kind = cat ? cat.id : 'FALLBACK';
						next = cat ? pick(cat.actions, animRef.current) : pick(ANIM.idle, animRef.current);
						setAnim(next);
					} else {
						kind = 'MOVES';
						next = '移动(池内随机)';
					}
				} else { // 其余：按权重选随机分类（镜像时跳过 noMirror 分类，如“文字”）
					const cat = pickWeightedCategory(facingRef.current);
					kind = cat ? cat.id : 'FALLBACK';
					next = cat ? pick(cat.actions, animRef.current) : pick(ANIM.idle, animRef.current);
					setAnim(next);
				}
				// 【测试用】打印随机数 + 动画种类 + 选中动画，方便核对概率分布；正式版可删除
				console.log('[dsh-pet] roll=' + roll.toFixed(4) + ' → [' + kind + '] ' + next);
				setOnce(true);        // 链式模型全部一次性
				setSeq((s) => s + 1); // 保证即使 anim 没变也重新播放
			};

			// 一次性动画播完的回调：决定下一个动画。
			// 拖拽中途不响应（让拖拽动画继续）。
			const handleEnded = () => {
				if (dragRef.current.active) return; // 拖拽中：不打断
				if (!ANIM) return; // 配置未加载
				if (ANIM.turn.includes(animRef.current)) {
					// 转向动画播完 → 翻转朝向
					setFacing((f) => (f === 'left' ? 'right' : 'left'));
				}
				// 点击回应/拖拽动画（用户打断触发的）播完 → 先回待机缓冲
				if (ANIM.drag.includes(animRef.current) || ANIM.clicks.includes(animRef.current)) {
					if (ANIM.idle.length) setAnim(pick(ANIM.idle, animRef.current));
					setOnce(true);
					setSeq((s) => s + 1);
					return;
				}
				// 自主链动画播完 → 按概率选下一个
				pickNext();
			};

			// ============================================================================
			// 移动系统 —— 动画提供姿态，代码驱动位置
			// ============================================================================
			const moveRef = useRef(null);        // 移动中的 rAF id
			const moveTokenRef = useRef(0);      // 移动令牌：每次取消 +1 使旧回调失效
			const pendingMoveRef = useRef(null); // 计划中的移动 {startX,startY,target,dir,total}
			const customPosRef = useRef(null);   // customPos 的 ref 镜像（供异步读取）
			customPosRef.current = customPos;

			// 当前宠物中心 x（视口坐标）：
			// customPos 存"相对窗口比例"（rx = centerX/innerWidth），渲染时乘当前窗口尺寸。
			// 窗口 resize 后按新尺寸重算 → 宠物保持相对位置。
			const currentCenterX = () => {
				const cp = customPosRef.current;
				if (cp) return cp.rx * window.innerWidth;
				const rootEl = rootRef.current;
				if (rootEl) return rootEl.getBoundingClientRect().left + halfW;
				return window.innerWidth - 24 - halfW;
			};
			// 当前宠物中心 y（视口坐标）
			const currentCenterY = () => {
				const cp = customPosRef.current;
				if (cp) return cp.ry * window.innerHeight;
				const rootEl = rootRef.current;
				if (rootEl) return rootEl.getBoundingClientRect().top + halfH;
				return window.innerHeight - 20 - halfH;
			};

			/**
			 * 启动"位置驱动"循环。只在移动动画真正加载完成并开始播放后调用
			 * （在 switchTo 的 onReady 里），保证人物姿态先出现在屏幕上、位置才开始动。
			 *
			 * 关键设计：位置跟随动画的播放时钟（video.currentTime）——
			 *   动画开头 MOVE_LEAD_SEC(2s) 是准备动作：位置不动
			 *   中间窗口：位置按 (t-LEAD)/window 比例从起点走向终点
			 *   结尾 MOVE_TAIL_SEC(2s) 是收尾动作：位置已到终点不动
			 * 这样踏步节奏和位移完全同步，不会有"滑步"。
			 */
			const startMoveDrive = (el) => {
				const pm = pendingMoveRef.current;
				if (!pm || moveRef.current !== null) return; // 没有计划或已在移动
				pendingMoveRef.current = null;
				const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
				// 动画时长驱动节奏（10.09s），取不到时兜底
				const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
				// 真正移动的窗口 = 总时长 - 前后 leadSec/tailSec（至少 0.1s 防除零）
				// 命名注意：不能叫 window——会遮蔽全局 window，导致 window.innerWidth 变 undefined（历史 bug）
				const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
				const token = ++moveTokenRef.current;
				const step = () => {
					if (moveTokenRef.current !== token) return;
					const t = el.currentTime || 0; // 动画当前播放进度（秒）
					const rootEl = rootRef.current;
					if (rootEl) {
						// 每帧用"当前窗口尺寸 × 比例"算实际坐标——resize 后自动跟随
						const W = window.innerWidth;
						const H = window.innerHeight;
						let ratioX;
						if (t <= leadSec) {
							ratioX = startRatio; // 准备动作：原地
						} else if (t >= duration - tailSec) {
							ratioX = targetRatio; // 收尾动作：已到终点
						} else {
							// 移动窗口：按进度插值（比例制）
							const progress = (t - leadSec) / travelWindow;
							ratioX = startRatio + dir * totalRatio * progress;
						}
						const px = ratioX * W;
						const py = startYRatio * H;
						// 直接改 DOM style（不触发 React 重渲染，保证 60fps 平滑）
						rootEl.style.left = (px - halfW) + 'px';
						rootEl.style.top = (py - halfH) + 'px';
						rootEl.style.right = 'auto';
						rootEl.style.bottom = 'auto';
					}
					if (t < duration - tailSec) {
						moveRef.current = requestAnimationFrame(step); // 继续下一帧
					} else {
						// 到位：提交终点位置（存相对窗口比例），让动画自然播完最后 2s 收尾——
						// 它是一次性动画，ended 事件会带我们回待机
						moveRef.current = null;
						setCustomPos({ rx: targetRatio, ry: startYRatio });
					}
				};
				moveRef.current = requestAnimationFrame(step);
			};

			/**
			 * 尝试计划一次移动（朝当前 facing 方向）。
			 * 只做两件事：检查空间是否够 + 记录计划；真正的位置驱动
			 * 等移动动画就绪后由 switchTo 的 onReady 触发。
			 * @returns {boolean} true=移动已计划；false=空间不够（调用方回退随机动作）
			 */
			const tryMove = () => {
				if (!ANIM) return false; // 配置未加载
				if (moveRef.current !== null || pendingMoveRef.current) return true; // 已在移动/已计划
				const actions = ANIM.moves.actions;
				if (!actions.length) return false;
				const chosen = actions[Math.floor(Math.random() * actions.length)];
				// 该动作合并参数：全局默认 + 该动作覆盖
				const mp = Object.assign({}, ANIM.moves.default, chosen.params || {});
				// 方向按"实际朝向"计算：若刚播完转向动画，facing 即将翻转，方向取反
				const dir = (facingRef.current === 'right') !== ANIM.turn.includes(animRef.current) ? 1 : -1;
				const W = window.innerWidth;
				const cx = currentCenterX();
				const distance = randomBetween(mp.minDist, mp.maxDist);
				const target = cx + dir * distance;
				// 【播放前检查一次距离】目标点必须在屏幕安全边距内，否则不移动
				const leftBound = mp.margin + halfW;
				const rightBound = W - mp.margin - halfW;
				if (target < leftBound || target > rightBound) return false; // 空间不够
				// 记录计划（存"比例"，含该动作的 leadSec/tailSec 供 startMoveDrive 使用）
				pendingMoveRef.current = {
					startRatio: cx / W,
					startYRatio: currentCenterY() / window.innerHeight,
					targetRatio: target / W,
					dir,
					totalRatio: Math.abs(target - cx) / W,
					leadSec: mp.leadSec,
					tailSec: mp.tailSec,
				};
				// 移动动画一次性播放（10s），播完 ended 触发 handleEnded → 进入动画链
				setOnce(true);
				setAnim(chosen.name);
				return true;
			};
			// 停止移动（点击/拖拽打断时调用）：取消计划 + 使 rAF 失效 + 取消帧
			const stopMove = () => {
				pendingMoveRef.current = null;
				moveTokenRef.current++;
				if (moveRef.current !== null) {
					cancelAnimationFrame(moveRef.current);
					moveRef.current = null;
				}
			};

			// facing 的 ref 镜像（tryMove/定时器读取当前朝向）
			const facingRef = useRef(facing);
			facingRef.current = facing;

			// ============================================================================
			// 点击 vs 拖拽的区分
			// ============================================================================
			// 问题：按下+松开可能是一次"点击"，也可能是一次"拖拽"。
			// 方案：pointerdown 只记录起点；pointermove 超过 5px 才判定为拖拽
			// （播放拖拽动画并跟手）；松手时若没拖过，click 事件正常触发点击回应。
			const DRAG_THRESHOLD = 5; // 拖拽判定阈值（px）

			// ---- 命中层（.dsh-pet-hit）覆盖 HIT_BOX 区域 ----
			// 交互范围由 CSS 命中层限定：视频 pointer-events:none（完全穿透），
			// 命中层 pointer-events:auto 只覆盖人物区域。所以这里的事件天然都在
			// 人物范围内，无需再做坐标命中检查；命中层之外点击直达下层 UI。
			// 按下：只记录，不立即切动画
			const handlePointerDown = (e) => {
				e.currentTarget.classList.add('dragging'); // 拖拽中抓取光标
				stopMove(); // 用户交互打断正在进行的移动
				e.currentTarget.setPointerCapture(e.pointerId); // 捕获指针（拖出元素也能收到 move）
				// 记录"鼠标点相对舞台中心的偏移"（舞台宽 size、高 size×9/16）：
				// 拖动时保持该偏移，从人物任意位置抓起都不会瞬移到鼠标下。
				const rootEl = rootRef.current;
				let offX = 0, offY = 0;
				if (rootEl) {
					const rr = rootEl.getBoundingClientRect();
					offX = e.clientX - (rr.left + rr.width / 2);
					offY = e.clientY - (rr.top + rr.height / 2);
				}
				dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY, offX, offY };
			};
			// 移动：超过阈值才进入拖拽模式
			const handlePointerMove = (e) => {
				const d = dragRef.current;
				if (!d.active) return;
				const dx = e.clientX - d.sx;
				const dy = e.clientY - d.sy;
				if (!d.dragging) {
					// 还没超过阈值：仍是"点击候选"，不动
					if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
					// 进入拖拽：播放拖拽动画
					d.dragging = true;
					setDragging(true);
					setOnce(true);
					if (ANIM.drag.length) setAnim(pick(ANIM.drag));
				}
				// 跟手：直接改 root 的 style（不触发 React 重渲染 → 60fps 平滑）
				// 舞台中心 = 鼠标点 - 按下时记录的偏移；left/top 是 root 左上角，
				// 舞台宽 size、高 size×9/16，所以中心再减一半尺寸。
				const rootEl = rootRef.current;
				if (rootEl) {
					const halfW = size / 2;
					const halfH = size * 9 / 16 / 2;
					rootEl.style.left = (e.clientX - d.offX - halfW) + 'px';
					rootEl.style.top = (e.clientY - d.offY - halfH) + 'px';
					rootEl.style.right = 'auto';
					rootEl.style.bottom = 'auto';
				}
				const stageEl = stageRef.current;
				if (stageEl) stageEl.style.transform = 'none'; // 拖拽时去掉落地偏移
			};
			// 松手：真拖拽则停留 + 回待机；没拖过则等 click 事件
			const handlePointerUp = (e) => {
				const d = dragRef.current;
				const wasDragging = d.dragging;
				d.active = false;
				d.dragging = false;
				e.currentTarget.classList.remove('dragging'); // 结束抓取光标
				if (wasDragging) {
					// 抑制拖拽结束后的"幽灵点击"（浏览器在拖完也会发 click）
					justDraggedRef.current = true;
					setTimeout(() => { justDraggedRef.current = false; }, 100);
					setDragging(false);
					// 停在松手处（以舞台中心为基准，而非鼠标点——从角落抓起时
					// 松手也保持偏移，宠物不会跳回鼠标位置）；存相对窗口比例，
					// 窗口变化时位置跟随。
					setCustomPos({
						rx: (e.clientX - d.offX) / window.innerWidth,
						ry: (e.clientY - d.offY) / window.innerHeight,
					});
					const stageEl = stageRef.current;
					if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)'; // 恢复落地对齐
					if (ANIM.idle.length) setAnim(pick(ANIM.idle, animRef.current));
					setOnce(false);
				}
				// 没拖过：交给 handleClick
			};

			// ---- 点击回应（仅真点击触发，拖拽后的 click 被忽略） ----
			const handleClick = (e) => {
				if (!ANIM) return; // 配置未加载
				const d = dragRef.current;
				if (d.active || d.dragging || justDraggedRef.current) return; // 拖拽中/刚拖完：忽略
				if (once && !ANIM.idle.includes(animRef.current)) return; // 正在播一次性动画：不打断
				stopMove(); // 点击打断移动
				setOnce(true);
				if (ANIM.clicks.length) setAnim(pick(ANIM.clicks)); // 随机一个点击回应动画
			};

			// ============================================================================
			// 渲染
			// ============================================================================
			// 落地对齐：视频是 640×360 画布、脚在 y=330，脚底距画布底 30px（8.33%）。
			// 舞台是 16:9（高 = size×9/16），脚底距舞台底 = 舞台高 × 8.33%；
			// bottomPad 就是把这个距离下移，让"脚"正好落在视口底线上。
			const bottomPad = (size * 9 / 16 * (CANVAS_H - FEET_Y)) / CANVAS_H;
			// 舞台样式：拖拽中无偏移；平时 translateY(bottomPad) 落地
			const stageStyle = dragging
				? { transform: 'none' }
				: { transform: 'translateY(' + bottomPad + 'px)' };

			// 根容器样式：有自定义位置（拖过/走过）就按"相对窗口比例 × 当前窗口尺寸"定位；
			// 否则不设（走 CSS 的 data-corner 默认角落，天然响应式）。
			// resize 后重渲染会用新尺寸重算 → 宠物保持相对位置；
			// 同时钳制到窗口内，防止窗口缩小到宠物放不下时跑出屏幕。
			const rootStyle = customPos
				? (() => {
					const rx = customPos.rx;
					const ry = customPos.ry;
					const left = Math.min(Math.max(rx * window.innerWidth - halfW, 0), window.innerWidth - size);
					const top = Math.min(Math.max(ry * window.innerHeight - halfH, 0), window.innerHeight - size * 9 / 16);
					return { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
				})()
				: {};

			// 两个 video 共用的 props（纯播放属性，交互交给命中层）
			const commonVideoProps = {
				muted: true,
				playsInline: true,
				autoPlay: true,
				title: 'dsh-pet',
			};
			// 命中层 props：覆盖 HIT_BOX 区域，承载全部交互事件与抓取光标。
			// 命中层内必然命中人物，光标固定 grab（拖拽中 .dragging 类显示 grabbing）。
			const hitProps = {
				className: 'dsh-pet-hit',
				style: {
					left: (HIT_BOX.x0 / 640 * 100) + '%',
					top: (HIT_BOX.y0 / 360 * 100) + '%',
					width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640 * 100) + '%',
					height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360 * 100) + '%',
				},
				onMouseEnter: (e) => { if (!dragRef.current.active) e.currentTarget.style.cursor = 'grab'; },
				onMouseLeave: (e) => { if (!dragRef.current.active) e.currentTarget.style.cursor = 'default'; },
				onClick: handleClick,
				onPointerDown: handlePointerDown,
				onPointerMove: handlePointerMove,
				onPointerUp: handlePointerUp,
				onPointerCancel: handlePointerUp,
				title: 'dsh-pet',
			};

			// 渲染树：root > stage > [video A, video B, 命中层]
			// A 初始带 is-front（显示），B 隐藏待命；命中层在最上层承载交互
			return h('div', {
				ref: rootRef,
				className: 'dsh-pet-root',
				'data-corner': corner,   // CSS 决定默认角落
				'data-facing': facing,   // CSS 决定是否镜像
				style: Object.assign({ '--dsh-pet-size': size + 'px', '--dsh-pet-mx': margin.x + 'px', '--dsh-pet-my': margin.y + 'px' }, rootStyle),
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
			});
		}

		// ============================================================================
		// 插件主体（Cordis 插件三件套：name / inject / apply）
		// ============================================================================
		const name = 'pet';        // 插件行 id（与 cordis.patch.yml 一致）
		const inject = ['slots'];  // 需要注入的服务：slots（槽位注册表）

		// apply：插件被激活时调用
		function apply(ctx, config) {
			// 官方"叠加式"注册模式：
			// slots.inject 等 shell.overlay 槽位被声明后，再注册我们的条目。
			// 用 generator + yield 形式（与官方 dsh-client-ui-directory-picker-native 一致），
			// 这样不会替换其他条目，而是以 id='pet' 叠加进列表槽。
			ctx.slots.inject('shell.overlay', function* () {
				yield ctx.slots.register({
					name: 'shell.overlay',
					id: 'pet',       // 列表槽的条目 id（唯一）
					order: 1000,     // 排序（大 = 靠后渲染）
				}, (ownerProps) => h(Pet, { config, ...ownerProps }));
			});
		}

		// 导出插件三件套（Cordis Loader 需要）
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
