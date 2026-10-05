/**
 * desktop-raise 单元测试 —— 桌面窗口前置（点击系统通知 → POST /raise）的两条关键约束：
 *   1. spawn 必须走 desktopSpawnEnv：宿主是 Electron 应用，`ELECTRON_RUN_AS_NODE` 透传会让拉起的
 *      `DeepSeek Harness.exe` 以纯 Node 模式启动、把 `dsh://open` 当成模块名 require 后当场崩掉
 *      （与 issue #63 同一类坑，症状是"点了通知完全没反应"）；
 *   2. handler 里的 `/raise` 路由必须在位且只认 POST（浏览器半侧点击通知时调它）。
 * 纯函数直接断言，spawn / 路由用源码守卫 —— 与 helper-process.test.ts、host-liveness.test.ts 同一写法。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖：
 *   node --experimental-strip-types --test src/host/desktop-raise.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { desktopSpawnEnv } from './desktop-raise';

const src = readFileSync(new URL('./desktop-raise.ts', import.meta.url), 'utf8');
const hostSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

describe('desktopSpawnEnv —— spawn 环境构造（host 是 Electron 宿主，必须删键）', () => {
  test('删除 ELECTRON_RUN_AS_NODE（不是置空串：设空串会让 Electron 直接 abort）', () => {
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const env = desktopSpawnEnv();
      assert.equal('ELECTRON_RUN_AS_NODE' in env, false, '必须删键');
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = saved;
    }
  });

  test('只产出副本：不改写宿主自己的 process.env', () => {
    const saved = process.env.DSH_PET_RAISE_MARKER;
    process.env.DSH_PET_RAISE_MARKER = 'from-host';
    try {
      assert.equal(desktopSpawnEnv().DSH_PET_RAISE_MARKER, 'from-host');
      assert.equal(process.env.DSH_PET_RAISE_MARKER, 'from-host');
    } finally {
      if (saved === undefined) delete process.env.DSH_PET_RAISE_MARKER;
      else process.env.DSH_PET_RAISE_MARKER = saved;
    }
  });
});

describe('守卫：spawn 与路由必须按契约在位', () => {
  test('spawn 调用带 env: desktopSpawnEnv()（防回退成继承宿主环境）', () => {
    assert.ok(
      /spawn\('cmd\.exe',[\s\S]{0,300}?env: desktopSpawnEnv\(\)/.test(src),
      'spawn 必须显式传 env: desktopSpawnEnv()，否则拉起的 exe 会以 Node 模式当场崩掉',
    );
    assert.ok(/delete env\.ELECTRON_RUN_AS_NODE;/.test(src), '删键那行不能被删掉');
  });

  test('只认 Windows：非 win32 直接返回 false，不起进程', () => {
    assert.ok(/process\.platform !== 'win32'/.test(src), '非 Windows 必须短路');
  });

  test('/raise 路由存在、只认 POST，并调用 raiseDesktopWindow', () => {
    const block = /if \(rest === 'raise'\)[\s\S]{0,400}?\n {4}\}/.exec(hostSrc)?.[0] ?? '';
    assert.ok(block.length > 0, 'handler 里找不到 /raise 路由');
    assert.ok(/method !== 'POST'/.test(block), '/raise 只应接受 POST');
    assert.ok(/raiseDesktopWindow\(\)/.test(block), '/raise 必须调用 raiseDesktopWindow');
  });
});
