/**
 * 桌面 helper「弹弓」小互动窗口的启动判定（runtime/electron-helper/game-launch.js）。
 *
 * 为什么要测：
 *   1. sanitizeGameInit 是**进程边界**：宠物窗口经 IPC 发来的载荷原样拼进游戏页 URL，
 *      素材根只许是宿主 /dsh-pet-7340 前缀（bridge scheme 或本机 HTTP），其余一律拒收；
 *   2. gameWindowBounds 决定透明游戏窗口铺在哪：铺满整个工作区，
 *      **底边贴工作区底边**——场景地面就是任务栏上沿，宠物落地的位置与桌宠一致。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  sanitizeGameInit,
  gameWindowBounds,
  gameIgnoresMouse,
  sanitizeGameInput,
  MAX_ANIM_NAMES,
} = require('../../runtime/electron-helper/game-launch.js');

const BRIDGE_BASE = 'dsh-pet-bridge://dsh-pet/dsh-pet-7340';
const HTTP_BASE = 'http://127.0.0.1:3081/dsh-pet-7340';
const valid = (over: Record<string, unknown> = {}) => ({
  petName: '大肥鱼',
  petSize: 462,
  base: BRIDGE_BASE,
  assetBase: BRIDGE_BASE + '/thumb/main/',
  idle: ['待机'],
  drag: ['拖拽'],
  cheer: '点击回应-开心跃动',
  ...over,
});

describe('sanitizeGameInit —— IPC 载荷校验', () => {
  test('bridge 前缀：原样通过', () => {
    assert.deepEqual(sanitizeGameInit(valid()), valid());
  });

  test('本机 HTTP 前缀（非 bridge 的手动启动流）：通过', () => {
    const p = valid({ base: HTTP_BASE, assetBase: HTTP_BASE + '/thumb/main/' });
    assert.equal(sanitizeGameInit(p)?.base, HTTP_BASE);
  });

  test('非对象 / null → null', () => {
    assert.equal(sanitizeGameInit(null), null);
    assert.equal(sanitizeGameInit('x'), null);
  });

  test('外部主机 / 其它 scheme → null', () => {
    assert.equal(sanitizeGameInit(valid({ base: 'https://evil.example/dsh-pet-7340' })), null);
    assert.equal(sanitizeGameInit(valid({ base: 'http://192.168.1.2:3081/dsh-pet-7340' })), null);
    assert.equal(sanitizeGameInit(valid({ base: 'file:///C:/dsh-pet-7340' })), null);
  });

  test('前缀不是 /dsh-pet-7340 → null', () => {
    assert.equal(
      sanitizeGameInit(
        valid({ base: 'http://127.0.0.1:3081/other', assetBase: 'http://127.0.0.1:3081/other/thumb/x/' }),
      ),
      null,
    );
  });

  test('URL 带用户名 / 密码 → null（藏在 userinfo 里的字符会原样进 CSS）', () => {
    const evil = 'http://x");}body{display:none}x{y:url("@127.0.0.1:9/dsh-pet-7340';
    assert.equal(sanitizeGameInit(valid({ base: evil, assetBase: evil + '/thumb/main/' })), null);
    assert.equal(
      sanitizeGameInit(
        valid({
          base: 'http://u:p@127.0.0.1:3081/dsh-pet-7340',
          assetBase: 'http://127.0.0.1:3081/dsh-pet-7340/thumb/m/',
        }),
      ),
      null,
    );
  });

  test('输出的是解析后重建的规范地址，不是原始字符串', () => {
    const out = sanitizeGameInit(
      valid({
        base: 'http://127.0.0.1:3081/dsh-pet-7340/',
        assetBase: 'http://127.0.0.1:3081/dsh-pet-7340/thumb/main/',
      }),
    );
    assert.equal(out?.base, HTTP_BASE);
    assert.equal(out?.assetBase, HTTP_BASE + '/thumb/main/');
  });

  test('assetBase 用 .. 跳出 /thumb/ → null', () => {
    assert.equal(sanitizeGameInit(valid({ assetBase: BRIDGE_BASE + '/thumb/../font/' })), null);
    assert.equal(sanitizeGameInit(valid({ assetBase: BRIDGE_BASE + '/thumb/%2e%2e/%2e%2e/x/' })), null);
  });

  test('assetBase 带查询串 / 片段 → null', () => {
    assert.equal(sanitizeGameInit(valid({ assetBase: BRIDGE_BASE + '/thumb/main/?a=1' })), null);
    assert.equal(sanitizeGameInit(valid({ assetBase: BRIDGE_BASE + '/thumb/main/#x' })), null);
  });

  test('assetBase 必须在 base 的 /thumb/ 之下', () => {
    assert.equal(sanitizeGameInit(valid({ assetBase: BRIDGE_BASE + '/font/' })), null);
    assert.equal(sanitizeGameInit(valid({ assetBase: HTTP_BASE + '/thumb/main/' })), null);
  });

  test('动画名：只留非空字符串、过长丢弃、数量封顶', () => {
    const many = Array.from({ length: MAX_ANIM_NAMES + 10 }, (_, i) => 'a' + i);
    const out = sanitizeGameInit(valid({ idle: ['ok', '', 3, null, 'x'.repeat(500)], drag: many }));
    assert.deepEqual(out?.idle, ['ok']);
    assert.equal(out?.drag.length, MAX_ANIM_NAMES);
  });

  test('欢呼动画：非字符串 / 空 / 过长 → 空串（不播）', () => {
    assert.equal(sanitizeGameInit(valid({ cheer: 3 }))?.cheer, '');
    assert.equal(sanitizeGameInit(valid({ cheer: '' }))?.cheer, '');
    assert.equal(sanitizeGameInit(valid({ cheer: 'x'.repeat(500) }))?.cheer, '');
  });

  test('桌宠大小（CSS 像素）：合法数值原样通过；缺失 / 非数 / 越界 → 0（游戏页按整窗缩放）', () => {
    assert.equal(sanitizeGameInit(valid({ petSize: 300 }))?.petSize, 300);
    for (const petSize of [undefined, '462', Number.NaN, Infinity, 0, -5, 10, 1e6]) {
      assert.equal(sanitizeGameInit(valid({ petSize }))?.petSize, 0, String(petSize));
    }
  });

  test('不再带跑步片段：宠物停下后直接回到弹弓（载荷里多给的 run 一律丢掉）', () => {
    const out = sanitizeGameInit(valid({ run: { name: '原地左转奔跑', from: 2.05, to: 3.85, tail: 4.8 } }));
    assert.ok(out);
    assert.equal('run' in out, false);
  });

  test('宠物名：去空白、截断、缺省回落', () => {
    assert.equal(sanitizeGameInit(valid({ petName: '  阿肥  ' }))?.petName, '阿肥');
    assert.equal(sanitizeGameInit(valid({ petName: 'x'.repeat(100) }))?.petName.length, 40);
    assert.equal(sanitizeGameInit(valid({ petName: 42 }))?.petName, '宠物');
  });
});

describe('gameWindowBounds —— 透明游戏窗口铺满工作区', () => {
  test('横屏 / 带鱼屏 / 竖屏：窗口 = 整个工作区（场景按桌宠大小画，宠物与木箱按屏幕宽的 1/6 定位）', () => {
    for (const area of [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: -2560, y: 0, width: 3440, height: 1400 },
      { x: 0, y: 40, width: 1080, height: 1880 },
    ]) {
      assert.deepEqual(gameWindowBounds({ workArea: area }), area);
    }
  });

  test('底边贴工作区底边（地面 = 任务栏上沿）', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const b = gameWindowBounds({ workArea: area });
    assert.equal(b.y + b.height, area.y + area.height);
  });

  test('返回新对象，不回传入参', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    assert.notEqual(gameWindowBounds({ workArea: area }), area);
  });
});

describe('gameIgnoresMouse —— 除宠物外整窗点击穿透', () => {
  const bounds = { x: 100, y: 200, width: 1600, height: 900 };
  const regions = [{ x: 150, y: 400, w: 120, h: 140 }]; // 页面 CSS 像素
  const at = (x: number, y: number, extra: Record<string, unknown> = {}) =>
    gameIgnoresMouse({ bounds, point: { x, y }, zoom: 1, regions, busy: false, ...extra });

  test('光标在宠物区域内 → 不穿透', () => assert.equal(at(100 + 200, 200 + 450), false));
  test('光标在透明处 → 穿透到桌面', () => assert.equal(at(100 + 800, 200 + 300), true));
  test('窗口外 → 穿透', () => assert.equal(at(50, 50), true));
  test('拖拽中 / 菜单开着（busy）→ 无论光标在哪都不穿透', () =>
    assert.equal(at(100 + 800, 200 + 300, { busy: true }), false));
  test('页面缩放：区域按 zoom 换算到窗口像素', () => {
    assert.equal(at(100 + 200 * 1.5, 200 + 450 * 1.5, { zoom: 1.5 }), false);
    assert.equal(at(100 + 200, 200 + 450, { zoom: 1.5 }), true);
  });
  test('没有区域 → 穿透', () => assert.equal(at(100 + 200, 200 + 450, { regions: [] }), true));
});

describe('sanitizeGameInput —— 页面上报的交互区域', () => {
  test('合法区域与 busy 原样通过', () => {
    assert.deepEqual(sanitizeGameInput({ regions: [{ x: 1, y: 2, w: 3, h: 4 }], busy: true }), {
      regions: [{ x: 1, y: 2, w: 3, h: 4 }],
      busy: true,
    });
  });
  test('非法项丢弃、数量封顶、busy 只认 true', () => {
    const many = Array.from({ length: 20 }, () => ({ x: 0, y: 0, w: 1, h: 1 }));
    const out = sanitizeGameInput({ regions: [...many, { x: 'a' }, null, { x: 0, y: 0, w: -1, h: 2 }], busy: 'yes' });
    assert.equal(out.regions.length, 8);
    assert.equal(out.busy, false);
  });
  test('垃圾载荷 → 空', () => assert.deepEqual(sanitizeGameInput(null), { regions: [], busy: false }));
});
