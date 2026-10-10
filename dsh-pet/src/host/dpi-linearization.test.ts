/**
 * 桌面 helper「全局 DPI 线性化」的判定测试 —— macOS 桌面宠物大一倍的修复。
 *
 * 背景：Windows 上 Chromium 的 DIP↔物理像素换算是**逐显示器**的仿射变换，窗口骑缝时两套坐标系横跳
 * （拖过屏缝「分身闪烁」）。helper 的修法是启动前 `--force-device-scale-factor=1` 把坐标系塌缩成
 * 恒等映射，再按探测到的**真实主屏 scaleFactor** 把宠物放大回原来的观感（补偿）。但补偿的前提——
 * 「该开关会把 DIP 换算成物理像素」——**只对 Windows 成立**：macOS 的 DIP 恒等于「点」，开关只改
 * backing store 分辨率、不改坐标系，于是补偿变成纯粹的放大：Retina(2x) 上 petScale=2，配置 size=462
 * 的宠物被渲染成 924 点宽、窗口要 1848×1487 点（比 1920×1080 的屏幕还高，左边缘被挤出屏幕外），
 * 而同一份配置在浏览器 overlay 里是 462 CSS 像素 —— 桌面端与浏览器端差了整整一倍。
 *
 * 本文件钉三件事：
 *   ① 纯判定规则：darwin 一律不启用；win32/linux 维持原行为；探测子进程与 DSH_PET_FORCE_DSF='0'
 *      各自的短路；强制值与渲染端缩放的两步换算；
 *   ② 端到端不变量：同一份配置下 macOS 的宠物尺寸必须等于配置值（修复前是它的 2 倍），而 Windows
 *      150% 屏仍按 1.5 补偿（主屏观感与修复前逐像素相同）；
 *   ③ 源码守卫：平台例外只住在 dpi-linearization.js 里、main.js 只接线不重新实现，以及新模块进了
 *      发布必需清单（漏了 npm 包里就少一个 main.js 必需的模块，helper 启动即崩）。
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
const { shouldLinearize, resolveForcedScale, resolvePetScale } = require(helper + 'dpi-linearization.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('shouldLinearize —— 平台例外（本 PR 的修复）', () => {
  test('darwin 一律不启用：DIP 已是「点」，强制 DSF 不换坐标系、没有可补偿的东西', () => {
    // 真机实测值：1920×1080 屏、backingScaleFactor=2 → 探测到的主屏 scaleFactor 是 2
    assert.equal(shouldLinearize({ platform: 'darwin', dpiProbe: false }), false);
    assert.equal(shouldLinearize({ platform: 'darwin', dpiProbe: false, forceDsf: '1' }), false);
    assert.equal(shouldLinearize({ platform: 'darwin', dpiProbe: false, forceDsf: '2' }), false);
  });

  test('win32 / linux 维持原行为（本修复不动任何非 macOS 平台）', () => {
    assert.equal(shouldLinearize({ platform: 'win32', dpiProbe: false }), true);
    assert.equal(shouldLinearize({ platform: 'linux', dpiProbe: false }), true);
    assert.equal(shouldLinearize({ platform: 'win32', dpiProbe: false, forceDsf: '1' }), true);
  });

  test('DSH_PET_FORCE_DSF=0 关掉整个机制（任何平台都认）', () => {
    assert.equal(shouldLinearize({ platform: 'win32', dpiProbe: false, forceDsf: '0' }), false);
    assert.equal(shouldLinearize({ platform: 'linux', dpiProbe: false, forceDsf: 0 }), false);
  });

  test('探测子进程自己不做（它会再 spawn 一个探测子进程，无限递归）', () => {
    assert.equal(shouldLinearize({ platform: 'win32', dpiProbe: true }), false);
    assert.equal(shouldLinearize({ platform: 'linux', dpiProbe: true, forceDsf: '2' }), false);
  });
});

describe('resolveForcedScale —— 要强制成几（0 = 不启用）', () => {
  test('探测到真实主屏缩放 → 锁死 1（恒等映射，跨屏几何再无换算）', () => {
    assert.equal(resolveForcedScale({ primaryScale: 2 }), 1);
    assert.equal(resolveForcedScale({ primaryScale: 1.5 }), 1);
  });

  test('探测失败 → 0：宁可退回修复前的逐屏 DIP 行为，也不做没有补偿的缩放', () => {
    assert.equal(resolveForcedScale({ primaryScale: 0 }), 0);
    assert.equal(resolveForcedScale({}), 0);
  });

  test('正数覆盖优先（排障用，会踩 main.js 注释里说的那个 bug）', () => {
    assert.equal(resolveForcedScale({ forceDsf: '2', primaryScale: 2 }), 2);
    assert.equal(resolveForcedScale({ forceDsf: 1.75, primaryScale: 0 }), 1.75);
  });

  test('覆盖值非法（0 / 负数 / 非数字）不生效，回落正常路径', () => {
    assert.equal(resolveForcedScale({ forceDsf: '0', primaryScale: 2 }), 1);
    assert.equal(resolveForcedScale({ forceDsf: '-1', primaryScale: 2 }), 1);
    assert.equal(resolveForcedScale({ forceDsf: 'abc', primaryScale: 2 }), 1);
    assert.equal(resolveForcedScale({ forceDsf: 'abc', primaryScale: 0 }), 0);
  });
});

describe('resolvePetScale —— 渲染端 CONFIG.scale', () => {
  test('未启用（forcedScale=0）→ 等于宿主给的基准，不补偿', () => {
    assert.equal(resolvePetScale({ baseScale: '1', primaryScale: 2, forcedScale: 0 }), 1);
  });

  test('主屏探测失败（primaryScale=0）→ 也不补偿（分母为 0 是 NaN 的来源）', () => {
    assert.equal(resolvePetScale({ baseScale: '1', primaryScale: 0, forcedScale: 1 }), 1);
    assert.equal(resolvePetScale({ baseScale: '1', primaryScale: 0, forcedScale: 0 }), 1);
  });

  test('启用后按 primary/forced 放大回原观感（150% 屏 → ×1.5）', () => {
    assert.equal(resolvePetScale({ baseScale: '1', primaryScale: 1.5, forcedScale: 1 }), 1.5);
    assert.equal(resolvePetScale({ baseScale: '2', primaryScale: 1.5, forcedScale: 1 }), 3);
  });

  test('base 缺省/非法 → 回落 1', () => {
    assert.equal(resolvePetScale({}), 1);
    assert.equal(resolvePetScale({ baseScale: '', primaryScale: 2, forcedScale: 0 }), 1);
    assert.equal(resolvePetScale({ baseScale: 'oops', primaryScale: 2, forcedScale: 0 }), 1);
  });
});

/** 与 main.js 接线同序地跑完整条链路：启用判定 → 强制值 → 渲染端缩放 */
function petScaleOf(platform: string, primaryScale: number, forceDsf?: string): number {
  const enabled = shouldLinearize({ platform, dpiProbe: false, forceDsf });
  const primary = enabled ? primaryScale : 0;
  const forced = enabled ? resolveForcedScale({ forceDsf, primaryScale: primary }) : 0;
  return resolvePetScale({ baseScale: '1', primaryScale: primary, forcedScale: forced });
}

describe('端到端不变量 —— 用户真正看到的那件事', () => {
  const SIZE = 462; // 内置默认配置（assets/config.jsonc）的宠物宽度

  test('macOS(Retina 2x)：宠物尺寸必须等于配置值 —— 修复前这里量到 924 点', () => {
    assert.equal(SIZE * petScaleOf('darwin', 2), 462);
  });

  test('macOS：探测失败 / 没缓存也不受影响（不启用就永不补偿）', () => {
    assert.equal(SIZE * petScaleOf('darwin', 0), 462);
  });

  test('Windows 150% 屏：仍按 1.5 补偿（主屏观感与修复前逐像素相同）', () => {
    assert.equal(SIZE * petScaleOf('win32', 1.5), 693);
  });

  test('Windows 100% 屏：探测到 1 → 强制 1 → 补偿退化为 ×1（无变化）', () => {
    assert.equal(SIZE * petScaleOf('win32', 1), 462);
  });
});

describe('源码守卫 —— main.js 只接线，规则住在 dpi-linearization.js', () => {
  const main = readSource(helper + 'main.js');

  test('main.js 必须 require 新模块', () => {
    assert.ok(/require\('\.\/dpi-linearization\.js'\)/.test(main), '必须 require dpi-linearization.js');
  });

  test('三条规则都从模块取，不得内联', () => {
    assert.ok(/shouldLinearize\(/.test(main), '启用判定必须走 shouldLinearize');
    assert.ok(/resolveForcedScale\(/.test(main), '强制值必须走 resolveForcedScale');
    assert.ok(/resolvePetScale\(/.test(main), '渲染端缩放必须走 resolvePetScale');
    assert.ok(!/PRIMARY_SCALE \/ FORCED_SCALE/.test(main), '补偿公式不允许再内联在 main.js 里');
  });

  test('平台例外只允许住在模块里（main.js 不得出现 darwin 分支）', () => {
    assert.ok(!/darwin/.test(main), '平台判断写进 main.js 就绕过了本文件的单测');
  });

  test('强制 DSF 的 switch 必须在 shouldLinearize 判定之内（否则 macOS 又被放大）', () => {
    const guardAt = main.indexOf('shouldLinearize(');
    const switchAt = main.indexOf("appendSwitch('force-device-scale-factor'");
    assert.ok(guardAt >= 0 && switchAt >= 0, '两处都必须在位');
    assert.ok(switchAt > guardAt, 'switch 必须排在判定之后（同一分支内）');
  });

  test('renderer 侧页面缩放仍取自 petScale()（两端共用一个来源）', () => {
    assert.ok(/setZoomFactor\(scale\)/.test(main), '窗口缩放必须来自 petScale()');
    assert.ok(/const scale = petScale\(\)/.test(main), 'petScale() 必须在建窗前求值一次');
  });
});

describe('守卫：dpi-linearization.js 必须在发布必需清单里', () => {
  test('prepack-check.js 的 required 含它（main.js require，缺了会启动即崩）', () => {
    const src = readSource('../../scripts/prepack-check.js');
    assert.ok(
      /'runtime\/electron-helper\/dpi-linearization\.js'/.test(src),
      '漏了它，npm 包里就少一个 main.js 必需的模块',
    );
  });
});
