/**
 * 桌面 Helper 渲染端入口：配置加载、错误处理、启动装配与素材注入。
 * 依赖链（index.html 顺序加载）：shared-core.js → constants.js → sprite.js → events.js → 本文件。
 * 配置唯一来源是宿主 /config 的成品聚合（一步 fetch → S.flattenConfigPets 拍平），失败大声报错并每 5s
 * 重试，没有静默兜底。窗口 = 宠物包围盒 + 四周外扩余量，宠物移动由本页逐帧上报给主进程。
 * 不实现宠物行为与系统通知（见 sprite.js）。
 * @module dsh-pet/runtime/electron-helper/renderer
 */
'use strict';

// 配置（大声报错；失败 5s 重试）
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
 * 连续启动失败次数（成功一次即清零）。首次失败多半是启动竞态：主进程不等 bridge 回调服务就绪
 * 就建窗，首帧 fetch 会打空；5s 重试就自愈，不该闪红条。持续失败才是真配置错误，照旧大声报。
 */
let bootFailures = 0;

async function loadConfig() {
  // 唯一配置入口：宿主 /config 的成品聚合（已合并并保证绝对正确），一步拉取 → 拍平，零校验零兜底
  const res = await fetch(BASE + '/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config http ${res.status}`);
  const merged = await res.json();
  // 接口统一 200 + 实体：失败时状态码仍是 200，得看体里的 ok。
  if (merged && merged.ok === false) throw new Error('config ' + String(merged.reason ?? 'failed'));
  return {
    pets: S.flattenConfigPets(merged),
    // 拖拽抛掷物理参数（顶层全局，所有宠物共用；合并器已填内置默认）
    physics: (merged && merged.main && merged.main.physics) || S.DEFAULT_PHYSICS,
    // 抛掷锁定在当前屏幕（根字段；合并器已填内置默认 false）
    confineToScreen: (merged && merged.main && merged.main.confineToScreen) === true,
    // 点击音效开关（全局一份，只读 main 条目；合并器已填内置默认 false = 静音）
    clickSoundEnabled: (merged && merged.main && merged.main.clickSoundEnabled) === true,
    // 字体（全局一份，合并器已填内置默认）：字体族在此注入全局变量，字号由每只宠物按自己的尺寸算
    font: (merged && merged.main && merged.main.font) || S.DEFAULT_FONT,
    // 语音：音色与总开关（缺省 = 不播，与网页端同一口径）
    voiceName: (merged && merged.main && merged.main.voiceName) || '',
    voiceEnabled: (merged && merged.main && merged.main.voiceEnabled) === true,
  };
}

// 启动（配置校验通过才建 sprite；失败大声报错 + 5s 自动重试）
async function boot() {
  try {
    const cfg = await loadConfig();
    config = cfg;
    // 语音：本窗口固定是桌面端；音色与总开关直接取成品配置，不走懒加载——
    // 懒加载要等第一次播放才去拉 /config，撞上 bridge 起步竞态就永远读不到开关（读失败只试一次）。
    S.setVoiceBase(BASE);
    S.setSurface('desktop');
    S.setVoiceConfig(cfg.voiceName, cfg.voiceEnabled);
    bootFailures = 0;
    hideError();
    // 字体族进 documentElement：对话窗/得分弹窗挂在 body 下、继承不到宠物根容器，只能走全局变量。
    // 必须等 /config 拉回来之后才设（字体族来自配置）。
    document.documentElement.style.setProperty('--dsh-pet-font-family', S.fontStackOf(cfg.font.family));
    const pets = cfg.pets.filter((p) => S.isDesktopVisible(p.display));
    if (pets.length === 0) {
      // 全部宠物只在网页显示是合法状态，不是配置错误：没有桌面宠物就表示本窗口没活儿干，
      // 安静关掉、不弹条、不重试。托盘是否还在看 main 条目的 trayEnabled，与这里无关。
      // 宿主流由 syncDesktop() 在配置变化时重建 Helper；手动流需自行重启。
      hideError();
      console.info('[dsh-pet] no desktop pets; closing this helper window (tray kept only if trayEnabled)');
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

// 注入打字资源：气泡字体 + 点击/拖拽光标图标（与浏览器同一套素材，host 经 /dsh-pet-7340/ 提供）
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
  // 悬浮提示样式（与浏览器注入同一份 TOOLTIP_CSS，取代命中层上的原生 title 提示）
  const tipStyle = document.createElement('style');
  tipStyle.textContent = S.TOOLTIP_CSS;
  document.head.appendChild(tipStyle);
}

// 显示器几何变化（改分辨率/缩放、插拔屏、旋转）：主进程重算后推来，渲染端就地重挂视口与边界。
if (window.petBridge && window.petBridge.onDisplays) {
  window.petBridge.onDisplays((geo) => {
    // 变化前的视口原点必须在 applyDeskGeometry 之前取：relayout 靠它把旧视口相对坐标还原成
    // 世界坐标，否则合盖/开盖时视口原点一平移，宠物就会被误判越界。
    const prevView = { x: VIEW.x, y: VIEW.y, w: VIEW.w, h: VIEW.h };
    if (!applyDeskGeometry(geo)) return;
    for (const s of sprites) s.relayout(prevView);
  });
}

// 窗口内容区尺寸异常时按当前位置重新规整。
// 守卫：拖拽/飞行/漫游中绝不重设位置——这三种状态下位置由输入或物理驱动，而 position() 会把
// 宠物拉回 customPos。跨屏时 Windows 会因 WM_DPICHANGED 主动改窗口尺寸，不设防就会看到宠物跳回上一个落点。
window.addEventListener('resize', () => {
  for (const s of sprites) {
    if (s.dragState.active || s.throwRef !== null || s.moveRef !== null) continue;
    s.position();
  }
});

injectAssets();
void boot();
