/**
 * 站点入口解析的单元测试（旧版连接服务、新版入口事件、无入口提供者三条路径）。
 *
 * 钉住的不变式：
 *   - 旧方法存在时必须原样调用，且接收者仍是 `connection`（改写成解构调用就会失配）；
 *   - 新事件必须以 `webServer` 为 subject 同步分发，监听器按 push 顺序贡献入口；
 *   - 只取第一个 `open` 的入口；没有入口提供者或全是展示用入口时原样返回站点地址；
 *   - `connection` 整体缺失时走事件路径，不抛错。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/desktop/site-url.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDesktopSiteUrl } from './site-url.ts';

const ORIGIN = 'http://127.0.0.1:8123';

describe('resolveDesktopSiteUrl —— 站点入口解析', () => {
  test('旧版连接方法：接收者不变，直接用原入口', () => {
    const connection = {
      authenticatedUrl(origin: string) {
        assert.equal(this, connection);
        assert.equal(origin, ORIGIN);
        return `${origin}/?token=test-only`;
      },
    };
    assert.equal(resolveDesktopSiteUrl({ connection }, ORIGIN), `${ORIGIN}/?token=test-only`);
  });

  test('独立模式：沿用设置页入口', () => {
    const ctx = { connection: { authenticatedUrl: () => `${ORIGIN}/standalone-ai/` } };
    assert.equal(resolveDesktopSiteUrl(ctx, ORIGIN), `${ORIGIN}/standalone-ai/`);
  });

  test('新版事件：以 webServer 为 subject 同步收集入口', () => {
    const webServer = {};
    const ctx = {
      connection: {},
      webServer,
      emit(scope: unknown, event: string, origin: string, entries: { url: string; open: boolean }[]) {
        assert.equal(this, ctx);
        assert.equal(scope, webServer);
        assert.equal(event, 'webserver/entry-url');
        assert.equal(origin, ORIGIN);
        entries.push({ url: `${origin}/?token=test-only`, open: true });
      },
    };
    assert.equal(resolveDesktopSiteUrl(ctx, ORIGIN), `${ORIGIN}/?token=test-only`);
  });

  test('入口顺序：取第一个 open 的地址，跳过 open:false', () => {
    const ctx = {
      connection: {},
      emit(_scope: unknown, _event: string, origin: string, entries: { url: string; open: boolean }[]) {
        entries.push(
          { url: `${origin}/hidden`, open: false },
          { url: `${origin}/?token=first`, open: true },
          { url: `${origin}/?token=second`, open: true },
        );
      },
    };
    assert.equal(resolveDesktopSiteUrl(ctx, ORIGIN), `${ORIGIN}/?token=first`);
  });

  test('无入口提供者：原样返回站点地址', () => {
    assert.equal(resolveDesktopSiteUrl({ connection: {}, emit() {} }, ORIGIN), ORIGIN);
  });

  test('仅有展示入口：原样返回站点地址', () => {
    const ctx = {
      connection: {},
      emit(_scope: unknown, _event: string, origin: string, entries: { url: string; open: boolean }[]) {
        entries.push({ url: `${origin}/hidden`, open: false });
      },
    };
    assert.equal(resolveDesktopSiteUrl(ctx, ORIGIN), ORIGIN);
  });

  test('connection 缺失：不抛错，仍走入口事件', () => {
    const ctx = {
      emit(_scope: unknown, _event: string, origin: string, entries: { url: string; open: boolean }[]) {
        entries.push({ url: `${origin}/?token=test-only`, open: true });
      },
    };
    assert.equal(resolveDesktopSiteUrl(ctx, ORIGIN), `${ORIGIN}/?token=test-only`);
  });
});
