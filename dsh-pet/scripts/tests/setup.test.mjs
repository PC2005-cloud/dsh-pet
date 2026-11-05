// Chromium exercises the shipped setup form; controlled HTTP replies do not claim a real model/backend run.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

let browser, server, origin, submitted, state;
before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('../../src/standalone/settings-page.ts', import.meta.url)),
    platform: 'node',
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  const assets = await import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'));
  server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/standalone-ai/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(assets.settingsPage);
    } else if (req.url === '/standalone-ai/settings.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(assets.settingsScript);
    } else if (req.url === '/standalone-ai/settings.css') {
      res.setHeader('content-type', 'text/css');
      res.end(assets.settingsStyle);
    } else if (req.url === '/standalone-ai/chat-panel.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('');
    } else if (req.url === '/standalone-ai/setup') {
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        submitted.push(body);
        state = {
          stage: 'ready',
          message: '可以开始聊天了。',
          busy: false,
          chatReady: true,
          memoryReady: !!body.memory,
          configured: !!body.memory,
        };
        res.statusCode = 202;
      }
      res.end(JSON.stringify(state));
    } else if (req.url === '/standalone-ai/settings')
      res.end(JSON.stringify({ protocol: 'openai-compatible', hasKey: false }));
    else if (req.url === '/dsh-pet-7340/config')
      res.end(
        JSON.stringify({
          main: {
            pets: [
              {
                id: 'main',
                name: 'Blue',
                display: 'web',
                size: 240,
                balanceEnabled: false,
                position: { corner: 'bottom-right', marginX: 20, marginY: 20 },
              },
            ],
          },
        }),
      );
    else res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

for (const memory of [false, true])
  test(`first-run form requires an explicit start; memory=${memory}`, async (t) => {
    submitted = [];
    state = {
      stage: 'idle',
      message: '填写模型信息，开始养鱼。',
      busy: false,
      chatReady: false,
      memoryReady: false,
      configured: false,
    };
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(origin + '/standalone-ai/#token=synthetic-page-token');
    await page.locator('#panel-setup').waitFor({ state: 'visible' });
    assert.equal(page.url().includes('#'), false);
    assert.equal(await page.locator('#setup-memory').isChecked(), false);
    assert.equal(submitted.length, 0);
    await page.locator('#setup-url').fill('https://models.example/v1');
    await page.locator('#setup-key').fill('synthetic-form-key');
    if (memory) await page.locator('#setup-memory').check();
    await page.locator('#setup-start').click();
    await page.locator('#setup-chat').waitFor({ state: 'visible' });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].memory, memory);
    assert.equal(submitted[0].apiKey, 'synthetic-form-key');
    assert.equal(await page.locator('#setup-key').inputValue(), '');
    assert.equal(await page.locator('#setup-embedding-key').inputValue(), '');
    if (memory) {
      assert.equal(submitted[0].embeddingBaseUrl, submitted[0].baseUrl);
      assert.equal(submitted[0].embeddingApiKey, submitted[0].apiKey);
      assert.equal(submitted[0].embeddingDimension, 1024);
      await page.locator('#setup-stop').click();
      await page.waitForFunction(() => document.querySelector('#setup-stop').hidden);
      assert.deepEqual(submitted[1], { action: 'stop' });
    } else assert.equal('embeddingApiKey' in submitted[0], false);
    await page.locator('#setup-chat').click();
    assert.equal(await page.locator('#tab-chat').getAttribute('aria-selected'), 'true');
  });
