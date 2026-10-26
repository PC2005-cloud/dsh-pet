/**
 * 窗口形状输入模型（Linux）的守卫测试。
 *
 * 背景：X11 上 `setIgnoreMouseEvents(false)` 走的是 `Mask(source_bitmap: None)`——用"空位图"当掩码，
 * 不是"移除形状"；而 Xwayland 的输入区域取自 ShapeInput（`xwl_window_set_input_region(...,
 * wInputShape(toplevel))`）。于是 ignore=true 设下的 1×1 输入形状清不干净，窗口永久穿透：
 * 宠物看得见、钉得稳，鼠标却全部落到下层应用（点不中、拖不动）。
 *
 * 修法：Linux 改用 `win.setShape(rects)`（Electron 文档：形状之外既不绘制也不接收鼠标），
 * 渲染端上报"宠物主体盒 + 覆盖层矩形"，主进程只负责应用。本文件钉住这条链路的两端。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 包内 helper 源码（Electron 起不来，只能读源码断言） */
const readHelper = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../runtime/electron-helper/${name}`, import.meta.url)), 'utf8');

describe('main.js —— 形状模型', () => {
  const main = readHelper('main.js');

  test('三种输入模型，Linux 默认 shape', () => {
    assert.ok(/const INPUT_MODE = /.test(main), '必须有 INPUT_MODE');
    assert.ok(/'shape'/.test(main) && /'ignore'/.test(main) && /'always'/.test(main), '三种取值都要有');
    assert.ok(
      /return process\.platform === 'linux' \? 'shape' : 'ignore';/.test(main),
      'Linux 默认 shape，其它平台保持 ignore（行为不变）',
    );
  });

  test('shape / always 模式下绝不调用 setIgnoreMouseEvents（那正是清不掉的 1×1 穿透）', () => {
    const fn = /function setWindowIgnore\(win, ignore\) \{([\s\S]*?)\n\}/.exec(main);
    assert.ok(fn, '找不到 setWindowIgnore');
    assert.ok(/if \(INPUT_MODE !== 'ignore'\) return;/.test(fn[1]), 'setWindowIgnore 必须在非 ignore 模式下提前返回');
    assert.ok(
      /win\.setIgnoreMouseEvents\(ignore, \{ forward: true \}\);/.test(fn[1]),
      'ignore 模式下仍要保留原实现（Windows/macOS 行为不变）',
    );
    // 镜像必须先写：轮询/冒烟断言都读它
    assert.ok(
      fn[1].indexOf('windowIgnore.set(win.id, ignore)') < fn[1].indexOf('setIgnoreMouseEvents'),
      '先记镜像再调系统 API',
    );
  });

  test('applyWindowShape：拒绝空列表（setShape([]) 会恢复矩形窗口，整窗吞点击）', () => {
    const fn = /function applyWindowShape\(win, rects\) \{([\s\S]*?)\n\}/.exec(main);
    assert.ok(fn, '找不到 applyWindowShape');
    assert.ok(/if \(clean\.length === 0\) return;/.test(fn[1]), '空列表必须被忽略');
    assert.ok(/win\.setShape\(clean\)/.test(fn[1]), '必须真的调用 setShape');
    assert.ok(/windowShapeKey\.get\(win\.id\) === key/.test(fn[1]), '相同形状不得重复发系统调用');
    assert.ok(/try \{/.test(fn[1]), 'setShape 抛错不得崩掉主进程');
  });

  test('建窗时先给临时形状，首帧上报后再换精确值', () => {
    assert.ok(/applyWindowShape\(win, initialShapeFor\(/.test(main), '建窗后必须立刻给一个临时形状');
    assert.ok(/windowShapeKey\.delete\(win\.id\)/.test(main), '窗口关闭时必须清掉形状缓存（防 id 复用串味）');
  });

  test('shape / always 模式下跳过光标轮询（形状已经决定了哪里接收鼠标）', () => {
    const poll = /const pointerTimer = setInterval\(\(\) => \{([\s\S]*?)\}, POINTER_POLL_MS\);/.exec(main);
    assert.ok(poll, '找不到兜底轮询体');
    assert.ok(
      /if \(INPUT_MODE !== 'ignore'\) return;/.test(poll[1]),
      '轮询必须在非 ignore 模式提前返回（否则会和形状抢着决定可交互）',
    );
    // 原有关键语义不能丢
    assert.ok(/decideWindowIgnore\(/.test(poll[1]), 'ignore 模式仍要走纯判定');
    assert.ok(/inputBusy\.get\(win\.id\) === true/.test(poll[1]), 'ignore 模式仍要把 busy 带进判定');
  });

  test('pet:shape IPC 接收渲染端上报的形状矩形', () => {
    assert.ok(/ipcMain\.on\('pet:shape'/.test(main), '必须有 pet:shape 通道');
    assert.ok(/applyWindowShape\(win, input\.rects\)/.test(main), '收到后必须应用');
  });
});

describe('preload.js —— 暴露 setShape（方法名与 IPC 频道必须与 sprite/main 一致）', () => {
  const preload = readHelper('preload.js');

  test('setShape 存在并转发到 pet:shape', () => {
    assert.ok(/setShape\(input\) \{/.test(preload), 'preload 必须有 setShape');
    assert.ok(/ipcRenderer\.send\('pet:shape', input\)/.test(preload), 'IPC 频道名必须是 pet:shape');
  });
});

describe('sprite.js —— 形状与动态余量', () => {
  const sprite = readHelper('sprite.js');

  test('syncShape 存在，且宠物本体用**主体盒**而不是 stage 的 DOM 矩形', () => {
    assert.ok(/syncShape\(\) \{/.test(sprite), '必须有 syncShape');
    assert.ok(
      /rects\.push\(\{\s*x: toScreen\(this\.margin\.l\),\s*y: toScreen\(this\.margin\.t\),\s*width: toScreen\(this\.body\.w\),\s*height: toScreen\(this\.body\.h\),\s*\}\)/.test(
        sprite,
      ),
      '本体矩形必须按主体盒算（stage 会以负偏移溢出窗口）',
    );
    assert.ok(/window\.petBridge\.setShape\(\{ rects \}\)/.test(sprite), '必须经 petBridge 上报');
    assert.ok(/if \(key === this\._shapeKey\) return;/.test(sprite), '相同形状不得逐帧刷 IPC');
  });

  test('拖拽中形状给整窗（否则滞后会把正在进行的拖拽切掉）', () => {
    assert.ok(
      /if \(this\.dragState\.active\) \{[\s\S]{0,400}?width: toScreen\(window\.innerWidth\), height: toScreen\(window\.innerHeight\)/.test(
        sprite,
      ),
      '拖拽中必须上报整窗形状',
    );
  });

  test('覆盖层（气泡/提示/菜单/对话/积分）都算进形状', () => {
    assert.ok(/\.dsh-pet-menu-column, \.dsh-pet-chat, \.dsh-pet-score/.test(sprite), '覆盖层选择器必须齐全');
    assert.ok(/this\.bubble\.classList\.contains\('is-on'\)/.test(sprite), '气泡要算进形状');
    assert.ok(/this\.tip\.classList\.contains\('is-on'\)/.test(sprite), '提示要算进形状');
  });

  test('动态余量：空闲贴边、有覆盖层才外扩，且一律夹进可用空间', () => {
    assert.ok(/const IDLE_MARGIN_PX = 4;/.test(sprite), '空闲余量必须是 4（窗口≈主体盒，宠物才能贴边）');
    assert.ok(/const MENU_ROOM_PX = /.test(sprite), '菜单态余量必须有命名常量（两层菜单并排）');
    assert.ok(/desiredMargin\(\) \{/.test(sprite), '必须有 desiredMargin');
    assert.ok(/clampMarginToSpace\(mg\) \{/.test(sprite), '必须有 clampMarginToSpace');
    // 三个分支（菜单/气泡/空闲）都要经过夹取
    const body = /desiredMargin\(\) \{([\s\S]*?)\n {2}\}/.exec(sprite);
    assert.ok(body, '找不到 desiredMargin 体');
    assert.ok(
      (body[1].match(/clampMarginToSpace\(/g) ?? []).length >= 2,
      '菜单与气泡两个外扩分支都必须夹取（否则 WM 钳回会让宠物跳走）',
    );
  });

  test('余量一变就重报窗口矩形（宽高与原点都由余量算出），且带递归刹车', () => {
    assert.ok(/syncMargin\(\) \{/.test(sprite), '必须有 syncMargin');
    assert.ok(/if \(!this\._marginBusy\) this\.syncMargin\(\);/.test(sprite), 'sendBounds 前要同步余量');
    assert.ok(/this\._marginBusy = true;/.test(sprite), '必须有递归刹车（sendBounds ↔ syncMargin）');
    assert.ok(/this\.el\.style\.left = next\.l - this\.body\.x \+ 'px';/.test(sprite), '画布按主体盒偏移摆放');
  });

  test('窗口矩形由 winRect() 统一给出（菜单/提示夹取不得再各自拼一套）', () => {
    assert.ok(/winRect\(\) \{/.test(sprite), '必须有 winRect');
    const calls = (sprite.match(/this\.winRect\(\)/g) ?? []).length;
    assert.ok(calls >= 3, `winRect 应被 sendBounds / visibleClampRect / renderTip 共用，实际 ${calls} 处`);
  });

  test('安全网：1.5s 兜底同步一次（覆盖层显隐路径多，逐个挂回调容易漏）', () => {
    assert.ok(/this\.shapeTimer = window\.setInterval\(/.test(sprite), '必须有形状安全网定时器');
    assert.ok(/window\.clearInterval\(this\.shapeTimer\)/.test(sprite), 'dispose 必须清理定时器');
  });
});

describe('sprite.js —— 拖拽位移与单位无关', () => {
  const sprite = readHelper('sprite.js');

  test('位移用「宠物自身位移 + client 增量」，不再用 e.screenX', () => {
    assert.ok(
      /const dx = this\.pos\.x - d\.petX \+ \(e\.clientX - d\.clientX\);/.test(sprite),
      '必须用与单位无关的恒等式',
    );
    assert.ok(/const dy = this\.pos\.y - d\.petY \+ \(e\.clientY - d\.clientY\);/.test(sprite), '纵向同理');
  });

  test('onPointerDown 记录 client 坐标（位移公式的另一半）', () => {
    assert.ok(/clientX: e\.clientX,\s*clientY: e\.clientY,/.test(sprite), 'dragState 必须带 client 起点');
  });

  test('轨迹采样与位移同一套 CSS 坐标（甩抛力度不被缩放带偏）', () => {
    assert.ok(
      /this\.dragTrail\.push\(\{ t: now, x: d\.petX \+ dx, y: d\.petY \+ dy \}\)/.test(sprite),
      '轨迹必须用 CSS 坐标',
    );
  });
});
