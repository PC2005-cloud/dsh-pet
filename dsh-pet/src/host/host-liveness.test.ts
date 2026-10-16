/**
 * issue #56 的判定测试 —— 「宿主退出后 Electron helper 因 stdout EPIPE 崩溃弹窗 / 赖着不走」。
 *
 * 事实链（真机 + 源码都已核对）：
 *   ① helper 的 stdout/stderr 是宿主给的管道（helper-process.ts: stdio ['pipe','pipe','pipe']）；
 *   ② 宿主一退出，管道读端消失；helper 下一次写（bridge 协议行，渲染端每秒至少一条 /broadcast
 *      轮询）拿到 EPIPE —— Windows 真机实测：`EPIPE: broken pipe, write`，栈在 Socket._write；
 *   ③ 未处理的 'error' 事件 = 未捕获异常；Electron 主进程自带的处理器只弹一个模态框、**且不退出**
 *      （lib/browser/init.ts：Don't quit on fatal error）→ 桌宠卡死、进程赖着不走；
 *   ④ Windows 上 Node/libuv 的 job 对象（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE）会在宿主退出时顺手
 *      杀掉子进程，所以那一幕在 Windows 上看不全；macOS 没这层兜底，就是报告里的样子。
 *
 * 本文件钉三件事：
 *   ① 纯判定规则（"宿主没了"只认 ESRCH；管道断开只认 EPIPE / ERR_STREAM_DESTROYED）；
 *   ② main.js 的接线：两条路（管道守卫 + 宿主探测）都在位、都只经唯一出口、且守卫早于任何一次写；
 *   ③ 宿主侧确实把 pid 注进去了（helper-process.ts 的 spawn 与开发流 start-desktop.mjs），
 *      以及新文件在发布必需清单里（缺了 main.js 启动即崩）。
 *
 * helper 是随包发行的手写 JS，而开发机上跑不起 Electron（受限环境里 Chromium 建不了自己的 Mojo
 * 命名管道），所以接线只能靠源码断言 + 纯函数测试。
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
const { HOST_POLL_MS, parseHostPid, hostIsGone, isBrokenPipeError } = require(helper + 'host-liveness.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('parseHostPid —— 宿主 PID 解析', () => {
  test('正常数字原样返回（含前后空白）', () => {
    assert.equal(parseHostPid('12345'), 12345);
    assert.equal(parseHostPid(' 42 '), 42);
  });

  test('未设 / 空 / 非数字 / 非正数 → 0（调用方据此不做探测）', () => {
    for (const raw of [undefined, null, '', '   ', 'abc', 'abc123', '0', '-7', 'NaN']) {
      assert.equal(parseHostPid(raw as string), 0, 'raw=' + String(raw));
    }
  });
});

describe('hostIsGone —— 只有 ESRCH 才算"宿主没了"', () => {
  test('存活：kill(pid, 0) 正常返回 → false', () => {
    assert.equal(
      hostIsGone(4242, () => undefined),
      false,
    );
  });

  test('只做存在性检查：signal 必须是 0（绝不真给宿主发信号）', () => {
    const calls: Array<[number, number]> = [];
    hostIsGone(4242, (pid: number, signal: number) => {
      calls.push([pid, signal]);
    });
    assert.deepEqual(calls, [[4242, 0]]);
  });

  test('ESRCH → true（进程确实不在了）', () => {
    assert.equal(
      hostIsGone(4242, () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }),
      true,
    );
  });

  test('EPERM / 其它错误码一律当存活（进程在，只是不该由我们动它）', () => {
    for (const code of ['EPERM', 'EINVAL', 'EACCES', 'ECONNREFUSED']) {
      assert.equal(
        hostIsGone(4242, () => {
          throw Object.assign(new Error(code), { code });
        }),
        false,
        'code=' + code,
      );
    }
    // 抛的不是 Error（没有 code）同样不判死
    assert.equal(
      hostIsGone(4242, () => {
        throw 'boom';
      }),
      false,
    );
  });

  test('pid 非法（未注入 / 解析失败）时**绝不**判死——哪怕探测函数说 ESRCH', () => {
    const esrch = () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };
    assert.equal(hostIsGone(0, esrch), false);
    assert.equal(hostIsGone(-1, esrch), false);
    assert.equal(hostIsGone(Number.NaN, esrch), false);
  });
});

describe('isBrokenPipeError —— 只有"管道对端没了"才算', () => {
  test('EPIPE / ERR_STREAM_DESTROYED → true（真机那次就是 EPIPE: broken pipe, write）', () => {
    assert.equal(isBrokenPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true);
    assert.equal(isBrokenPipeError(Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' })), true);
  });

  test('其它错误 / 非 Error / 同名字符串 → false（不能被"长得像"骗到）', () => {
    for (const value of [
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      Object.assign(new Error('invalid'), { code: 'EINVAL' }),
      new Error('no code'),
      'EPIPE',
      null,
      undefined,
    ]) {
      assert.equal(isBrokenPipeError(value), false, String(value));
    }
  });

  test('探测间隔仍是 2s（宿主没了最多 2s 收敛）', () => {
    assert.equal(HOST_POLL_MS, 2000);
  });
});

describe('守卫：main.js 的两条路必须都在位（helper 随包发行，只能读源码断言）', () => {
  const main = readSource(helper + 'main.js');

  test('管道守卫（A）：两条流都挂 error，且断开即走唯一出口', () => {
    assert.ok(/require\('\.\/host-liveness\.js'\)/.test(main), '必须 require host-liveness.js');
    assert.ok(
      /for \(const stream of \[process\.stdout, process\.stderr\]\)/.test(main),
      'stdout 与 stderr 都要挂（两条都是宿主给的管道）',
    );
    assert.ok(/stream\.on\('error'/.test(main), '必须真的挂 error 监听');
    assert.ok(/if \(isBrokenPipeError\(error\)\) exitForDeadHost\(\)/.test(main), '管道断开 = 宿主已死 → 立刻退出');
  });

  test('唯一出口且只退一次：hostGone 去重 + app.exit(0)', () => {
    assert.ok(/let hostGone = false;/.test(main), '必须有去重标记');
    assert.ok(/function exitForDeadHost\(\) \{\s*if \(hostGone\) return;/.test(main), '重复触发只退一次');
    assert.ok(/app\.exit\(0\)/.test(main), '用 app.exit（process.exit 在 Electron 主进程不干净）');
  });

  test('宿主探测（B）：pid 由 env 来，只有 ESRCH 才退，且探测实例不参与', () => {
    assert.ok(
      /const HOST_PID = parseHostPid\(process\.env\.DSH_PET_HOST_PID\)/.test(main),
      'pid 必须来自宿主注入的 env（未注入 → 0 → 不探测）',
    );
    assert.ok(/if \(!DPI_PROBE && HOST_PID > 0\)/.test(main), 'pid 非法或 DPI 探测实例都不起轮询');
    assert.ok(/if \(hostIsGone\(HOST_PID\)\) exitForDeadHost\(\)/.test(main), '判定走纯函数，出口同一个');
    assert.ok(/HOST_POLL_MS/.test(main), '间隔必须是命名常量（来自 host-liveness.js）');
  });

  test('守卫必须早于**任何一次写**（probePrimaryScale 失败就会往 stderr 写）', () => {
    const guardAt = main.indexOf("stream.on('error'");
    const firstWriteAt = main.indexOf('PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();');
    assert.ok(guardAt > 0, '找不到管道守卫');
    assert.ok(firstWriteAt > 0, '找不到 DPI 探测调用点（文件结构变了，请同步本断言）');
    assert.ok(guardAt < firstWriteAt, '管道守卫必须装在任何一次可能写之前');
  });

  test('不许加全局 uncaughtException 处理器（会顶掉 Electron 的行为并吞掉真实崩溃）', () => {
    assert.ok(
      !/process\.on\('uncaughtException'/.test(main),
      '只治"管道断开"这一种，别把真实崩溃一起吞掉——那会让排障更困难',
    );
  });
});

describe('守卫：宿主侧必须把 pid 注入（否则 B 永远不生效）', () => {
  test('helper-process.ts：唯一的 spawn 点经 helperSpawnEnv 注入 DSH_PET_HOST_PID', () => {
    const src = readSource('./helper-process.ts');
    assert.ok(
      /env: helperSpawnEnv\(process\.pid, this\.options\.env\)/.test(src),
      'spawn 的 env 必须经 helperSpawnEnv 注入宿主 pid（放在唯一 spawn 点，所有调用方自动获得）',
    );
  });

  test('helperSpawnEnv：删掉会劫持 Electron 启动模式的 ELECTRON_RUN_AS_NODE（issue #63）', () => {
    const src = readSource('./helper-process.ts');
    assert.ok(
      /delete env\.ELECTRON_RUN_AS_NODE;/.test(src),
      '必须**删键**：宿主（如 DSH Desktop）透传这个变量会让 helper 退化成纯 Node 模式、require("electron") 直接崩',
    );
    assert.ok(
      !/ELECTRON_RUN_AS_NODE: ''/.test(src),
      '不得把它设成空字符串——实测 Electron 43.3.0 下空串会直接 abort（exit 134）',
    );
  });

  test('start-desktop.mjs：开发流同样注入 pid 且同样删掉该变量', () => {
    const src = readSource('../../scripts/start-desktop.mjs');
    assert.ok(/DSH_PET_HOST_PID: String\(process\.pid\)/.test(src), '开发流也要跟随');
    assert.ok(/delete env\.ELECTRON_RUN_AS_NODE;/.test(src), '手动拉起同样要防这个变量（issue #63）');
  });
});

describe('守卫：host-liveness.js 必须在发布必需清单里', () => {
  test('prepack-check.js 的 required 含它（main.js require，缺了会启动即崩）', () => {
    const src = readSource('../../scripts/prepack-check.js');
    assert.ok(/'runtime\/electron-helper\/host-liveness\.js'/.test(src), '漏了它，npm 包里就少一个 main.js 必需的模块');
  });
});
