/**
 * 精选插件 client 半入口的单元测试 —— 钉住判重/让位标记与 slots 注册口径。
 *
 * 为什么要单独钉：featured 入口靠 window 全局标记做跨插件互斥，标记复位时机错了会让
 * 整个 GUI 的 plugins.tab 永久失效；这里用最小桩 ctx 钉四条口径：
 *   ① 非 GUI 环境（无 window）直接不跑；
 *   ② 已置 __DSH_FEATURED_APPLIED__ 不重复注册；
 *   ③ 已置 __DSH_FEATURED_FULL__（完整版已接管）让位不注册，卸载时复位 APPLIED；
 *   ④ 正常路径向 plugins.tab 注册一次，卸载复位标记。
 * 另用 react-dom/server 冒烟渲染 idle 态，确认 locale key 走通。
 *
 * react 在 devDependencies 里，测试进程可静态引入（源码仍只走 factory 注入）。
 * 跑法：node --experimental-strip-types --test src/client/featured-entry.test.ts
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState, useEffect } from 'react';
import { renderToString } from 'react-dom/server';

import { makeFeaturedEntry } from './featured-entry.ts';

const APPLIED = '__DSH_FEATURED_APPLIED__';
const FULL = '__DSH_FEATURED_FULL__';

const deps = { createElement, useState, useEffect };

/** 桩 ctx：locale.bind 翻译成 `${ns}:${key}`，slots 记录注入与注册。 */
function makeStubCtx() {
  const injectedSlots: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- slots.register 的 props 无静态类型
  const registeredTabs: Array<{ props: any; component: unknown }> = [];
  const ctx: Record<string, unknown> = {
    locale: {
      bind: (ns: string) => (key: string) => `${ns}:${key}`,
    },
    slots: {
      inject: (slot: string, register: () => void) => {
        injectedSlots.push(slot);
        register();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- slots.register 的 props 无静态类型
      register: (props: any, component: unknown) => {
        registeredTabs.push({ props, component });
      },
    },
  };
  return { ctx, injectedSlots, registeredTabs };
}

/** 测试里临时补 window 全局（node 环境 typecheck 需要 DOM 声明，运行时没有）。 */
interface WindowStub {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩对齐 GUI window 的弱类型形态
  [key: string]: any;
}

describe('installFeaturedEntry — 环境与判重', () => {
  let originalWindow: WindowStub | undefined;
  let hadWindow = false;

  beforeEach(() => {
    hadWindow = typeof globalThis.window !== 'undefined';
    if (hadWindow) originalWindow = globalThis.window as WindowStub;
    (globalThis as { window?: WindowStub }).window = {};
  });

  afterEach(() => {
    if (hadWindow && originalWindow) {
      (globalThis as { window?: unknown }).window = originalWindow;
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  test('无 window（非 GUI 环境）直接不跑', () => {
    delete (globalThis as { window?: unknown }).window;
    const { ctx, injectedSlots } = makeStubCtx();
    makeFeaturedEntry(deps)(ctx);
    assert.deepEqual(injectedSlots, []);
  });

  test('已置 APPLIED 标记不重复注册', () => {
    const { ctx, injectedSlots } = makeStubCtx();
    (globalThis.window as WindowStub)[APPLIED] = true;
    makeFeaturedEntry(deps)(ctx);
    assert.deepEqual(injectedSlots, []);
  });

  test('FULL 已接管时让位：不注册，卸载复位 APPLIED 且不碰 FULL', () => {
    const { ctx, injectedSlots } = makeStubCtx();
    (globalThis.window as WindowStub)[FULL] = true;
    const disposer = makeFeaturedEntry(deps)(ctx);
    assert.deepEqual(injectedSlots, [], '完整版在场时应让位');
    disposer();
    assert.equal((globalThis.window as WindowStub)[APPLIED], false, '卸载复位判重标记');
    assert.equal((globalThis.window as WindowStub)[FULL], true, 'FULL 标记归完整版，接入方不碰');
  });

  test('正常路径：向 plugins.tab 注册一次，卸载复位标记', () => {
    const { ctx, injectedSlots, registeredTabs } = makeStubCtx();
    const disposer = makeFeaturedEntry(deps)(ctx);
    assert.deepEqual(injectedSlots, ['plugins.tab']);
    assert.equal(registeredTabs.length, 1);
    assert.equal(registeredTabs[0].props.name, 'plugins.tab');
    assert.equal(registeredTabs[0].props.id, 'dsh-plugins-plugin');
    assert.equal(registeredTabs[0].props.label(), 'pet.config:featured.tabLabel');
    assert.equal((globalThis.window as WindowStub)[APPLIED], true);
    disposer();
    assert.equal((globalThis.window as WindowStub)[APPLIED], false, '卸载必须复位，否则重装被误判');
    assert.deepEqual(injectedSlots, ['plugins.tab'], '桩不模拟注销，不影响断言');
  });
});

describe('FeaturedSection 组件冒烟', () => {
  let originalWindow: WindowStub | undefined;
  let hadWindow = false;

  beforeEach(() => {
    hadWindow = typeof globalThis.window !== 'undefined';
    if (hadWindow) originalWindow = globalThis.window as WindowStub;
    (globalThis as { window?: WindowStub }).window = {};
  });

  afterEach(() => {
    if (hadWindow && originalWindow) {
      (globalThis as { window?: unknown }).window = originalWindow;
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  test('idle 态渲染 desc/welcome/installFull 三个 locale key', () => {
    const { ctx, registeredTabs } = makeStubCtx();
    makeFeaturedEntry(deps)(ctx);
    const component = registeredTabs[0].component;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 组件工厂无静态类型
    const html = renderToString((createElement as any)(component, { install: () => () => {} }));
    assert.ok(html.includes('pet.config:featured.desc'), 'desc 文案应渲染');
    assert.ok(html.includes('pet.config:featured.welcome'), 'welcome 文案应渲染');
    assert.ok(html.includes('pet.config:featured.installFull'), '安装按钮文案应渲染');
  });
});
