/**
 * dsh-pet desktop helper renderer —— 启动入口。
 *
 * 依赖链（index.html 顺序加载）：shared-core.js → constants.js → sprite.js →
 * events.js → renderer.js（本文件）。本文件只做：配置加载 / 错误处理 / 启动装配 / 素材注入。
 *
 * 与浏览器 overlay 严格对齐（宠物行为/文案完全一致）：
 *   - 纯逻辑（常量/选择器/移动几何/余额折算/拍平）来自 shared-core.js
 *     （= src/shared 的构建产物，window.PetShared）——与浏览器 bundle 共用同一份源码；
 *   - 配置唯一来源 = 宿主 /dsh-pet-7340/config 的**成品聚合**（host readAllConfig 合并，
 *     绝对正确、字段填满）：一步 fetch → S.flattenConfigPets 拍平，加载失败**大声报错**
 *     并显示红色错误条（每 5s 自动重试），绝无静默兜底池；
 *   - 动画素材经宿主 /dsh-pet-7340/thumb/<素材根>/<name>.<webm|mov>（素材根 = 条目 key；扩展名由共享常量 ANIMATION_EXT 决定）；
 *   - 几何模型：窗口 = 宠物包围盒 + 四周外扩余量（WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间）。
 *     sprite 固定在窗口内 (margin.l, margin.t) 处，宠物的"移动"由本页把目标屏幕位置
 *     逐帧上报（petBridge.setBounds）→ 主进程按 sprite 位置 + 外扩余量移动窗口；
 *     视口 = 全部显示器工作区外接矩形（workAreaX/Y/W/H 由主进程注入），漫游/抛掷/角落/位置换算
 *     都跨屏（#43，宠物可被甩/拖到其它显示器）；单显示器时即主屏工作区，行为不变。
 *     外扩区透明且点击穿透（只有身体命中区可交互），不挡下层应用。
 *   - 右键级联菜单（与浏览器共用同一份组件：树+渲染+样式来自 shared-core 的 menu 模块）：
 *     右键宠物弹出，桌面端工具根项「打开网站 / 打开 DeepSeek Harness（宿主是 DSH 桌面应用时的同一项）/ 查看余额 / 回到初始位置 / 重载配置」+ 动作点播；
 *     菜单开启期间整窗保持可交互（悬停菜单不触发穿透翻转），关闭/离开窗口即恢复穿透。
 *   - 系统通知不是宠物行为（浏览器半侧 notify.ts 负责），桌面端不重复实现。
 */
'use strict';

// ---------- 配置（大声报错；失败 5s 重试） ----------
function showError(message) {
  console.error('[dsh-pet] ' + message);
  window.__dshPetDebug.configOk = false;
  errorEl.textContent = 'dsh-pet 配置错误：' + message;
  errorEl.classList.add('visible');
}
function hideError() {
  errorEl.classList.remove('visible');
  errorEl.textContent = '';
}
function scheduleReboot() {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void boot();
  }, 5000);
}

/**
 * 连续启动失败次数（成功一次即清零）。
 * 首次失败多半是启动竞态：主进程 `void startTray()` / `createPetWindows()` 不等 bridge
 * 回调服务就绪（main.js 的 startBridgeCallback 未 await），渲染端首帧 fetch 会打空。
 * 这种失败 5s 重试就自愈，不该闪一条红条；持续失败才是真配置错误，照旧大声报。
 */
let bootFailures = 0;

async function loadConfig() {
  // 唯一配置入口：宿主 /config 的成品聚合（host readAllConfig 已合并并保证绝对正确），
  // 一步拉取 → 拍平成渲染列表，零校验零兜底
  const res = await fetch(BASE + '/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config http ${res.status}`);
  const merged = await res.json();
  return {
    pets: S.flattenConfigPets(merged),
    // 拖拽抛掷物理参数（顶层全局，所有宠物共用；合并器已填内置默认）
    physics: (merged && merged.main && merged.main.physics) || S.DEFAULT_PHYSICS,
    // 抛掷锁定在当前屏幕（根字段；合并器已填内置默认 false）
    confineToScreen: (merged && merged.main && merged.main.confineToScreen) === true,
    // 字体（全局一份，合并器已填内置默认）：字体族在此取一次、注入全局变量；字号由每只宠物
    // 按自己的尺寸算（见 PetSprite 注入的 --dsh-pet-font-bubble / --dsh-pet-font-tip）
    font: (merged && merged.main && merged.main.font) || S.DEFAULT_FONT,
  };
}

// ---------- 启动（配置校验通过才建 sprite；失败大声报错 + 5s 自动重试） ----------
async function boot() {
  try {
    const cfg = await loadConfig();
    config = cfg;
    bootFailures = 0;
    hideError();
    // 字体族（全局配置 font.family）→ documentElement：对话窗/得分弹窗挂在 body 下、继承不到
    // 宠物根容器，只能走全局变量；气泡与提示也一并从这里继承（与浏览器端同一套变量名）。
    // 放在这里而不是 injectAssets()：字体族来自配置，必须等 /config 拉回来之后才有效。
    document.documentElement.style.setProperty('--dsh-pet-font-family', S.fontStackOf(cfg.font.family));
    const pets = cfg.pets.filter((p) => S.isDesktopVisible(p.display));
    if (pets.length === 0) {
      // **全部宠物只在网页显示是合法状态，不是配置错误**（issue #130）。
      // 本窗口是主进程按 DSH_PET_PETS 建的：宿主流下窗口数与该列表必然一致
      // （全 web 时宿主传 []，main.js 建 0 个窗口，本函数根本不会跑）；
      // 只有手动 start-desktop（没有 DSH_PET_PETS）会回落出一只默认窗口而与配置脱钩。
      // 脱钩不该报错——没有桌面宠物就表示这个窗口没活儿干：安静关掉，不弹条、不重试。
      // 托盘会留着（startTray 只看配置里有没有宠物，与 display 无关）；宿主流由
      // syncDesktop() 在配置变化时重建 helper，手动流则需自行重启。
      hideError();
      console.info('[dsh-pet] no desktop pets; closing this helper window (tray stays)');
      window.close();
      return;
    }
    // 本窗口只承载一只宠物：petIndex 由主进程按 DSH_PET_PETS 顺序注入
    const pet = pets[CONFIG.petIndex];
    if (!pet) {
      showError('petIndex=' + CONFIG.petIndex + ' 超出桌面宠物列表（共 ' + pets.length + ' 只），本窗口不创建宠物');
      scheduleReboot();
      return;
    }
    for (const s of sprites) s.dispose();
    sprites = [new PetSprite(pet)];
    window.__dshPetDebug.configOk = true;
    window.__dshPetDebug.spriteCount = sprites.length;
    for (const s of sprites) s.playIdle();
    startLoops();
  } catch (e) {
    const msg = '配置加载失败：' + (e && e.message ? String(e.message) : String(e));
    // 首次失败先静默（多半是启动竞态，见 bootFailures 的说明），下一次 5s 重试仍失败才报。
    bootFailures += 1;
    if (bootFailures > 1) showError(msg);
    else console.error('[dsh-pet] ' + msg + ' (first boot, retrying)');
    scheduleReboot();
  }
}

// 注入打字资源：气泡字体 + 点击/拖拽光标图标（与浏览器 overlay 同一套素材，host 经 /dsh-pet-7340/ 提供）
function injectAssets() {
  const style = document.createElement('style');
  style.textContent =
    '@font-face{font-family:"ShangshouSoftCandy";src:url("' +
    BASE +
    '/font/' +
    encodeURIComponent('上首软糖体') +
    '.ttf") format("truetype");font-display:swap;font-weight:400}' +
    '.pet-hit{cursor:url("' +
    BASE +
    '/pic/cursor-grab.png") 16 16, grab}' +
    '.pet-hit.dragging{cursor:url("' +
    BASE +
    '/pic/cursor-grabbing.png") 16 16, grabbing}';
  document.head.appendChild(style);
  // 统一右键菜单样式（与浏览器注入同一份 MENU_CSS）
  const menuStyle = document.createElement('style');
  menuStyle.textContent = S.MENU_CSS;
  document.head.appendChild(menuStyle);
  // 悬浮提示样式（与浏览器注入同一份 TOOLTIP_CSS；替代原先挂在命中层 title 上的原生提示）
  const tipStyle = document.createElement('style');
  tipStyle.textContent = S.TOOLTIP_CSS;
  document.head.appendChild(tipStyle);
}

// 显示器几何变化（改分辨率/缩放、插拔屏、旋转）：主进程重算后推来，渲染端就地重挂视口与边界。
// 这条通道是必需的——桌面几何原先只在窗口创建时经 URL query 注入一次，运行期永不更新。
if (window.petBridge && window.petBridge.onDisplays) {
  window.petBridge.onDisplays((geo) => {
    if (!applyDeskGeometry(geo)) return;
    for (const s of sprites) s.relayout();
  });
}

// 窗口内容区尺寸异常时按当前位置重新规整。
// 守卫：拖拽/飞行/漫游中**绝不**重设位置——这三种状态下位置由输入或物理驱动，而 position()
// 会把宠物拉回 customPos（上一次的落点）。跨屏时 Windows 会因 WM_DPICHANGED 主动改窗口尺寸，
// 那正好落在拖拽/飞行过程中，不设防就会看到宠物瞬间跳回上一个落点。
window.addEventListener('resize', () => {
  for (const s of sprites) {
    if (s.dragState.active || s.throwRef !== null || s.moveRef !== null) continue;
    s.position();
  }
});

injectAssets();
void boot();
