'use strict';
/**
 * DPI 与指针：主屏缩放的探测与缓存、强制缩放开关、渲染端 scale 换算、光标位置。
 *
 * 线性化必须赶在 ready 之前 appendSwitch，所以工厂在 main.js 顶层调用；探测子进程复用同一个
 * main.js（mainPath 传入），只打一行 scaleFactor 就退出。
 * @module dsh-pet/runtime/electron-helper/main-dpi
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { shouldLinearize, resolveForcedScale, resolvePetScale } = require('../dpi-linearization.js');

/**
 * 造 DPI/指针能力。
 *
 * @param deps.app - Electron app（userData 路径与命令行开关）。
 * @param deps.screen - Electron screen（主屏缩放与光标兜底）。
 * @param deps.mainPath - main.js 的绝对路径：探测子进程要重新拉起同一份脚本。
 * @param deps.linuxPointer - Linux 的 X11 指针提供者；其它平台传 null。
 * @param deps.dpiProbe - 本次是否是「只打印缩放」的探测子进程。
 * @param deps.dpiMark - 探测输出里的标记前缀。
 * @param deps.forceDsf - DSH_PET_FORCE_DSF 原始值（未设置即 undefined）。
 */
function createDpi({ app, screen, mainPath, linuxPointer, dpiProbe, dpiMark, forceDsf }) {
  /**
   * 当前光标位置（DIP）。
   * Linux：X11 QueryPointer 的实时值（物理像素 ÷ 缩放）；其余平台或查询尚未就绪：Electron 原生 API。
   */
  function currentPointer() {
    const raw = linuxPointer && linuxPointer.get();
    if (!raw) return screen.getCursorScreenPoint();
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    return scale === 1 ? raw : { x: Math.round(raw.x / scale), y: Math.round(raw.y / scale) };
  }

  /** 主屏缩放缓存文件（userData 在 ready 前即可用） */
  function dpiCacheFile() {
    return path.join(app.getPath('userData'), 'primary-scale.json');
  }

  function readCachedPrimaryScale() {
    try {
      const v = Number(JSON.parse(readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0; // 首次启动/文件损坏：当作无缓存，重新探测
    }
  }

  function writeCachedPrimaryScale(value) {
    try {
      writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: value }), 'utf8');
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] write dpi cache failed:', String(e && e.message ? e.message : e));
    }
  }

  /** 从探测子进程的输出里抓 scaleFactor（0 = 没抓到） */
  function parseProbeOutput(text) {
    const m = new RegExp(dpiMark + '([0-9.]+)').exec(String(text || ''));
    const v = m ? Number(m[1]) : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** 拉起探测子进程读主屏 scaleFactor（同一个 electron + 同一个 main.js，走 dpiProbe 分支） */
  function probePrimaryScale() {
    const opts = {
      env: { ...process.env, DSH_PET_DPI_PROBE: '1', DSH_PET_BRIDGE: '0', DSH_PET_SMOKE: '0' },
      timeout: 20000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    let out = '';
    try {
      out = execFileSync(process.execPath, [mainPath, '--dsh-pet-dpi-probe'], opts);
    } catch (e) {
      // 只认 stdout，不认退出码：不开窗口的 Electron 进程调 app.exit() 在 Windows 上偶发
      // 0xC0000005（退出期访问违例），但那时值早就写出来了，丢掉它纯属浪费一次冷启动。
      out = e && e.stdout ? String(e.stdout) : '';
      if (!parseProbeOutput(out)) {
        const detail = [
          e && e.status !== undefined ? 'status=' + e.status : '',
          e && e.stderr ? 'stderr=' + String(e.stderr).trim().slice(0, 300) : '',
        ]
          .filter(Boolean)
          .join(' ');
        console.error(
          '[dsh-pet-desktop-helper] dpi probe failed:',
          String(e && e.message ? e.message : e).split('\n')[0],
          detail,
        );
        return 0; // 探测失败：不加 switch，退回逐屏 DIP 行为
      }
    }
    const v = parseProbeOutput(out);
    if (v > 0) writeCachedPrimaryScale(v);
    return v;
  }

  /** 真实主屏 scaleFactor（探测所得；0 = 未知）。开启线性化后 screen API 只会报 1，只能靠它。 */
  let PRIMARY_SCALE = 0;
  /** 实际生效的强制缩放（0 = 未启用，坐标系维持修复前的逐屏 DIP） */
  let FORCED_SCALE = 0;
  if (shouldLinearize({ platform: process.platform, dpiProbe, forceDsf })) {
    // 探测失败只能退化为"不补偿"，不能把整个 helper 带走：受限令牌下
    // getPath('userData') 与探测子进程都可能失败，进程会在 ready 之前直接结束且无日志。
    try {
      PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
      const forced = resolveForcedScale({ forceDsf, primaryScale: PRIMARY_SCALE });
      if (forced > 0) {
        app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
        FORCED_SCALE = forced;
      }
    } catch (error) {
      console.error(
        '[dsh-pet-desktop-helper] dpi 探测失败，按不补偿继续:',
        String(error && error.message ? error.message : error),
      );
      PRIMARY_SCALE = 0;
      FORCED_SCALE = 0;
    }
  }

  /**
   * 渲染端的 CONFIG.scale：宿主给的基准 × 物理像素补偿。
   * 线性化开启后 1 逻辑像素 = 1 物理像素，宠物按主屏缩放放大回原来的观感。
   */
  function petScale() {
    return resolvePetScale({
      baseScale: process.env.DSH_PET_SCALE,
      primaryScale: PRIMARY_SCALE,
      forcedScale: FORCED_SCALE,
    });
  }

  return {
    currentPointer,
    petScale,
    probePrimaryScale,
    readCachedPrimaryScale,
    get primaryScale() {
      return PRIMARY_SCALE;
    },
    get forcedScale() {
      return FORCED_SCALE;
    },
  };
}

module.exports = { createDpi };
