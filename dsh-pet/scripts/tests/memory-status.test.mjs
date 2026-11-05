// The real React indicator against controlled HTTP responses; no extraction-quality claim.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';
const require = createRequire(import.meta.url);
let server, browser, origin;
before(async () => {
  const code = `import React from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { makeMemoryStatus } from ${JSON.stringify(fileURLToPath(new URL('../../src/client/chat/memory-status.ts', import.meta.url)))};
const Indicator = makeMemoryStatus({ h: React.createElement, useState: React.useState, useEffect: React.useEffect });
const root = createRoot(document.getElementById('root'));
window.showPet = (petId, revision = 0) => root.render(React.createElement(Indicator, { petId, revision }));
window.showPet('main');`;
  const bundle = await rolldown({
    input: 'virtual:indicator',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'indicator-entry',
        resolveId: (id) => (id === 'virtual:indicator' ? id : null),
        load: (id) => (id === 'virtual:indicator' ? code : null),
      },
    ],
  });
  const { output } = await bundle.generate({ format: 'iife' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<button id="tab-setup">设置</button><div id="panel-chat"><div id="root"></div></div><script src="/app.js"></script>',
      );
    } else if (req.url === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(output[0].code);
    } else {
      res.setHeader('content-type', 'application/json');
      const pet = new URL(req.url, 'http://localhost').searchParams.get('pet');
      res.end(
        JSON.stringify(
          req.url === '/standalone-ai/setup'
            ? { configured: true, memoryEnabled: false, memoryRunning: false, memoryReady: false }
            : pet === 'main'
              ? { ok: true, backend: 'powercontext', captured: 12, pending: 2, recall: 'ready' }
              : { ok: true, backend: 'native', captured: 0, pending: 0, recall: 'not_run' },
        ),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('chat distinguishes delivery, recall and local service state and opens memory settings', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(origin);
  await page.getByText(/已同步 12 轮/).waitFor();
  assert.match(await page.locator('.pet-chat-memory-status').textContent(), /最近召回到相关记忆/);
  assert.match(await page.locator('.pet-chat-memory-status').textContent(), /本机记忆服务：已暂停/);
  assert.match(await page.locator('.pet-chat-memory-status').textContent(), /不代表已整理/);
  await page.evaluate(
    () =>
      (document.getElementById('tab-setup').onclick = () => {
        window.openedSettings = true;
      }),
  );
  await page.getByRole('button', { name: '记忆设置' }).click();
  assert.equal(await page.evaluate(() => window.openedSettings), true);
});

test('switching pets clears the old memory status while the new request is pending', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(origin);
  await page.getByText(/已同步 12 轮/).waitFor();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/chat/powercontext?pet=second', async (route) => {
    await pending;
    await route.continue();
  });
  await page.evaluate(() => window.showPet('second'));
  await page.getByText('正在读取这只宠物的记忆状态…').waitFor();
  assert.doesNotMatch(await page.locator('.pet-chat-memory-status').textContent(), /已同步 12|最近召回/);
  release();
  await page.getByText('当前宠物使用近期对话，长期记忆未开启。').waitFor();
});
