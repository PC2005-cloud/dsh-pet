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
		// - .dsh-pet-stage      内部舞台，承载多个 video（视频槽池）的层叠
		// - .dsh-pet-video      动画视频；opacity 默认 0（隐藏），.is-front 时显示
		// - 多 video 层叠：一个显示、其余预加载，切换用硬切（等首帧上屏后直接换）
		const css = [
			// 根容器：fixed 固定定位、层级 40（在界面之上）、整体点击穿透（不挡界面操作）、禁止选中
			'.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
			// 右下角默认位置（right:24px 距右缘、bottom:0 贴底）
			'.dsh-pet-root[data-corner="bottom-right"]{right:24px;bottom:0}',
			// 左下角位置
			'.dsh-pet-root[data-corner="bottom-left"]{left:24px;bottom:0}',
			// 舞台：正方形（尺寸由 --dsh-pet-size 控制，默认 260px），本身不响应鼠标
			'.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,260px);height:var(--dsh-pet-size,260px);pointer-events:none}',
			// 视频：铺满舞台、保持比例、可交互（pointer-events:auto 重新开启）、抓取光标
			// opacity:0 初始隐藏；切换用硬切（transition:none），避免交叉淡入产生"双影/闪"
			'.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:auto;cursor:grab;opacity:0;transition:none;transform-origin:center}',
			// 显示中的视频（is-front 类）
			'.dsh-pet-video.is-front{opacity:1}',
			// 按住时显示"抓取中"光标
			'.dsh-pet-video:active{cursor:grabbing}',
			// 朝向镜像：facing=right 时水平翻转（人物偏右）。镜像只作用 CSS，
			// 不碰视频文件——这是"所有动画都能朝左/朝右"的实现关键
			'.dsh-pet-root[data-facing="right"] .dsh-pet-video{transform:scaleX(-1)}',
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
		// 对齐说明：thumb 视频是 360×360 画布，人物的"脚底"在 y=330 处。
		// (360-330)/360 = 30/360 = 0.0833，与 1200 母版 (1200-1100)/1200 比例一致，
		// 所以用这个比例做落地对齐，缩放后依然准确。
		const CANVAS_H = 360; // thumb 画布高度
		const FEET_Y = 330;   // thumb 画布上"脚底"的 y 坐标（人物站在 y=330 线上）

		// 主体待机动画（唯一常驻、循环播放）
		const IDLE = '待机呼吸休闲';
		// 转向动画（东张西望本身内容就是"从偏左看到偏右"，播完翻转 facing）
		const TURN = '东张西望';
		// 随机动作池：纯字符串数组，全部等概率抽取。
		// 含"打瞌睡被惊醒"（原独立闲置动画，已统一纳入）。
		// 注意：原地漂浮踏步不在这里，它是移动动画（在 MOVES 里）。
		const ACTS = [
			'悠闲哼歌',
			'超大伸懒腰',
			'原地专心玩魔方',
			'原地敲击桌面互动',
			'原地重力下蹲压缩',
			'哈欠连天',
			'原地小憩沉眠',
			'原地蹲下玩玩具汽车',
			'鲸鱼吐泡泡特效',
			'女仆屈膝礼仪',
			'被吓一跳（炸毛）',
			'原地跳跃抓碎头顶物品',
			'小幅度原地 360 度旋转展示',
			'偷吃零食被抓住',
			'玩游戏气急败坏',
			'用鲸鱼尾巴拍打地面',
			'打瞌睡被惊醒', // 原独立闲置动画，已并入
		];
		// 点击回应动画池（3 选 1）
		const CLICKS = ['点击回应 - 开心跃动', '点击回应 - 害羞惊讶', '点击回应 - 傲娇生气（侧身展示）'];
		// 拖拽动画（按住时播放）
		const DRAG = '被鼠标拖拽悬空反馈';
		// 移动动画池：动画只提供"走路姿态"，实际位置移动由代码（rAF）驱动
		const MOVES = ['螃蟹走路', '原地漂浮踏步'];
		// 移动参数：
		const MOVE_MIN_PX = 60;  // 每次移动的最短距离（px）
		const MOVE_MAX_PX = 240; // 每次移动的最长距离（px）
		const MOVE_MARGIN = 20;  // 屏幕边缘安全边距（px），防止宠物贴边/出屏
		const MOVE_LEAD_SEC = 2; // 动画开头 2s 是"准备动作"，位置不动
		const MOVE_TAIL_SEC = 2; // 动画结尾 2s 是"收尾动作"，位置不动

		// 生成 [min, max) 区间内的随机整数
		const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
		// 从字符串池里等概率随机抽一个；exclude 排除某个名字（避免连续重复）
		const pick = (pool, exclude) => {
			const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
			return entries[Math.floor(Math.random() * entries.length)];
		};

		// ============================================================================
		// Pet 组件 —— 宠物本体
		// ============================================================================
		/**
		 * 核心组件。职责：
		 * 1. 用"视频槽池"（多个 <video> 层叠）播放动画，切换时交叉淡入，永无空白帧；
		 *    同时常驻预加载待机/拖拽/预抽的下一个动作/预抽的点击回应，高频切换零解码
		 * 2. 状态机：待机 →（随机）→ 转向/移动/动作；点击/拖拽可打断
		 * 3. 朝向（facing）渲染：right 时 CSS 镜像
		 *
		 * 参数 config：来自 patch 配置。当前 DSH 客户端配置管线尚未打通，
		 * 实际收到的是空对象，所以下面全部用 || 默认值兜底。
		 */
		function Pet({ config }) {
			// ---- 从 config 读取参数（当前走默认值） ----
			const size = (config && config.size) || 260;             // 显示尺寸（px）
			const corner = (config && config.position) || 'bottom-right'; // 默认角落

			// ---- React 状态 ----
			const [anim, setAnim] = useState(IDLE);   // 当前动画名
			const [once, setOnce] = useState(true);   // 是否一次性播放——链式模型全部一次性
			const [facing, setFacing] = useState('left'); // 朝向：left | right
			const [dragging, setDragging] = useState(false); // 是否正在拖拽
			// 自定义位置（拖拽/移动后宠物停留的视口坐标）；null = 回到默认角落
			const [customPos, setCustomPos] = useState(null);
			// 播放序号：每次切换 +1。即使连续选中同一个动画（如待机播完又选待机），
			// seq 变化也能保证 switchTo 重新执行、视频重新播放（否则 anim 没变 React 不重渲染）。
			const [seq, setSeq] = useState(0);
			// ---- DOM 引用 ----
			const rootRef = useRef(null);  // 根容器（fixed 定位）
			const stageRef = useRef(null); // 内部舞台（落地对齐）
			// ---- 视频槽池（预加载）相关 ref ----
			// 思路：不再用固定 A/B 两个 video，而是维护一个"视频槽池"。每个槽承载一个
			// 已解码的动画；切换动画就是"把承载该动画的槽淡入"，无需重新解码。
			// 池里常驻预加载：待机(IDLE)、拖拽(DRAG)、预抽的下一个动作(next)、预抽的
			// 点击回应(click)，再加上当前播放 + 正在淡出的旧画面，8 个槽足够且有余量。
			const POOL_SIZE = 8;           // 视频槽数量
			const videoRefs = useRef(null); // 槽 DOM 引用数组（惰性创建，稳定引用避免 React 反复回调）
			if (videoRefs.current === null) {
				videoRefs.current = Array.from({ length: POOL_SIZE }, () => ({ current: null }));
			}
			const slotAnim = useRef(new Array(POOL_SIZE).fill(null)); // 每个槽当前承载的动画名（null=空）
			const slotRecency = useRef(new Array(POOL_SIZE).fill(0)); // 每槽最近使用计数（LRU 淘汰用）
			const tickRef = useRef(0);     // 使用计数递增器
			const frontSlot = useRef(-1);  // 当前显示（is-front）的槽索引；-1=尚无
			const genRef = useRef(0);      // 切换代数：每次切换 +1，用于识别"过期回调"
			// ---- 预抽（提前随机）相关 ref ----
			const nextActionRef = useRef(null);  // 预抽的"正常下一个动作"
			const clickActionRef = useRef(null); // 预抽的"点击回应动作"
			// ---- 交互相关 ref ----
			const dragRef = useRef({ active: false, dragging: false, sx: 0, sy: 0 }); // 拖拽状态
			const justDraggedRef = useRef(false); // 刚拖拽完（用于抑制拖拽后的误点击）
			const animRef = useRef(IDLE); // 动画名镜像（供异步回调读当前值）
			animRef.current = anim;

			// 读取槽元素
			const elOf = (i) => (videoRefs.current[i] ? videoRefs.current[i].current : null);
			// 更新某槽的最近使用计数
			const touch = (i) => { slotRecency.current[i] = ++tickRef.current; };
			// 常驻预加载的动画集合：待机 + 拖拽 + 预抽的下一个 + 预抽的点击
			const pinnedAnims = () => new Set([IDLE, DRAG, nextActionRef.current, clickActionRef.current].filter(Boolean));

			// ============================================================================
			// 视频槽池切换（switchTo）—— 核心播放逻辑（预加载版）
			// ============================================================================
			// 思路：维护一个"视频槽池"（POOL_SIZE 个 <video>）。每个槽承载一个已解码的
			// 动画。切换动画时：
			//   1. 若目标动画已在某个槽里（预加载命中），直接用它
			//   2. 否则取一个空闲/可淘汰槽，加载目标动画
			//   3. 等它的第一帧真正渲染上屏（requestVideoFrameCallback，兜底 loadeddata）
			//   4. 新槽淡入（加 is-front），旧槽淡出（去 is-front）
			// 常驻预加载（待机/拖拽/预抽的下一个/预抽的点击）始终留在池里，因此这些
			// 高频切换都是"秒切"，不会重新解码，也不会闪空白。
			//
			// 竞态防护（重要）：每个切换有一个递增的"代数" gen，就绪回调执行时检查
			// 自己是否还是最新代——不是就放弃（避免多个 video 都被移除 is-front 而
			// 全部透明、宠物消失）。
			const switchTo = (next, nextOnce) => {
				if (!next) return;
				const gen = ++genRef.current; // 本次切换的代数
				let slot = slotAnim.current.indexOf(next);
				if (slot === -1) {
					// 未预加载：取一个槽加载
					slot = acquireSlot();
					if (slot === -1) return;
					loadIntoSlot(slot, next);
				}
				playSlot(slot, gen, nextOnce);
			};

			// 把一个槽设为当前显示（交叉淡入），并把它正在播放的动画作为新前台。
			const crossfadeTo = (slot, gen) => {
				if (gen !== genRef.current) return; // 过期：期间又有更新的切换
				const el = elOf(slot);
				if (!el) return;
				const old = frontSlot.current;
				el.classList.add('is-front');
				const oldEl = old >= 0 ? elOf(old) : null;
				if (oldEl && old !== slot) {
					oldEl.classList.remove('is-front');
					// 停掉旧画面并摘除其 ended 回调：否则它会在后台继续播放、播完触发
					// handleEnded，从而打断刚切进来的新动画（槽池下可能有多个旧画面）。
					oldEl.pause();
					oldEl.onended = null;
				}
				frontSlot.current = slot;
				touch(slot);
				// 如果这是"计划中的移动"的动画，现在动画就绪了，开始驱动位置移动
				if (pendingMoveRef.current) startMoveDrive(el);
			};

			// 从某个槽开始播放动画（等待其第一帧真正上屏后交叉淡入）。
			const playSlot = (slot, gen, nextOnce) => {
				const el = elOf(slot);
				if (!el) return;
				el.loop = !nextOnce;               // 一次性动画不循环
				el.onended = nextOnce ? handleEnded : null; // 一次性动画播完 → 回待机
				el.muted = true;                   // 静音（动画无声音）
				el.playsInline = true;             // 行内播放（移动端不弹全屏）
				el.currentTime = 0;                // 回到动画开头
				el.play().catch(() => {});         // 先起播（muted autoplay 通常立即成功）
				waitFirstFrame(el, () => crossfadeTo(slot, gen));
			};

			// 等待一个 video 的第一帧真正渲染上屏后再执行 cb（避免淡入空白帧）。
			const waitFirstFrame = (el, cb) => {
				let done = false;
				let dataReady = false;
				const onData = () => { dataReady = true; };
				const finish = () => {
					if (done) return;
					done = true;
					el.removeEventListener('loadeddata', onData); // 防止复用槽时监听器堆积
					cb();
				};
				if (typeof el.requestVideoFrameCallback === 'function') {
					// requestVideoFrameCallback 在"新内容第一帧真正上屏"后触发，
					// 比 loadeddata 更晚、更可靠，能确保淡入时不露空白。
					el.requestVideoFrameCallback(finish);
					el.addEventListener('loadeddata', onData);
					// 兜底：数据已就绪但 rVFC 迟迟未触发（后台标签页/自动播放被拦）时，
					// 1 秒后强制切换——帧已解码，最多只差一两帧，无肉眼可见的闪烁。
					setTimeout(() => { if (dataReady) finish(); }, 1000);
				} else {
					// 旧浏览器无 rVFC：退回到 loadeddata 触发
					const onReady = () => { el.removeEventListener('loadeddata', onReady); finish(); };
					el.addEventListener('loadeddata', onReady);
					if (el.readyState >= 2) onReady(); // 已缓存就绪则立即切换
				}
			};

			// 把动画 `anim` 加载进槽 `slot`（只解码，不播放、不置前）。
			const loadIntoSlot = (slot, anim) => {
				const el = elOf(slot);
				if (!el) return;
				slotAnim.current[slot] = anim;
				touch(slot);
				el.src = '/pet/thumb/' + encodeURIComponent(anim) + '.webm';
				el.preload = 'auto';
				el.muted = true;
				el.playsInline = true;
				el.load();
			};

			// 取一个可用于加载"新动画"的槽：优先空槽；否则淘汰非保护、非前台的
			// 最久未用槽。`protectAnims` 是"即将播放、不能淘汰"的动画名。
			const acquireSlot = (protectAnims) => {
				const protect = new Set(protectAnims || []);
				// 1. 空槽（且不是当前前台）
				for (let i = 0; i < POOL_SIZE; i++) {
					if (i !== frontSlot.current && slotAnim.current[i] === null) return i;
				}
				// 2. 淘汰非保护、非前台的 LRU 槽
				let best = -1, bestRec = Infinity;
				for (let i = 0; i < POOL_SIZE; i++) {
					if (i === frontSlot.current) continue;
					const a = slotAnim.current[i];
					if (a === null) continue;
					if (protect.has(a) || pinnedAnims().has(a)) continue;
					if (slotRecency.current[i] < bestRec) { bestRec = slotRecency.current[i]; best = i; }
				}
				if (best !== -1) return best;
				// 3. 兜底：池已满，淘汰非前台的 LRU 槽（含保护项，极少发生）
				best = -1; bestRec = Infinity;
				for (let i = 0; i < POOL_SIZE; i++) {
					if (i === frontSlot.current) continue;
					if (slotRecency.current[i] < bestRec) { bestRec = slotRecency.current[i]; best = i; }
				}
				return best;
			};

			// 确保 `anim` 已解码进池（不播放）。`protectAnims` 传给 acquireSlot。
			const preload = (anim, protectAnims) => {
				if (!anim) return;
				if (slotAnim.current.indexOf(anim) !== -1) return; // 已在池中
				const slot = acquireSlot(protectAnims);
				if (slot === -1) return;
				loadIntoSlot(slot, anim);
			};

			// 刷新常驻预加载：待机 + 拖拽 + 预抽的下一个 + 预抽的点击。
			const refreshPreloads = (protectAnims) => {
				preload(IDLE, protectAnims);
				preload(DRAG, protectAnims);
				preload(nextActionRef.current, protectAnims);
				preload(clickActionRef.current, protectAnims);
			};

			// ============================================================================
			// 首次挂载：预抽下一个动作/点击动作，并预加载常驻动画
			// ============================================================================
			useEffect(() => {
				if (nextActionRef.current === null) nextActionRef.current = rollNextAction(IDLE);
				if (clickActionRef.current === null) clickActionRef.current = pick(CLICKS);
				refreshPreloads();
			}, []);

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
			// 动画链：预抽下一个动作（把随机提前）→ 播完再提交
			// ============================================================================
			// 链式模型（无常驻待机、无定时器）：
			//   每个动画（含待机呼吸休闲）都是一次性播放，播完 handleEnded 触发。
			//   概率：30% 待机 / 10% 转向 / 40% 动作 / 20% 移动。
			// 关键优化：不再"播完才随机"，而是当前动画播放期间就提前随机出"下一个
			// 动作"并预加载它，播完直接秒切，无重新解码、无闪烁。
			// `exclude`：排除刚结束的动画，避免连续重复（与原逻辑一致）。
			const rollNextAction = (exclude) => {
				const roll = Math.random();
				if (roll < 0.3) return IDLE;                // 30% 待机
				if (roll < 0.4) return TURN;                // 10% 转向
				if (roll < 0.8) return pick(ACTS, exclude); // 40% 随机动作（去重）
				return pick(MOVES);                         // 20% 移动（空间检查推迟到提交）
			};

			// 提交预抽的下一个动作：播放它，并立刻预抽 + 预加载"再下一个"。
			const advanceChain = () => {
				const next = nextActionRef.current;           // 预抽好的下一个（已预加载）
				nextActionRef.current = rollNextAction(next); // 预抽再下一个（排除即将播放的 next）
				refreshPreloads([next]);                      // 预加载再下一个，且保护 next 不被淘汰

				let toPlay = next;
				// 移动类动作：此刻才做空间检查（位置可能已变）；空间不够则回退随机动作
				if (MOVES.includes(toPlay) && !planMove()) {
					toPlay = pick(ACTS, animRef.current);
				}
				setOnce(true);        // 链式模型全部一次性
				setAnim(toPlay);
				setSeq((s) => s + 1); // 保证即使 anim 没变也重新播放
			};

			// 一次性动画播完的回调：决定下一个动画。
			// 拖拽中途不响应（让拖拽动画继续）。
			const handleEnded = () => {
				if (dragRef.current.active) return; // 拖拽中：不打断
				if (animRef.current === TURN) {
					// 东张西望播完 → 翻转朝向
					setFacing((f) => (f === 'left' ? 'right' : 'left'));
				}
				// 点击回应/拖拽动画（用户打断触发的）播完 → 先回待机缓冲
				if (animRef.current === DRAG || CLICKS.includes(animRef.current)) {
					setAnim(IDLE);
					setOnce(true);
					setSeq((s) => s + 1);
					return;
				}
				// 自主链动画播完 → 提交预抽好的下一个
				advanceChain();
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
				if (rootEl) return rootEl.getBoundingClientRect().left + size / 2;
				return window.innerWidth - 24 - size / 2;
			};
			// 当前宠物中心 y（视口坐标）
			const currentCenterY = () => {
				const cp = customPosRef.current;
				if (cp) return cp.ry * window.innerHeight;
				const rootEl = rootRef.current;
				if (rootEl) return rootEl.getBoundingClientRect().top + size / 2;
				return window.innerHeight - 20 - size / 2;
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
				const { startRatio, startYRatio, targetRatio, dir, totalRatio } = pm;
				// 动画时长驱动节奏（10.09s），取不到时兜底
				const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
				// 真正移动的窗口 = 总时长 - 前后 2s（至少 0.1s 防除零）
				// 命名注意：不能叫 window——会遮蔽全局 window，导致 window.innerWidth 变 undefined（历史 bug）
				const travelWindow = Math.max(0.1, duration - MOVE_LEAD_SEC - MOVE_TAIL_SEC);
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
						if (t <= MOVE_LEAD_SEC) {
							ratioX = startRatio; // 准备动作：原地
						} else if (t >= duration - MOVE_TAIL_SEC) {
							ratioX = targetRatio; // 收尾动作：已到终点
						} else {
							// 移动窗口：按进度插值（比例制）
							const progress = (t - MOVE_LEAD_SEC) / travelWindow;
							ratioX = startRatio + dir * totalRatio * progress;
						}
						const px = ratioX * W;
						const py = startYRatio * H;
						// 直接改 DOM style（不触发 React 重渲染，保证 60fps 平滑）
						rootEl.style.left = (px - size / 2) + 'px';
						rootEl.style.top = (py - size / 2) + 'px';
						rootEl.style.right = 'auto';
						rootEl.style.bottom = 'auto';
					}
					if (t < duration - MOVE_TAIL_SEC) {
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
			 * 计划一次移动（朝当前 facing 方向）。只做空间检查 + 记录计划；
			 * 真正的位置驱动等移动动画就绪后由 crossfadeTo 触发。
			 * @returns {boolean} true=移动已计划；false=空间不够（调用方回退随机动作）
			 */
			const planMove = () => {
				if (moveRef.current !== null || pendingMoveRef.current) return true; // 已在移动/已计划
				const dir = facingRef.current === 'right' ? 1 : -1; // 朝右=+1，朝左=-1
				const W = window.innerWidth;
				const cx = currentCenterX();
				const distance = randomBetween(MOVE_MIN_PX, MOVE_MAX_PX);
				const target = cx + dir * distance;
				// 【播放前检查一次距离】目标点必须在屏幕安全边距内，否则不移动
				const leftBound = MOVE_MARGIN + size / 2;
				const rightBound = W - MOVE_MARGIN - size / 2;
				if (target < leftBound || target > rightBound) return false; // 空间不够
				// 记录计划（存"比例"而非绝对坐标，resize 后仍正确）：
				// 起点比例、目标比例、Y 比例、方向、总距离比例
				pendingMoveRef.current = {
					startRatio: cx / W,
					startYRatio: currentCenterY() / window.innerHeight,
					targetRatio: target / W,
					dir,
					totalRatio: Math.abs(target - cx) / W,
				};
				// 移动动画一次性播放（10s），播完 ended 触发 handleEnded → 进入动画链
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

			// facing 的 ref 镜像（planMove 读取当前朝向）
			const facingRef = useRef(facing);
			facingRef.current = facing;

			// ============================================================================
			// 点击 vs 拖拽的区分
			// ============================================================================
			// 问题：按下+松开可能是一次"点击"，也可能是一次"拖拽"。
			// 方案：pointerdown 只记录起点；pointermove 超过 5px 才判定为拖拽
			// （播放拖拽动画并跟手）；松手时若没拖过，click 事件正常触发点击回应。
			const DRAG_THRESHOLD = 5; // 拖拽判定阈值（px）

			// 按下：只记录，不立即切动画
			const handlePointerDown = (e) => {
				stopMove(); // 用户交互打断正在进行的移动
				e.currentTarget.setPointerCapture(e.pointerId); // 捕获指针（拖出元素也能收到 move）
				dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY };
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
					setAnim(DRAG);
				}
				// 跟手：直接改 root 的 style（不触发 React 重渲染 → 60fps 平滑）
				const rootEl = rootRef.current;
				if (rootEl) {
					rootEl.style.left = (e.clientX - size / 2) + 'px';
					rootEl.style.top = (e.clientY - size / 2) + 'px';
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
				if (wasDragging) {
					// 抑制拖拽结束后的"幽灵点击"（浏览器在拖完也会发 click）
					justDraggedRef.current = true;
					setTimeout(() => { justDraggedRef.current = false; }, 100);
					setDragging(false);
					// 停在松手处（存相对窗口比例，窗口变化时位置跟随）
					setCustomPos({
						rx: e.clientX / window.innerWidth,
						ry: e.clientY / window.innerHeight,
					});
					const stageEl = stageRef.current;
					if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)'; // 恢复落地对齐
					setAnim(IDLE);
					setOnce(false);
				}
				// 没拖过：交给 handleClick
			};

			// ---- 点击回应（仅真点击触发，拖拽后的 click 被忽略） ----
			const handleClick = () => {
				const d = dragRef.current;
				if (d.active || d.dragging || justDraggedRef.current) return; // 拖拽中/刚拖完：忽略
				if (once && animRef.current !== IDLE) return; // 正在播一次性动画：不打断
				stopMove(); // 点击打断移动
				const playClick = clickActionRef.current;      // 预抽好的点击回应（已预加载）
				clickActionRef.current = pick(CLICKS);         // 立刻预抽下一次点击回应
				preload(clickActionRef.current, [playClick]);  // 预加载下一次，并保护本次即将播放的
				setOnce(true);
				setAnim(playClick); // 播放预加载好的点击回应
			};

			// ============================================================================
			// 渲染
			// ============================================================================
			// 落地对齐：视频是 360 画布、脚在 y=330，脚底距画布底 30px。
			// bottomPad = size × (360-330)/360，把舞台向下平移这么多，
			// 让"脚"正好落在视口底线上（宠物看起来站在地上而不是悬空）。
			const bottomPad = (size * (CANVAS_H - FEET_Y)) / CANVAS_H;
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
					const half = size / 2;
					const rx = customPos.rx;
					const ry = customPos.ry;
					const left = Math.min(Math.max(rx * window.innerWidth - half, 0), window.innerWidth - size);
					const top = Math.min(Math.max(ry * window.innerHeight - half, 0), window.innerHeight - size);
					return { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
				})()
				: {};

			// 视频共用的 props（事件绑定 + 基础属性）。不再设 autoPlay：
			// 播放由 playSlot 显式调用 el.play() 控制，预加载槽只解码不播放。
			const commonVideoProps = {
				muted: true,
				playsInline: true,
				preload: 'auto',
				onClick: handleClick,
				onPointerDown: handlePointerDown,
				onPointerMove: handlePointerMove,
				onPointerUp: handlePointerUp,
				onPointerCancel: handlePointerUp,
				title: 'dsh-pet',
			};

			// 渲染树：root > stage > [视频槽池 POOL_SIZE 个 video]
			// 槽之间层叠，只有一个槽带 is-front（显示）；其余隐藏/预加载。
			return h('div', {
				ref: rootRef,
				className: 'dsh-pet-root',
				'data-corner': corner,   // CSS 决定默认角落
				'data-facing': facing,   // CSS 决定是否镜像
				style: Object.assign({ '--dsh-pet-size': size + 'px' }, rootStyle),
				children: h('div', {
					ref: stageRef,
					className: 'dsh-pet-stage',
					style: stageStyle,
					children: Array.from({ length: POOL_SIZE }, (_, i) =>
						h('video', Object.assign({}, commonVideoProps, {
							key: 'v' + i,
							ref: videoRefs.current[i],
							className: 'dsh-pet-video',
						}))
					),
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
