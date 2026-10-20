/**
 * 单实例唤回 —— 桌面壳控制端点（ticket 05）。
 *
 * 宿主拿到第二个启动请求时，已有实例要做的不是"再开一套窗口"，而是通过既有的
 * bridge 回调通道（main.js 开的 127.0.0.1 随机端口）反向 POST `/control`。
 * 这里钉住壳侧的两块纯逻辑：
 *   1. `parseControlRequest`：只接受 `POST /control` + `{"action":"focus"}`，
 *      路径/方法/载荷不对时给出明确的 4xx，不静默当成应答（`/respond` 语义完全不同）；
 *   2. `focusAllWindows`：作用于**全部**未销毁的宠物窗口（多宠物配置），
 *      单窗抛错不影响其它窗口，且顺序固定为「显示 → 重钉置顶 → 提到最前」。
 *
 * 壳是随包发行的手写 CommonJS，用 node:test + createRequire 直接加载（同 probe-command.test.ts）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { parseControlRequest, focusAllWindows } = require('../../runtime/electron-helper/control-request.js');
const mainSource = readFileSync(new URL('../../runtime/electron-helper/main.js', import.meta.url), 'utf8');

type ParsedControl = { ok: true; action: 'focus' } | { ok: false; status: number; error: string };

function request(method: string, url: string, body: string): ParsedControl {
  return parseControlRequest({ method, url, body });
}

describe('parseControlRequest —— 壳侧控制请求解析', () => {
  test('POST /control + {"action":"focus"} → focus', () => {
    assert.deepEqual(request('POST', '/control', '{"action":"focus"}'), { ok: true, action: 'focus' });
  });

  test('其它路径 404（不能把控制请求与宿主应答 /respond 混在一起）', () => {
    const parsed = request('POST', '/respond', '{"action":"focus"}');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 404);
  });

  test('非 POST 方法 405', () => {
    const parsed = request('GET', '/control', '');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 405);
  });

  test('非法 JSON / 未知 action 一律 400', () => {
    for (const body of ['not json', '{}', '{"action":"quit"}', '{"action":42}', '']) {
      const parsed = request('POST', '/control', body);
      assert.equal(parsed.ok, false, `载荷 ${JSON.stringify(body)} 不得被接受`);
      assert.equal(parsed.status, 400);
    }
  });

  test('缺失请求对象不崩溃（没有 /control 路径 → 404）', () => {
    const parsed = parseControlRequest(undefined) as ParsedControl;
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 404);
  });
});

type FakeWindow = {
  calls: string[];
  isDestroyed(): boolean;
  showInactive(): void;
  setAlwaysOnTop(flag: boolean, level: string): void;
  moveTop(): void;
};

function fakeWindow(options: { destroyed?: boolean; throws?: boolean } = {}): FakeWindow {
  return {
    calls: [],
    isDestroyed: () => options.destroyed === true,
    showInactive() {
      if (options.throws) throw new Error('window gone');
      this.calls.push('showInactive');
    },
    setAlwaysOnTop(flag: boolean, level: string) {
      this.calls.push(`setAlwaysOnTop:${String(flag)}:${level}`);
    },
    moveTop() {
      this.calls.push('moveTop');
    },
  };
}

describe('focusAllWindows —— 唤回全部宠物窗口', () => {
  test('每个未销毁窗口都执行「显示（不抢焦点）→ 重钉置顶 → 提到最前」', () => {
    const a = fakeWindow();
    const b = fakeWindow();
    const focused = focusAllWindows([a, b]) as number;
    assert.equal(focused, 2);
    const expected = ['showInactive', 'setAlwaysOnTop:true:screen-saver', 'moveTop'];
    assert.deepEqual(a.calls, expected);
    assert.deepEqual(b.calls, expected);
  });

  test('已销毁窗口跳过；单个窗口抛错不影响其它宠物', () => {
    const destroyed = fakeWindow({ destroyed: true });
    const broken = fakeWindow({ throws: true });
    const alive = fakeWindow();
    const focused = focusAllWindows([destroyed, broken, alive]) as number;
    assert.equal(focused, 1, '只统计真正唤回的窗口');
    assert.deepEqual(destroyed.calls, []);
    assert.deepEqual(alive.calls, ['showInactive', 'setAlwaysOnTop:true:screen-saver', 'moveTop']);
  });

  test('空列表安全（没有桌面宠物时 helper 仍可能常驻）', () => {
    assert.equal(focusAllWindows([]), 0);
  });
});

describe('runtime/electron-helper/main.js —— 控制端点接线', () => {
  test('回调服务器复用 control-request.js，而不是另开端口/新通道', () => {
    assert.match(mainSource, /require\(['"]\.\/control-request\.js['"]\)/);
    assert.match(mainSource, /parseControlRequest\(/);
    assert.match(mainSource, /focusAllWindows\(/);
    assert.match(mainSource, /['"]\/control['"]/, '回调服务器必须识别 /control 路径');
  });

  test('原有 /respond 应答路径保持不变', () => {
    assert.match(mainSource, /['"]\/respond['"]/);
    assert.match(mainSource, /bridgeResolve\(/);
  });
});
