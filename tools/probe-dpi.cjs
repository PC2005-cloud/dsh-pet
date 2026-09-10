/**
 * 多屏异构 DPI 探针：验证「同一 DIP 矩形，随窗口归属屏不同而映射到不同物理位置/尺寸」。
 *
 * 背景（Chromium ui/display/win/screen_win.cc）：
 *   ScreenWin::DIPToScreenRect(hwnd, dip) 用 **hwnd 当前所在屏** 的 (dipOrigin, pixelOrigin, scale)
 *   做仿射变换 —— origin 走 DIPToScreenPoint(dip.origin, thatDisplay)，size 走 dip.size × thatDisplay.scale。
 *   hwnd 归属由 MonitorFromWindow(MONITOR_DEFAULTTONEAREST) 按面积占比决定，骑缝时会翻转。
 *   两屏 scale 不同 ⇒ 翻转前后同一 DIP 值落到不同物理像素；scale 相同 ⇒ 两屏共用同一仿射变换，翻转无影响。
 *
 * 跑法（harness 自带 electron）：
 *   %APPDATA%\dsh-desktop-dev\harness\electron\electron.exe tools\probe-dpi.cjs
 *   %APPDATA%\dsh-desktop-dev\harness\electron\electron.exe tools\probe-dpi.cjs --force-device-scale-factor=1
 *
 * 判读：DELTA 段全为 0 = 该 DIP 值不受窗口归属影响（DPI 换算已线性化）；非 0 = 骑缝翻转会跳变，
 * 数值即跳变幅度（物理像素）。加 --force-device-scale-factor 后应全部归零。
 */
'use strict';
const { app, BrowserWindow, screen } = require('electron');

const forced = process.argv.find((a) => a.startsWith('--force-device-scale-factor='));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (r) => `${r.x},${r.y} ${r.width}×${r.height}`;

/** 把窗口挪到指定屏并等 Windows 处理完 WM_DPICHANGED / 归属更新 */
async function park(win, display) {
  const a = display.workArea;
  win.setContentBounds({ x: Math.round(a.x + 20), y: Math.round(a.y + 20), width: 200, height: 200 }, false);
  await sleep(250);
  return screen.getDisplayNearestPoint(win.getBounds()).id;
}

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays();
  console.log('=== DISPLAYS ===');
  for (const [i, d] of displays.entries()) {
    console.log(
      `  #${i} ${d.label} id=${d.id} scale=${d.scaleFactor} rot=${d.rotation}` +
        `  bounds=${fmt(d.bounds)}  workArea=${fmt(d.workArea)}`,
    );
  }
  console.log('forceDeviceScaleFactor =', forced || '(none)');
  // 全局线性化是否成立：DIP↔物理 是不是一个与「归属哪块屏」无关的单一仿射变换。
  // 充要条件是每块屏都满足 pixelOrigin == dipOrigin × scale（原点与缩放同源）。
  // dipToScreenRect(null, r) 让 Chromium 自己按矩形位置挑屏，与逐屏推算对照即可看出偏移。
  console.log('\n=== 逐屏仿射一致性（dipOrigin×scale vs 实际 pixelOrigin） ===');
  for (const [i, d] of displays.entries()) {
    const oneDip = { x: d.bounds.x, y: d.bounds.y, width: 10, height: 10 };
    const phys = screen.dipToScreenRect(null, oneDip);
    console.log(
      `  #${i} dipOrigin=${d.bounds.x},${d.bounds.y} ×${d.scaleFactor} => 期望 ${d.bounds.x * d.scaleFactor},${
        d.bounds.y * d.scaleFactor
      }   实际 pixelOrigin=${phys.x},${phys.y}`,
    );
  }

  // 外接矩形 vs 工作区并集面积：P1 空洞占比
  const x0 = Math.min(...displays.map((d) => d.workArea.x));
  const y0 = Math.min(...displays.map((d) => d.workArea.y));
  const x1 = Math.max(...displays.map((d) => d.workArea.x + d.workArea.width));
  const y1 = Math.max(...displays.map((d) => d.workArea.y + d.workArea.height));
  const hullArea = (x1 - x0) * (y1 - y0);
  const sumArea = displays.reduce((s, d) => s + d.workArea.width * d.workArea.height, 0);
  console.log('\n=== HULL vs UNION ===');
  console.log(`hull = ${x0},${y0} ${x1 - x0}×${y1 - y0}  area=${hullArea}`);
  console.log(`sum(workArea) = ${sumArea}   hole = ${(((hullArea - sumArea) / hullArea) * 100).toFixed(1)}%`);

  const win = new BrowserWindow({
    width: 200,
    height: 200,
    show: true,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  await sleep(300);

  // 测试用 DIP 矩形：宠物窗口典型尺寸 924×600，取缝隙两侧 + 各屏深处
  const W = 924;
  const H = 600;
  // tag 必须带下标：同型号双屏 label 完全相同，用 label 做 key 会互相覆盖
  const probes = [];
  displays.forEach((d, i) => {
    const a = d.workArea;
    probes.push({ tag: `#${i} ${d.label}@origin`, x: a.x + 10, y: a.y + 10 });
    probes.push({
      tag: `#${i} ${d.label}@center`,
      x: Math.round(a.x + a.width / 2 - W / 2),
      y: Math.round(a.y + a.height / 2),
    });
    probes.push({ tag: `#${i} ${d.label}@far-edge`, x: Math.round(a.x + a.width - W - 10), y: Math.round(a.y + 10) });
  });

  const table = [];
  for (const [i, d] of displays.entries()) {
    const parkedOn = await park(win, d);
    const row = { parkedOn: `#${i} ${d.label}(id=${d.id}, scale=${d.scaleFactor})`, nearest: parkedOn, map: {} };
    for (const p of probes) {
      row.map[p.tag] = screen.dipToScreenRect(win, { x: p.x, y: p.y, width: W, height: H });
    }
    table.push(row);
  }

  console.log('\n=== DIP → PHYSICAL, 按窗口停放屏分组 ===');
  console.log(`测试矩形 DIP 尺寸 = ${W}×${H}`);
  for (const row of table) {
    console.log(`\n-- 窗口停在 ${row.parkedOn} --`);
    for (const [tag, r] of Object.entries(row.map)) console.log(`   ${tag.padEnd(28)} → ${fmt(r)}`);
  }

  if (table.length >= 2) {
    console.log('\n=== DELTA（第 2 组 − 第 1 组；全 0 = 与窗口归属无关） ===');
    const a = table[0].map;
    const b = table[1].map;
    for (const tag of Object.keys(a)) {
      const d = {
        dx: b[tag].x - a[tag].x,
        dy: b[tag].y - a[tag].y,
        dw: b[tag].width - a[tag].width,
        dh: b[tag].height - a[tag].height,
      };
      const flag = d.dx || d.dy || d.dw || d.dh ? '  <-- 跳变' : '';
      console.log(`   ${tag.padEnd(28)} dx=${d.dx} dy=${d.dy} dw=${d.dw} dh=${d.dh}${flag}`);
    }
  }

  // setContentBounds 往返：设 DIP → 读回 DIP，看主进程「回读去重」为何永远不相等
  console.log('\n=== setContentBounds 往返（读回 ≠ 设定 ⇒ 回读去重必然每帧重设） ===');
  for (const d of displays) {
    const a = d.workArea;
    const target = { x: Math.round(a.x + a.width / 2 - W / 2), y: Math.round(a.y + 100), width: W, height: H };
    win.setContentBounds(target, false);
    await sleep(250);
    const back = win.getContentBounds();
    const same = target.x === back.x && target.y === back.y && target.width === back.width && target.height === back.height;
    console.log(`   ${d.label}(scale=${d.scaleFactor}): set ${fmt(target)} → get ${fmt(back)}  ${same ? 'equal' : 'DIFF'}`);
  }

  win.destroy();
  app.exit(0);
});
