'use strict';
/**
 * 桌面图标碰撞（实验性，仅 Windows，默认关闭：配置 physics.iconCollision = true 才启用）。
 *
 * 职责：读配置决定开不开 → 首次启用时用系统自带的 csc.exe 编译 icon-bridge.cs → 起 bridge 子进程 →
 * 把渲染端上报的宠物状态喂给 icon-world 的物理 → 把结果分两路发出去：
 *   - 图标位置 → bridge（按序号挪桌面图标，见 icon-bridge.cs 头部）；
 *   - 桌宠被撞后的新速度 → 该宠物窗口的 pet:hit（与跨窗宠物互撞同一条通道）；
 *   - 撞击音效/闪光 → 宠物窗口的 pet:icon-fx（icon-fx.js 渲染）。
 *
 * 安全边界：
 *   - 只改图标的显示位置，不碰文件；启动时把布局备份到 $DSH_HOME/dsh-pet/icon-collision/layout_backup.txt，
 *     托盘「还原桌面图标布局」或 helper 退出时自动还原（含被宿主硬杀：bridge 发现 stdin 关闭即自行还原并退出）；
 *   - 运行期间临时关闭桌面「自动排列」「对齐到网格」，退出时恢复；
 *   - 你在桌面上按住鼠标/重命名、桌面开着自动排列、前台在跑全屏程序时整体暂停。
 * 未启用时本模块什么都不做：不编译、不起子进程、不读写任何文件（只在启动时读一次配置）。
 * @module dsh-pet/runtime/electron-helper/main/icon-collision
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { IconWorld } = require('./icon-world.js');
const { dshHomeDir } = require('./user-data.js');

/** bridge 意外退出后最多重启几次。 */
const MAX_RESTARTS = 5;
/** 物理循环间隔（ms）：只在有图标在动时运行。 */
const TICK_MS = 8;

/**
 * 造图标碰撞能力。
 *
 * @param deps.hostRequest - 与宿主通信（读配置成品）。
 * @param deps.callbackUrl - bridge 模式的回调地址（就绪前发不出请求，与托盘同样先等它）。
 * @param deps.petRoute - 宠物路由前缀。
 * @param deps.petWindows - 窗口能力（state.windows：petId → BrowserWindow）。
 * @param deps.dpi - DPI 能力（forcedScale > 0 时主进程坐标即物理像素）。
 * @param deps.screen - Electron screen（DPI 没线性化时换算物理像素）。
 * @param deps.helperDir - runtime/electron-helper 的绝对目录（icon-bridge.cs 在这里）。
 * @param deps.onChange - 启用状态变化时回调（托盘刷新）。
 */
function createIconCollision({ hostRequest, callbackUrl, petRoute, petWindows, dpi, screen, helperDir, onChange }) {
  const log = (m) => console.error('[dsh-pet-desktop-helper] icon collision: ' + m);
  const dataDir = path.join(dshHomeDir(), 'dsh-pet', 'icon-collision');
  const t0 = process.hrtime.bigint();
  const now = () => Number(process.hrtime.bigint() - t0) / 1e9;

  let enabled = false;
  /** 配置要求开着（关掉之后 bridge 退出不再重启）。 */
  let wanted = false;
  let child = null;
  let stopping = false;
  let restarts = 0;
  let timer = null;
  /** petId → 物理像素 / 主进程坐标 */
  const petScale = new Map();

  const send = (line) => {
    if (child && child.stdin && child.stdin.writable) {
      try {
        child.stdin.write(line + '\n');
      } catch {
        // 子进程正在退出：丢掉这一条
      }
    }
  };

  /** 主进程坐标 → 物理像素（DPI 线性化生效时两者相同；没生效时按所在显示器换算）。 */
  const toPhys = (x, y) => {
    if (dpi.forcedScale > 0) return { x, y, s: 1 };
    try {
      const p = screen.dipToScreenPoint({ x, y });
      return { x: p.x, y: p.y, s: screen.getDisplayNearestPoint({ x, y }).scaleFactor || 1 };
    } catch {
      return { x, y, s: 1 };
    }
  };
  const fromPhys = (x, y) => {
    if (dpi.forcedScale > 0) return { x, y };
    try {
      return screen.screenToDipPoint({ x, y });
    } catch {
      return { x, y };
    }
  };

  const liveWindows = () => [...petWindows.state.windows.values()].filter((w) => w && !w.isDestroyed());

  const world = new IconWorld({
    now,
    move(list) {
      for (let k = 0; k < list.length; k += 192) send('M ' + list.slice(k, k + 192).join(' '));
    },
    petHit(petId, vx, vy) {
      const win = petWindows.state.windows.get(petId);
      const s = petScale.get(petId) || 1;
      if (win && !win.isDestroyed()) win.webContents.send('pet:hit', { vx: vx / s, vy: vy / s });
    },
    fx(payload) {
      const wins = liveWindows();
      if (!wins.length) return;
      if (payload.sound) {
        wins[0].webContents.send('pet:icon-fx', payload); // 声音只放一份
        return;
      }
      const pt = fromPhys(payload.x, payload.y);
      for (const w of wins) {
        const b = w.getContentBounds();
        if (pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height) {
          w.webContents.send('pet:icon-fx', {
            kind: payload.kind,
            strength: payload.strength,
            x: pt.x - b.x,
            y: pt.y - b.y,
          });
          return;
        }
      }
    },
    requestSnapshot: () => send('S'),
  });

  const ensureTimer = () => {
    if (timer) return;
    world.lastT = now(); // 从静止醒来：不能把空闲的这段时间当成一步积分
    timer = setInterval(() => {
      let moving = false;
      try {
        moving = world.tick();
      } catch (e) {
        log('tick error: ' + (e && e.stack ? e.stack : e));
      }
      if (!moving) {
        clearInterval(timer);
        timer = null;
      }
    }, TICK_MS);
  };

  // ── bridge：首次启用时用 Windows 自带的 csc.exe 编译；文件名带源码哈希，旧版被占用时照样能编新版 ──
  const findCsc = () => {
    const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    for (const fw of ['Framework64', 'Framework']) {
      const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
      if (fs.existsSync(p)) return p;
    }
    return null;
  };

  const compile = () =>
    new Promise((resolve) => {
      const src = path.join(helperDir, 'icon-bridge.cs');
      const binDir = path.join(dataDir, 'bin');
      let hash;
      try {
        fs.mkdirSync(binDir, { recursive: true });
        hash = crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 10);
      } catch (e) {
        log('prepare failed: ' + e.message);
        return resolve(null);
      }
      const exe = path.join(binDir, 'icon-bridge-' + hash + '.exe');
      try {
        for (const f of fs.readdirSync(binDir)) {
          if (/^icon-bridge-.*\.exe$/i.test(f) && path.join(binDir, f) !== exe) {
            try {
              fs.unlinkSync(path.join(binDir, f)); // 旧版本（正在运行的删不掉，忽略）
            } catch {
              // 被占用
            }
          }
        }
      } catch {
        // 目录读不到不影响编译
      }
      if (fs.existsSync(exe)) return resolve(exe);
      const csc = findCsc();
      if (!csc) {
        log('csc.exe not found (.NET Framework 4.x required); disabled');
        return resolve(null);
      }
      execFile(
        csc,
        [
          '/nologo',
          '/target:winexe',
          '/optimize+',
          '/codepage:65001',
          '/out:' + exe,
          '/r:System.Windows.Forms.dll',
          '/r:System.Drawing.dll',
          src,
        ],
        { windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            log('bridge compile failed: ' + String(stdout || '') + String(stderr || '') + err.message);
            return resolve(null);
          }
          log('bridge compiled: ' + exe);
          resolve(exe);
        },
      );
    });

  const onLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'icons':
        world.setIcons(msg);
        break;
      case 'busy':
        world.setBusy(msg.v);
        break;
      case 'blocked':
        world.setBlocked(msg.v);
        break;
      case 'fullscreen':
        world.setPaused(msg.v);
        break;
      case 'restored':
        log('layout restored: ' + msg.n);
        break;
      case 'err':
        log('bridge: ' + msg.m);
        break;
    }
  };

  const startChild = (exe) => {
    if (stopping || !wanted) return;
    const c = spawn(exe, [dataDir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = c;
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        if (line) onLine(line);
      }
    });
    c.stderr.on('data', (d) => log('bridge stderr: ' + String(d).trim()));
    c.stdin.on('error', () => {});
    c.on('error', (e) => log('bridge spawn error: ' + e.message));
    c.on('exit', (code) => {
      if (child === c) child = null;
      if (stopping || !wanted) return;
      log('bridge exited: ' + code);
      if (restarts++ < MAX_RESTARTS) setTimeout(() => startChild(exe), 3000);
    });
    send('E 1'); // 退出时自动还原布局
  };

  /** 读配置成品里的 physics（main 条目，与渲染端 renderer.js 的 loadConfig 同一份）。 */
  async function readPhysics() {
    const resp = await hostRequest('GET', petRoute + '/config');
    const merged = JSON.parse(resp.body || '{}');
    return (merged && merged.main && merged.main.physics) || null;
  }

  /** 让 bridge 还原布局与桌面设置后退出（stdin 关闭时它也会这么做，双保险）。 */
  const quitChild = () => {
    if (timer) clearInterval(timer);
    timer = null;
    send('Q');
    try {
      if (child && child.stdin) child.stdin.end();
    } catch {
      // 已经退出
    }
  };

  /** 按配置开 / 关：开着且配置关了 → 还原后停掉 bridge；没开且配置开了 → 编译并启动。 */
  async function apply() {
    if (process.platform !== 'win32' || stopping) return;
    for (let i = 0; callbackUrl && !callbackUrl() && i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    let physics = null;
    try {
      physics = await readPhysics();
    } catch (e) {
      log('config read failed: ' + String(e && e.message ? e.message : e));
      return;
    }
    const want = !!physics && physics.iconCollision === true;
    if (!want) {
      wanted = false;
      if (enabled) {
        enabled = false;
        world.stopAll();
        quitChild();
        if (onChange) onChange();
      }
      return;
    }
    world.setRestitution(physics.restitution);
    if (wanted) return; // 已经开着（或正在编译）
    wanted = true;
    const exe = await compile();
    if (!exe || stopping || !wanted) {
      if (!exe) wanted = false;
      return;
    }
    enabled = true;
    restarts = 0;
    startChild(exe);
    if (onChange) onChange();
  }

  return {
    /** 启动时读配置；启用时编译并启动 bridge。双进程模式下设置页保存会重启 helper，启动时读一次就够。 */
    start: apply,
    /** 同进程应用模式没有「重启 helper」：重建窗口时重读配置，按需开 / 关。 */
    reload: apply,
    get enabled() {
      return enabled;
    },
    /**
     * 渲染端每帧的宠物状态（主进程坐标）：bx/by = 包围盒左上角的屏幕坐标。
     * flying = 飞行中；held = 被拖着 / 正用着输入（菜单、对话框）。
     */
    updatePet(petId, s) {
      if (!enabled) return;
      const a = toPhys(s.bx, s.by);
      petScale.set(petId, a.s);
      world.updatePet(petId, {
        bx: a.x,
        by: a.y,
        size: s.size * a.s,
        bottomPad: s.bottomPad * a.s,
        vx: s.vx * a.s,
        vy: s.vy * a.s,
        flying: s.flying,
        held: s.held,
      });
      if (world.anyMoving()) ensureTimer();
    },
    removePet(petId) {
      world.removePet(petId);
      petScale.delete(petId);
    },
    /** 把图标放回启用时备份的布局。 */
    restore() {
      if (!enabled) return;
      world.stopAll();
      send('R');
    },
    /** 托盘菜单项：只在启用时出现。 */
    menuItems() {
      return enabled ? [{ label: '还原桌面图标布局', click: () => this.restore() }] : [];
    },
    stop() {
      stopping = true;
      quitChild();
    },
  };
}

module.exports = { createIconCollision };
