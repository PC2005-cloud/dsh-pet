/**
 * 桌面 helper「点击穿透兜底通道」的判定测试（采纳 issue #55 报告者的补丁）。
 *
 * 背景：窗口默认整窗点击穿透，只靠 Electron 的 forward 低级鼠标钩子把 mousemove 转发进渲染端做命中
 * 判定——**整条链路只有一个入口**。该钩子在 Windows 上会静默失效（回调超时被系统摘掉 / 被别的软件
 * 的钩子干扰），失效后没有任何退路：光标悬浮不触发手套光标、拖不动、点击与右键全无反应。
 * 报告者的修法：主进程按**真实光标位置**独立判定并翻转，不依赖那条转发链路。
 *
 * 本文件把三件事钉住：
 *   ① 判定规则（宠物身上=可交互；窗口余量区=**保持当前**，菜单/弹窗才点得到；窗外=穿透）；
 *   ② 几何：窗口矩形 → 宠物身体命中区（必须与渲染端 sprite.js 的命中判定同源，否则两条通道打架）；
 *   ③ 源码守卫：helper 的 main.js 里必须有兜底显示与兜底轮询（Electron 起不来，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const {
  HIT_BOX,
  CANVAS_H,
  STAGE_W,
  POINTER_POLL_MS,
  OFF_BODY_RELEASE_MS,
  spriteHitRect,
  pointerZone,
  decideWindowIgnore,
} = require(helper + 'pointer-target.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 真实窗口矩形（DIP）：宠物 size 462 → 窗口 = 462 + 两侧各 231 = 924；高度 = 画布 + bottomPad + 两侧余量 */
const bounds = { x: 1000, y: 500, width: 924, height: 743 };

describe('decideWindowIgnore —— 兜底通道的判定规则（issue #55 报告者实测表）', () => {
  test('光标在宠物身体上 → 不穿透（可交互）', () => {
    const r = spriteHitRect(bounds);
    const center = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    assert.equal(decideWindowIgnore(bounds, center, true), false);
    assert.equal(decideWindowIgnore(bounds, center, false), false);
  });

  test('窗口余量区保持当前状态：当前可交互则维持（自绘菜单/弹窗点得到）、当前穿透则维持穿透', () => {
    const margin = { x: bounds.x + 20, y: bounds.y + 20 }; // 窗口左上角余量区（宠物外）
    assert.equal(decideWindowIgnore(bounds, margin, false), false, '菜单打开时鼠标移到余量区不得翻回穿透');
    assert.equal(decideWindowIgnore(bounds, margin, true), true, '没交互时余量区必须保持穿透，不挡桌面图标');
  });

  test('余量区停留超时 → 恢复穿透；未到点仍保持当前状态', () => {
    const margin = { x: bounds.x + 20, y: bounds.y + 20 };
    assert.equal(
      decideWindowIgnore(bounds, margin, false, false, OFF_BODY_RELEASE_MS - 1),
      false,
      '未到点：保持可交互',
    );
    assert.equal(decideWindowIgnore(bounds, margin, false, false, OFF_BODY_RELEASE_MS), true, '到点：恢复穿透');
    assert.equal(decideWindowIgnore(bounds, margin, true, false, OFF_BODY_RELEASE_MS), true, '已穿透：维持穿透');
  });

  test('busy 仍优先于超时：租约期内不得因超时翻回穿透', () => {
    const margin = { x: bounds.x + 20, y: bounds.y + 20 };
    assert.equal(decideWindowIgnore(bounds, margin, false, true, OFF_BODY_RELEASE_MS * 100), false);
    assert.equal(decideWindowIgnore(bounds, margin, true, true, OFF_BODY_RELEASE_MS * 100), false);
  });

  test('超时不越界：身体上不因超时穿透，窗外不因零时长保持可交互', () => {
    const r = spriteHitRect(bounds);
    const center = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    assert.equal(decideWindowIgnore(bounds, center, false, false, OFF_BODY_RELEASE_MS * 100), false);
    assert.equal(decideWindowIgnore(bounds, { x: bounds.x - 1, y: bounds.y + 100 }, false, false, 0), true);
  });

  test('pointerZone：窗口分区的唯一来源', () => {
    const r = spriteHitRect(bounds);
    assert.equal(pointerZone(bounds, { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }), 'body');
    assert.equal(pointerZone(bounds, { x: bounds.x + 2, y: bounds.y + 2 }), 'margin');
    assert.equal(pointerZone(bounds, { x: bounds.x - 1, y: bounds.y + 100 }), 'outside');
  });

  test('余量区释放阈值是命名常量（400ms）', () => {
    assert.equal(OFF_BODY_RELEASE_MS, 400);
  });

  test('光标在窗口外 → 恢复穿透（四个方向）', () => {
    const cases = [
      { x: bounds.x - 1, y: bounds.y + 100 },
      { x: bounds.x + bounds.width, y: bounds.y + 100 },
      { x: bounds.x + 100, y: bounds.y - 1 },
      { x: bounds.x + 100, y: bounds.y + bounds.height },
    ];
    for (const p of cases) assert.equal(decideWindowIgnore(bounds, p, false), true, JSON.stringify(p));
  });

  test('边界取整：窗口左上角算窗口内、右下角算窗口外', () => {
    assert.equal(decideWindowIgnore(bounds, { x: bounds.x, y: bounds.y }, false), false);
    assert.equal(
      decideWindowIgnore(bounds, { x: bounds.x + bounds.width - 1, y: bounds.y + bounds.height - 1 }, false),
      false,
    );
  });

  test('窗口尺寸未落定（renderer 首帧上报前）不误判：极小矩形内不产生"可交互"', () => {
    const tiny = { x: 0, y: 0, width: 4, height: 4 };
    assert.equal(decideWindowIgnore(tiny, { x: 0, y: 0 }, true), true);
  });
});

describe('输入租约（busy）—— 0.2.10「甩快了即使没松手也会飞出去」的修复', () => {
  /** 拖拽中宠物滞后于光标：光标跑到窗口矩形外（甩得快时必然出现，滞后量 > 半只宠物） */
  const ahead = { x: bounds.x + bounds.width + 120, y: bounds.y + 300 };

  test('busy=false：位置规则原样生效（0.2.10 的判定不变）', () => {
    assert.equal(decideWindowIgnore(bounds, ahead, false, false), true, '窗外→穿透');
    assert.equal(
      decideWindowIgnore(bounds, { x: bounds.x + 20, y: bounds.y + 20 }, false, false),
      false,
      '余量区→保持当前（可交互）',
    );
    assert.equal(
      decideWindowIgnore(bounds, { x: bounds.x + 20, y: bounds.y + 20 }, true, false),
      true,
      '余量区→保持透视',
    );
  });

  test('busy=true：光标在窗口外也**不得**翻回穿透——这是本次回归的正面断言', () => {
    assert.equal(
      decideWindowIgnore(bounds, ahead, true, true),
      false,
      '这一拍翻回穿透，拖拽的 window 级事件链就断了：指针还按着，宠物却按旧速度飞出去',
    );
  });

  test('busy=true：无论光标在多远、当前是什么状态，一律保持可交互（位置完全不参与）', () => {
    const spots = [
      { x: bounds.x - 900, y: bounds.y - 900 },
      { x: bounds.x + bounds.width + 3000, y: bounds.y + 10 },
      { x: bounds.x + 20, y: bounds.y + 20 },
      { x: 0, y: 0 },
    ];
    for (const p of spots) {
      assert.equal(decideWindowIgnore(bounds, p, true, true), false, 'busy 时不得穿透 ' + JSON.stringify(p));
      assert.equal(decideWindowIgnore(bounds, p, false, true), false, 'busy 时不得穿透 ' + JSON.stringify(p));
    }
  });

  test('busy 是**否决权**：它压过位置判定（任何"离得近才算"的阈值都会重新引入滞后量条件）', () => {
    // 反证：即使光标离窗口十万八千里，busy 期间也只能是可交互
    const veryFar = { x: bounds.x + 99999, y: bounds.y };
    assert.equal(decideWindowIgnore(bounds, veryFar, true, true), false);
  });

  test('busy 释放后立刻回到位置规则（松手/关菜单/关弹窗都不留下粘性）', () => {
    assert.equal(decideWindowIgnore(bounds, ahead, false, true), false, 'busy 期间：可交互');
    assert.equal(decideWindowIgnore(bounds, ahead, false, false), true, 'busy 释放：同一位置立刻恢复穿透');
  });

  test('轮询间隔仍在（60ms，issue #55 报告者实测值）', () => {
    assert.equal(POINTER_POLL_MS, 60);
  });
});

describe('spriteHitRect —— 与渲染端命中判定同源（否则两条通道会互相翻回来）', () => {
  test('size 462 的真实窗口：命中区落在身体矩形内，且中心 = 窗口中心（真机实测一致）', () => {
    const r = spriteHitRect(bounds);
    // 窗口 = 画布 + 两侧各 margin(231)；画布 462×260，身体命中区取画布 640×360 的 200..440 / 50..335
    const margin = 231;
    const stageH = (462 * CANVAS_H) / STAGE_W;
    const near = (actual: number, expected: number) => Math.abs(actual - expected) < 0.01;
    assert.ok(near(r.left, bounds.x + margin + (200 / STAGE_W) * 462), 'left=' + r.left);
    assert.ok(near(r.right, bounds.x + margin + (440 / STAGE_W) * 462), 'right=' + r.right);
    assert.ok(near(r.top, bounds.y + margin + (50 / CANVAS_H) * stageH), 'top=' + r.top);
    assert.ok(near(r.bottom, bounds.y + margin + (335 / CANVAS_H) * stageH), 'bottom=' + r.bottom);
    // 命中区必须完全落在窗口内（否则永远不会触发 + 会误判窗外）
    assert.ok(r.left > bounds.x && r.right < bounds.x + bounds.width);
    assert.ok(r.top > bounds.y && r.bottom < bounds.y + bounds.height);
    // 与真机实测的落点一致：我把光标注入到窗口中心时，命中区中心正是窗口中心
    assert.ok(Math.abs((r.left + r.right) / 2 - (bounds.x + bounds.width / 2)) < 0.01);
  });

  test('命中区随窗口尺寸等比缩放（宠物放大/缩小后仍对得上）', () => {
    const small = { x: 0, y: 0, width: 600, height: 482 }; // size 300：300 + 两侧各 150
    const r = spriteHitRect(small);
    assert.ok(r.left > 150 && r.left < 300);
    assert.ok(r.right > 300 && r.right < 450);
  });
});

describe('源码守卫 —— helper 的两个兜底必须在位', () => {
  const main = readSource(helper + 'main.js');

  test('#55-1 兜底显示：ready-to-show 之外还要有"加载完成后仍未显示就 show"', () => {
    assert.ok(/once\('ready-to-show', \(\) => win\.show\(\)\)/.test(main), 'ready-to-show 的正常路径不能删');
    assert.ok(
      /once\('did-finish-load'/.test(main),
      '必须有 did-finish-load 兜底（paintWhenInitiallyHidden:false 时 ready-to-show 永不触发）',
    );
    assert.ok(
      /!win\.isDestroyed\(\) && !win\.isVisible\(\)\) win\.show\(\)/.test(main),
      '兜底必须在"仍未显示"时才 show',
    );
  });

  test('#55-2 兜底轮询：主进程按真实光标独立判定，且与渲染端通道共用同一出口', () => {
    assert.ok(/decideWindowIgnore\(/.test(main), '必须调用纯判定（不依赖 forward 鼠标钩子）');
    assert.ok(/screen\.getCursorScreenPoint\(\)/.test(main), '必须读真实光标位置');
    assert.ok(/POINTER_POLL_MS/.test(main), '轮询间隔必须是命名常量（60ms）');
    assert.ok(
      (main.match(/setWindowIgnore\(/g) ?? []).length >= 3,
      '所有翻转必须走 setWindowIgnore（创建 / IPC / 兜底轮询），镜像状态才不失步',
    );
    assert.ok(
      !/win\.setIgnoreMouseEvents\(/.test(main.replace(/function setWindowIgnore[\s\S]*?\n}/, '')),
      '不得再有绕过出口的直接调用',
    );
    assert.ok(/clearInterval\(pointerTimer\)/.test(main), '窗口关闭时必须停掉轮询');
  });

  test('输入租约闭环：渲染端上报 busy，主进程据此判定，且只走唯一出口', () => {
    assert.ok(/const inputBusy = new Map\(\)/.test(main), '必须有每窗口的 busy 标记表');
    assert.ok(/ipcMain\.on\('pet:input-busy'/.test(main), 'busy 上报必须被接收');
    // 兜底轮询必须把 busy 与余量区停留时长一起带进判定（按语义断言，不钉死调用行的字面量）
    const poll = /setInterval\(\(\) => \{([\s\S]*?)\}, POINTER_POLL_MS\);/.exec(main);
    assert.ok(poll, '找不到兜底轮询体');
    assert.ok(/decideWindowIgnore\(/.test(poll[1]), '轮询必须调用纯判定（不依赖 forward 鼠标钩子）');
    assert.ok(/inputBusy\.get\(win\.id\) === true/.test(poll[1]), '必须把 busy 带进判定');
    assert.ok(/offBodyMs\.get\(win\.id\)/.test(poll[1]), '必须把余量区停留时长带进判定');
    assert.ok(/inputBusy\.delete\(win\.id\)/.test(main), '窗口关闭时必须清掉 busy 标记（防 id 复用串味）');
    assert.ok(/offBodyMs\.delete\(win\.id\)/.test(main), '窗口关闭时必须清掉停留计时（防 id 复用串味）');
    // busy 只能经兜底轮询生效，不得在 IPC 里直接翻窗口——否则两条通道抢着翻同一个窗口
    assert.ok(
      !/ipcMain\.on\('pet:input-busy'[\s\S]{0,400}?setWindowIgnore\(/.test(main),
      'busy 处理器不得直接 setWindowIgnore（唯一出口在轮询里，按完整规则判定）',
    );
    assert.ok(/inputBusy\.set\(win\.id, !!busy\)/.test(main), 'busy 只做标记，由下一拍轮询统一决策');
  });
});

describe('守卫：主进程镜像的命中盒常量不得与 src/shared/constants.ts 漂移', () => {
  test('HIT_BOX / CANVAS_H 与 shared 常量一致，画布宽沿用同一约定（字面量 640）', () => {
    const shared = readSource('../shared/constants.ts');
    const num = (name: string): number => {
      const m = new RegExp(String.raw`export const ${name} = (\d+)`).exec(shared);
      assert.ok(m, 'shared 里找不到 ' + name);
      return Number(m[1]);
    };
    assert.equal(CANVAS_H, num('CANVAS_H'));
    const hit = /export const HIT_BOX = \{ x0: (\d+), y0: (\d+), x1: (\d+), y1: (\d+) \}/.exec(shared);
    assert.ok(hit, 'shared 里的 HIT_BOX 形状变了，请同步 pointer-target.js');
    assert.deepEqual(HIT_BOX, { x0: Number(hit[1]), y0: Number(hit[2]), x1: Number(hit[3]), y1: Number(hit[4]) });
    // 画布宽 shared 没有导出（各处都用字面量 640）：这里断言渲染端也是同一约定，避免我们把宽写成别的值
    assert.equal(STAGE_W, 640);
    assert.ok(
      /S\.HIT_BOX\.x0 \/ 640/.test(readSource(helper + 'sprite.js')),
      'sprite.js 的命中判定用 640 作画布宽——两边必须同一约定',
    );
  });
});

describe('守卫：渲染端的输入租约必须在位（helper 随包发行，只能读源码断言）', () => {
  const sprite = readSource(helper + 'sprite.js');

  test('租约来源必须**正好**是那三个"正在用窗口输入"的状态', () => {
    const m = /inputBusy\(\)\s*\{([\s\S]*?)\n {2}\}/.exec(sprite);
    assert.ok(m, 'sprite.js 里找不到 inputBusy()');
    const body = m[1];
    for (const flag of ['dragState.active', 'menuOpen', 'chatOpen']) {
      assert.ok(body.includes(flag), `租约必须包含 ${flag}`);
    }
  });

  test('建立点：拖拽成立 / 菜单开 / 弹窗开都上报', () => {
    // 拖拽：onPointerDown 里立刻上报（不等过阈值——按下瞬间窗口就已经必须保持可交互）
    assert.ok(
      /setPointerCapture[\s\S]{0,600}?this\.syncInputBusy\(\)/.test(sprite),
      'onPointerDown 必须在建立拖拽状态后上报 busy',
    );
    assert.ok(
      /d\.dragging = true;[\s\S]{0,400}?this\.syncInputBusy\(\)/.test(sprite),
      '真正开始拖拽时也要上报（此时可能尚未上报过）',
    );
    assert.ok(/this\.menuOpen = true;[\s\S]{0,300}?this\.syncInputBusy\(\)/.test(sprite), '菜单打开必须上报');
    assert.ok(/this\.chatOpen = true;[\s\S]{0,300}?this\.syncInputBusy\(\)/.test(sprite), '对话弹窗打开必须上报');
  });

  test('解除点：松手 / closeMenu / 菜单 onClose / 弹窗 onClose 每一处都上报', () => {
    assert.ok(/this\.syncInputBusy\(\)/.test(sprite), '必须存在上报方法');
    // 松手（onPointerUp）
    assert.ok(
      /onPointerUp\(e\) \{[\s\S]{0,400}?this\.syncInputBusy\(\)/.test(sprite),
      '松手/取消必须上报（否则窗口粘在可交互）',
    );
    // closeMenu 一处覆盖：菜单项的 onAction、mouseleave、destroy
    assert.ok(
      /closeMenu\(\) \{[\s\S]{0,400}?this\.syncInputBusy\(\)/.test(sprite),
      'closeMenu 必须上报（菜单的四条关闭路径都走它）',
    );
    // 菜单被点外/Esc 关闭：走的是 mountContextMenu 的 onClose，不经 closeMenu
    assert.ok(
      /onClose: \(\) => \{\s*this\.menuOpen = false;[\s\S]{0,200}?this\.syncInputBusy\(\)/.test(sprite),
      '菜单 onClose（点外/Esc）必须上报——这条路径不经 closeMenu',
    );
    // 对话弹窗关闭
    assert.ok(/this\.chatOpen = false;[\s\S]{0,300}?this\.syncInputBusy\(\)/.test(sprite), '对话弹窗关闭必须上报');
  });

  test('上报是幂等的、只走 petBridge.setInputBusy（不逐帧刷 IPC）', () => {
    assert.ok(
      /if \(busy === this\._inputBusy\) return;/.test(sprite),
      '值未变必须直接返回（拖拽中 mouseleave 等高频路径会反复调用）',
    );
    assert.ok(/window\.petBridge\.setInputBusy\(busy\)/.test(sprite), '必须经 petBridge 上报');
  });

  test('preload 暴露 setInputBusy（方法名必须与 sprite.js 调用的一致）', () => {
    const preload = readSource(helper + 'preload.js');
    assert.ok(/setInputBusy\(busy\)/.test(preload), 'preload 必须有 setInputBusy');
    assert.ok(/'pet:input-busy'/.test(preload), 'IPC 频道名必须与 main.js 一致');
  });
});
