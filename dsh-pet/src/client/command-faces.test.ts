/**
 * 宿主命令面孔补丁的契约测试 —— 钉住「包装 `commandUi.candidates`」这套机制的全部前提。
 *
 * 为什么值得单独测：DSH 目前没有给第三方**宿主命令**配图标的官方入口（`CommandDefinition`
 * 无 icon 字段、`CommandDecoration` 只有 ui、前端 `candidates()` 只认 6 个第一方包的白名单），
 * 本插件只能靠「自有属性遮蔽原型方法」这一条内部细节补上面孔。这套机制一旦失效，
 * 表现是「菜单没图标」而不是报错，很容易在升级后无声退化 —— 所以每条前提都要有断言兜住：
 *
 * - 包装后 DSH 的**闭包**（`(s, r) => this.candidates(s, r)`）能取到加工过的行；
 * - 没有面孔的命令、非数组返回、数组里的非对象元素，一律原样放行；
 * - DSH 自己给了 icon 的行不被覆盖（将来官方支持后本补丁自动让位）；
 * - label 每次现取（语言切换下一轮生效）；
 * - 映射逻辑抛错时退回原始行（菜单不会坏），但 original 自己的错误不吞；
 * - `candidates` 缺失时完全不装；dispose 能还原。
 *
 * 跑法：node --experimental-strip-types --test src/client/command-faces.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installCommandFaces, type CommandFace, type CommandUiLike } from './command-faces.ts';

/** 菜单候选行（测试里只关心这几个字段）。 */
type Row = Record<string, unknown>;

/**
 * 复刻 dsh-client-ui-commands 的 `CommandUiRuntime` 关键形态：
 * `candidates` 是**原型方法**（不是实例字段），所以自有属性可以遮蔽它。
 */
class FakeCommandUi {
  rows: unknown[];
  /** original 被真正调用的次数（验证包装确实转发了）。 */
  calls = 0;
  /** original 收到的实参（验证包装原样透传 session / req）。 */
  lastArgs: unknown[] = [];

  constructor(rows: unknown[]) {
    this.rows = rows;
  }

  async candidates(session: unknown, req: unknown): Promise<unknown> {
    this.calls += 1;
    this.lastArgs = [session, req];
    return this.rows;
  }
}

/** 复刻 DSH 注册 source 的写法：闭包在**运行时**从实例上取 `candidates`。 */
function sourceOf(ui: FakeCommandUi): { candidates: (s: unknown, r: unknown) => Promise<unknown> } {
  return { candidates: (session: unknown, req: unknown) => ui.candidates(session, req) };
}

/** 走一遍 DSH 的闭包路径，把行取回来。 */
async function rowsOf(source: { candidates: (s: unknown, r: unknown) => Promise<unknown> }): Promise<Row[]> {
  return (await source.candidates({}, {})) as Row[];
}

/** 假图标组件：类型上就是 `ComponentType<IconProps>`，测试不渲染它。 */
const ICON: CommandFace['icon'] = () => null;

/** 固定标题的面孔。 */
function face(label: string): CommandFace {
  return { label: () => label, icon: ICON };
}

/**
 * 临时接管 `console.warn`，返回收集到的消息与还原函数。
 * 降级路径的告警既要断言（否则「静默失效」这条就没人守），又不该污染测试输出。
 */
function captureWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(' '));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

describe('installCommandFaces —— 包装 commandUi.candidates', () => {
  test('装补丁后，DSH 的闭包取到的行带上了 label 与 icon', async () => {
    const ui = new FakeCommandUi([{ name: 'chat' }, { name: 'other' }]);
    const source = sourceOf(ui);
    const dispose = installCommandFaces(ui, new Map([['chat', face('对话')]]));

    const rows = await rowsOf(source);
    assert.equal(rows[0].label, '对话');
    assert.equal(rows[0].icon, ICON);
    // 没配面孔的命令原样不动
    assert.equal(rows[1].label, undefined);
    assert.equal(rows[1].icon, undefined);
    // 包装确实转发到了原始方法，且原样透传参数
    assert.equal(ui.calls, 1);
    assert.deepEqual(ui.lastArgs, [{}, {}]);

    dispose();
  });

  test('装的是自有属性，因此遮蔽了原型方法（这就是整套机制的前提）', () => {
    const ui = new FakeCommandUi([]);
    const before = ui.candidates;
    assert.equal(Object.prototype.hasOwnProperty.call(ui, 'candidates'), false);

    const dispose = installCommandFaces(ui, new Map());
    assert.notEqual(ui.candidates, before);
    assert.equal(Object.prototype.hasOwnProperty.call(ui, 'candidates'), true);

    dispose();
  });

  test('label 每次候选轮询现取 —— 语言切换在下一轮菜单打开时生效', async () => {
    const ui = new FakeCommandUi([{ name: 'chat' }]);
    const source = sourceOf(ui);
    let lang = 'zh';
    const dispose = installCommandFaces(
      ui,
      new Map([['chat', { label: () => (lang === 'zh' ? '对话' : 'Chat'), icon: ICON }]]),
    );

    assert.equal((await rowsOf(source))[0].label, '对话');
    lang = 'en';
    assert.equal((await rowsOf(source))[0].label, 'Chat');

    dispose();
  });

  test('DSH 自己已经给了 icon 的行不被覆盖（将来官方支持后自动让位）', async () => {
    const official = () => null;
    const ui = new FakeCommandUi([{ name: 'chat', icon: official, label: '官方标题' }]);
    const source = sourceOf(ui);
    const dispose = installCommandFaces(ui, new Map([['chat', face('对话')]]));

    const row = (await rowsOf(source))[0];
    assert.equal(row.icon, official);
    assert.equal(row.label, '官方标题');

    dispose();
  });

  test('映射逻辑抛错时退回原始行（菜单不会坏）', async () => {
    const ui = new FakeCommandUi([{ name: 'chat', description: '来自宿主' }]);
    const source = sourceOf(ui);
    const boom: CommandFace = {
      label: () => {
        throw new Error('label 炸了');
      },
      icon: ICON,
    };
    const warn = captureWarn();
    const dispose = installCommandFaces(ui, new Map([['chat', boom]]));

    const rows = await rowsOf(source);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'chat');
    assert.equal(rows[0].label, undefined);
    assert.equal(rows[0].description, '来自宿主');
    // 降级必须留痕，否则「静默失效」没人守
    assert.equal(warn.messages.length, 1);
    assert.match(warn.messages[0], /退回原始菜单行/);
    assert.match(warn.messages[0], /label 炸了/);

    dispose();
    warn.restore();
  });

  test('不吞 original 自己的错误（DSH 已有 source-failed 兜底）', async () => {
    const ui = new FakeCommandUi([]);
    (ui as unknown as { candidates: () => Promise<unknown> }).candidates = async () => {
      throw new Error('DSH 自己的错');
    };
    const source = sourceOf(ui);
    installCommandFaces(ui, new Map([['chat', face('对话')]]));

    await assert.rejects(() => source.candidates({}, {}), /DSH 自己的错/);
  });

  test('非数组返回值原样放行（不猜 DSH 的返回形状）', async () => {
    const ui = new FakeCommandUi([]);
    (ui as unknown as { candidates: () => Promise<unknown> }).candidates = async () => 'nope';
    const source = sourceOf(ui);
    installCommandFaces(ui, new Map([['chat', face('对话')]]));

    assert.equal(await source.candidates({}, {}), 'nope');
  });

  test('数组里的非对象元素原样放行', async () => {
    const ui = new FakeCommandUi([null, 42, 'x', { name: 'chat' }]);
    const source = sourceOf(ui);
    const dispose = installCommandFaces(ui, new Map([['chat', face('对话')]]));

    const rows = await rowsOf(source);
    assert.deepEqual(rows.slice(0, 3), [null, 42, 'x']);
    assert.equal(rows[3].label, '对话');

    dispose();
  });

  test('candidates 缺失 → 完全不装，只告警', () => {
    const ui: CommandUiLike = {};
    const warn = captureWarn();
    const dispose = installCommandFaces(ui, new Map([['chat', face('对话')]]));

    assert.equal(ui.candidates, undefined);
    assert.equal(typeof dispose, 'function');
    assert.equal(warn.messages.length, 1);
    assert.match(warn.messages[0], /commandUi\.candidates 缺失/);

    dispose();
    warn.restore();
  });

  test('dispose 还原原方法（闭包重新取到未加工的行）', async () => {
    const ui = new FakeCommandUi([{ name: 'chat' }]);
    const source = sourceOf(ui);
    const dispose = installCommandFaces(ui, new Map([['chat', face('对话')]]));
    assert.equal((await rowsOf(source))[0].label, '对话');

    dispose();
    assert.equal((await rowsOf(source))[0].label, undefined);
  });

  test('dispose 只还原自己那一份 —— 后来者的包装不被抹掉', () => {
    const ui = new FakeCommandUi([{ name: 'chat' }]);
    const first = installCommandFaces(ui, new Map([['chat', face('第一层')]]));
    const patchedFirst = ui.candidates;
    const second = installCommandFaces(ui, new Map([['chat', face('第二层')]]));
    const patchedSecond = ui.candidates;

    // 第一层先 dispose：此时实例上是第二层，不该被抹成原型方法
    first();
    assert.equal(ui.candidates, patchedSecond);

    // 第二层 dispose：还原成第一层（而不是原型方法）；第一层再 dispose 才回到原型
    second();
    assert.equal(ui.candidates, patchedFirst);
    first();
  });

  test('两层包装叠加时，外层不覆盖内层已设的面孔（icon 短路同样生效）', async () => {
    const ui = new FakeCommandUi([{ name: 'chat' }]);
    const first = installCommandFaces(ui, new Map([['chat', face('第一层')]]));
    const second = installCommandFaces(ui, new Map([['chat', face('第二层')]]));

    // 内层先跑，行上已有 icon → 外层的短路规则让它原样放行，于是标题保持内层的
    assert.equal((await rowsOf(sourceOf(ui)))[0].label, '第一层');

    second();
    first();
  });
});
