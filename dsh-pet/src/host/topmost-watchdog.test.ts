/**
 * 桌面 helper「置顶看门狗」的判定 + 源码守卫。
 *
 * 背景（0.3.6 现场复现，Windows 双屏 + DSH 主窗最大化）：桌宠整只沉到 DSH 主窗下面，
 * 用户看到的是「宠物不见了」——进程活着、渲染正常（PrintWindow 抓得到宠物与气泡）、动画照跑，
 * 只是屏幕上没有；实测 z 序 DSH 主窗（普通窗）在桌宠窗之上，而桌宠窗的 `WS_EX_TOPMOST` 位仍为真。
 *
 * 根因形状：`WS_EX_TOPMOST` 只是样式位，**不等于**窗口在置顶带里。该位必须靠
 * `SetWindowPos(HWND_TOPMOST/HWND_NOTOPMOST)` 才能真正落带，直接写 `GWL_EXSTYLE` 只写位不落带；
 * 而 Electron 在 Windows 上翻转点击穿透走的就是 `SetWindowLong(GWL_EXSTYLE)` 读-改-写
 * （native_window_views.cc 的 `SetIgnoreMouseEvents`，桌宠每进出一次命中区 + 60ms 兜底轮询都会写），
 * 于是「位在、带不在」这个状态既可能出现、又查不出来。建窗时那次 `setAlwaysOnTop` 之后再无复查，
 * 于是外部一次 z 序扰动就能让桌宠永久隐身，直到 helper 重启。
 *
 * 本文件钉三件事：
 *   ① 判定规则：到点才重钉；隐藏/销毁/自检挂起期间不钉（这一拍被拦就下一拍补上）；
 *   ② 常量不变式：节拍必须快于重钉间隔，否则判定退化成"每拍都钉"；
 *   ③ 源码守卫：main.js 里必须真的按这套规则接线（Electron 起不来，只能读源码断言），
 *      且看门狗**只**重钉置顶，不得移动/缩放/显隐/抢焦点（那些是渲染端与其它通道的职责）。
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
const { TOPMOST_WATCHDOG_TICK_MS, TOPMOST_REASSERT_MS, shouldReassertTopmost } = require(
  helper + 'topmost-watchdog.js',
);

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 一份"窗口健在、可见、没被挂起"的基准状态 */
const alive = { destroyed: false, visible: true, paused: false };

describe('shouldReassertTopmost —— 到点才重钉，每拍都问一次', () => {
  test('未到点不钉，到点钉', () => {
    assert.equal(
      shouldReassertTopmost({ ...alive, nowMs: 1000, lastAssertMs: 1000 }),
      false,
      '刚钉过不能立刻再钉（否则每拍一次 SetWindowPos）',
    );
    assert.equal(
      shouldReassertTopmost({ ...alive, nowMs: 1000 + TOPMOST_REASSERT_MS - 1, lastAssertMs: 1000 }),
      false,
      '差 1ms 不钉',
    );
    assert.equal(
      shouldReassertTopmost({ ...alive, nowMs: 1000 + TOPMOST_REASSERT_MS, lastAssertMs: 1000 }),
      true,
      '到点必须钉',
    );
  });

  test('隐藏 / 销毁 / 自检挂起期间一律不钉，哪怕早就到点', () => {
    const due = { nowMs: 1000 + TOPMOST_REASSERT_MS * 10, lastAssertMs: 1000 };
    assert.equal(shouldReassertTopmost({ ...due, ...alive, visible: false }), false, '未 show 的窗口钉了没意义');
    assert.equal(shouldReassertTopmost({ ...due, ...alive, destroyed: true }), false, '窗口已销毁不能再碰');
    assert.equal(
      shouldReassertTopmost({ ...due, ...alive, paused: true }),
      false,
      '冒烟自检挂起期间不得插一脚（与兜底轮询同一开关）',
    );
    assert.equal(shouldReassertTopmost({ ...due, visible: true }), true, '同样到点但没被拦时照钉');
  });

  test('时间戳异常（时钟回拨 / 缺参数）按到点处理；连 visible 都没声明则不钉', () => {
    assert.equal(
      shouldReassertTopmost({ ...alive, nowMs: 1000, lastAssertMs: 10_000 }),
      true,
      '时钟被回拨不能让看门狗永远哑火',
    );
    assert.equal(shouldReassertTopmost({ ...alive, nowMs: Number.NaN, lastAssertMs: 1000 }), true);
    assert.equal(shouldReassertTopmost({ destroyed: false, paused: false }), false, '没声明 visible 就不能钉');
    assert.equal(shouldReassertTopmost(undefined), false, '缺状态按不钉处理');
  });

  test('常量不变式：节拍必须快于重钉间隔', () => {
    assert.ok(TOPMOST_WATCHDOG_TICK_MS > 0, '节拍必须是正数');
    assert.ok(TOPMOST_WATCHDOG_TICK_MS < TOPMOST_REASSERT_MS, '节拍 >= 重钉间隔时判定退化成每拍都钉，纯函数也就白写了');
  });
});

describe('源码守卫 —— 置顶看门狗必须在 main.js 里按这套规则接线', () => {
  const main = readSource(helper + 'main.js');
  /** 看门狗定时器体（锚在 topmostTimer 的赋值上，避免匹配到更早的其它 setInterval） */
  const watchdogBody = (): string => {
    const m = /topmostTimer = setInterval\(\(\) => \{([\s\S]*?)\}, TOPMOST_WATCHDOG_TICK_MS\);/.exec(main);
    assert.ok(m, '找不到看门狗定时器（节拍必须是命名常量 TOPMOST_WATCHDOG_TICK_MS）');
    return m[1];
  };

  test('建窗时那次置顶不能删，且看门狗走的是同一个 API（screen-saver 档）', () => {
    assert.ok(
      /win\.setAlwaysOnTop\(true, 'screen-saver'\);/.test(main),
      '建窗时必须先置顶一次（看门狗只负责复查，不能当成唯一置顶来源）',
    );
    assert.ok(
      (main.match(/win\.setAlwaysOnTop\(true, 'screen-saver'\)/g) ?? []).length >= 2,
      '看门狗必须再钉一次同档位（HWND_TOPMOST 落带靠它；moveTop 的 HWND_TOP 对已沉底窗口无效）',
    );
    assert.ok(
      /require\('\.\/topmost-watchdog\.js'\)/.test(main),
      '看门狗判定必须复用 runtime/electron-helper/topmost-watchdog.js（纯逻辑有单测）',
    );
    assert.ok(!/win\.moveTop\(/.test(main), 'moveTop()=HWND_TOP 不落置顶带，不得用它当兜底');
  });

  test('看门狗按判定函数 + 命名节拍运行，并在窗口关闭时停掉', () => {
    assert.ok(/shouldReassertTopmost\(/.test(main), '必须调用纯判定');
    const body = watchdogBody();
    assert.ok(/win\.isDestroyed\(\)/.test(body), '判定必须带上"窗口已销毁"');
    assert.ok(/win\.isVisible\(\)/.test(body), '判定必须带上"窗口可见"（未 show 时不钉）');
    assert.ok(/pointerFallbackPaused/.test(body), '判定必须带上自检挂起开关');
    assert.ok(/lastAssertMs: lastTopmostAssertMs/.test(body), '必须把上次重钉时间带进判定');
    assert.ok(/clearInterval\(topmostTimer\)/.test(main), '窗口关闭时必须停掉看门狗');
  });

  test('看门狗只重钉置顶：不得顺手移动/缩放/显隐/抢焦点', () => {
    const body = watchdogBody();
    for (const forbidden of [
      'setContentBounds',
      'setBounds',
      'win.show(',
      'win.hide(',
      'win.focus(',
      'setIgnoreMouseEvents',
    ]) {
      assert.ok(
        !body.includes(forbidden),
        `看门狗体里不得出现 ${forbidden}（位置/显隐/输入透传各有专职通道，混进来会互相打架）`,
      );
    }
  });
});
