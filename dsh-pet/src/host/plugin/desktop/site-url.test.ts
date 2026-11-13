/** 桌面站点入口兼容测试：旧版连接、新版事件与未配置认证的宿主。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDesktopSiteUrl } from './site-url.ts';

const ORIGIN = 'http://127.0.0.1:8123';

test('旧版连接方法保持接收者，继续使用原有入口', () => {
  const connection = {
    authenticatedUrl(origin: string) {
      assert.equal(this, connection);
      assert.equal(origin, ORIGIN);
      return `${origin}/?token=test-only`;
    },
  };
  assert.equal(resolveDesktopSiteUrl({ connection }, ORIGIN), `${ORIGIN}/?token=test-only`);
});

test('独立模式保留设置页入口', () => {
  const ctx = { connection: { authenticatedUrl: () => `${ORIGIN}/standalone-ai/` } };
  assert.equal(resolveDesktopSiteUrl(ctx, ORIGIN), `${ORIGIN}/standalone-ai/`);
});

test('新版通过 webServer 作用域同步收集认证插件贡献的入口', () => {
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

test('遵循宿主入口顺序，跳过禁止自动打开的地址', () => {
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

test('没有入口提供者时仍返回站点地址', () => {
  assert.equal(resolveDesktopSiteUrl({ connection: {}, emit() {} }, ORIGIN), ORIGIN);
});

test('仅有展示用入口时返回站点地址', () => {
  const ctx = {
    connection: {},
    emit(_scope: unknown, _event: string, origin: string, entries: { url: string; open: boolean }[]) {
      entries.push({ url: `${origin}/hidden`, open: false });
    },
  };
  assert.equal(resolveDesktopSiteUrl(ctx, ORIGIN), ORIGIN);
});
