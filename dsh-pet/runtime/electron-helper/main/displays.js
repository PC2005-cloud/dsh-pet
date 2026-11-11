'use strict';
/**
 * 显示器热更新与主屏缩放校对：分辨率、缩放、插拔与旋转都会让桌面几何失效，这里重算并推给所有窗口。
 *
 * 事件会连发，去抖后只重算一次。线性化生效时 screen API 只报被强制的值，真实主屏缩放得另起子
 * 进程问；缓存里是旧值时窗口会按错误倍数建出来，所以建窗后自查一次，不一致就纠正并重建窗口。
 * @module dsh-pet/runtime/electron-helper/main/displays
 */

/** 建窗后多久自查主屏缩放（毫秒）：留出首帧与动画起步，异步探测本身还要 0.3–0.6 秒 */
const SCALE_VERIFY_DELAY_MS = 1500;
/** 显示器事件后多久自查（毫秒）：一次改动能来好几条事件，等拓扑稳定再问 */
const SCALE_VERIFY_EVENT_DELAY_MS = 1000;

/**
 * 订阅显示器变化并推送。
 *
 * @param deps.screen - Electron screen。
 * @param deps.petWindows - 窗口能力（几何、窗口表、任务栏）。
 * @param deps.dpi - DPI 能力（forcedScale / primaryScale / probePrimaryScaleAsync / setPrimaryScale）。
 * @returns 立即重算一次、去抖重算与缩放自查三个入口。
 */
function createDisplaySync({ screen, petWindows, dpi }) {
  /** 自查是否正在跑：探测期间又来一条事件时不再叠一条子进程 */
  let scaleVerifyInFlight = false;

  /**
   * 校对主屏缩放：与内存里的值不一致就回写缓存、更新倍数并重建窗口。
   *
   * 缓存写失败也照常重建——这次会话的尺寸应当是对的，只是下次冷启动仍会读回旧值。
   */
  const verifyPrimaryScale = () => {
    if (scaleVerifyInFlight || !(dpi.forcedScale > 0)) return;
    scaleVerifyInFlight = true;
    void dpi.probePrimaryScaleAsync().then((real) => {
      scaleVerifyInFlight = false;
      if (!(real > 0) || Math.abs(real - dpi.primaryScale) <= 1e-6) return;
      const previous = dpi.primaryScale;
      const written = dpi.writeCachedPrimaryScale(real);
      dpi.setPrimaryScale(real);
      petWindows.closeAll();
      petWindows.create();
      console.error(
        '[dsh-pet-desktop-helper] primary scaleFactor ' +
          previous +
          ' -> ' +
          real +
          '; rebuilt windows' +
          (written ? '' : '（写缓存失败，下次启动会再自查）'),
      );
    });
  };

  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效（原先只在建窗时经 query 注入
  // 一次，运行期永不更新）。这里重算并推给所有窗口，渲染端就地重挂。
  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = petWindows.geometry();
    petWindows.state.lastRequestedBounds.clear(); // 坐标系变了，去重缓存作废，下一帧必须真的重设一次
    for (const win of petWindows.state.windows.values()) {
      if (win.isDestroyed()) continue;
      // 显示器拓扑变化同样是任务栏按钮重建的时机
      petWindows.keepOffTaskbar(win);
      win.webContents.send('pet:displays', geo);
    }
    console.error('[dsh-pet-desktop-helper] displays changed: ' + JSON.stringify(geo));
    // 主屏缩放可能一起变了：交给同一套自查，不一致就重建窗口
    setTimeout(verifyPrimaryScale, SCALE_VERIFY_EVENT_DELAY_MS).unref?.();
  };
  /** 显示器事件会连发（一次改动能来好几条），去抖后只重算一次 */
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      pushDisplays();
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);

  // 缓存可能是上一次探测留下的旧值（串流 / 远程桌面改过缩放），不纠正就一直按错误倍数建窗
  setTimeout(verifyPrimaryScale, SCALE_VERIFY_DELAY_MS).unref?.();

  return { push: pushDisplays, schedule: scheduleDisplays, verifyPrimaryScale };
}

module.exports = { createDisplaySync };
