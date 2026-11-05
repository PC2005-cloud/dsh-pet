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
          ...state,
          stage: 'ready',
          message: '可以开始聊天了。',
          busy: false,
          chatReady: true,
          memoryReady: !!body.memory,
          configured: !!body.memory || body.action === 'stop',
          memoryEnabled: !!body.memory,
          memoryRunning: !!body.memory,
          canRetry: !!body.memory || body.action === 'stop',
        };
        if (body.action === 'stop') Object.assign(state, { stage: 'stopped', message: '记忆已暂停，数据保留。' });
        if (body.action === 'retry')
          Object.assign(state, { memoryReady: true, memoryRunning: true, memoryEnabled: true, configured: true });
        if (body.action === 'cancel')
          Object.assign(state, { stage: 'cancelled', message: '已取消准备，已有记忆保留。' });
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
      assert.equal(submitted[0].embeddingApiKey, ''); // The server resolves same-endpoint credentials without round-tripping keys.
      assert.equal(submitted[0].embeddingDimension, 1024);
      await page.locator('#setup-stop').click();
      await page.waitForFunction(() => document.querySelector('#setup-stop').hidden);
      assert.deepEqual(submitted[1], { action: 'stop' });
    } else assert.equal('embeddingApiKey' in submitted[0], false);
    await page.locator('#setup-chat').click();
    assert.equal(await page.locator('#tab-chat').getAttribute('aria-selected'), 'true');
  });

const savedChat = {
  protocol: 'openai-compatible',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'saved-chat-model',
  hasKey: true,
};
function savedState(enabled = false) {
  return {
    stage: enabled ? 'ready' : 'stopped',
    busy: false,
    message: '已有聊天配置',
    chatReady: true,
    chat: savedChat,
    memoryEnabled: enabled,
    memoryRunning: enabled,
    memoryReady: enabled,
    configured: true,
    canRetry: true,
    models: { embeddingBaseUrl: savedChat.baseUrl, embeddingModel: 'saved-embedding', embeddingDimension: 1024 },
  };
}
async function setupPage(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(origin + '/standalone-ai/#token=synthetic-page-token');
  await page.locator('#tab-setup').click();
  await page.waitForFunction(() => document.querySelector('#setup-status').textContent.length > 0);
  return page;
}

test('saved chat can enable memory without re-entering or returning keys', async (t) => {
  submitted = [];
  state = savedState();
  const page = await setupPage(t);
  assert.equal(await page.locator('#setup-reuse').isChecked(), true);
  assert.equal(await page.locator('#setup-key').isDisabled(), true);
  assert.equal(await page.locator('#setup-url').inputValue(), savedChat.baseUrl);
  assert.equal(await page.locator('#setup-model').inputValue(), savedChat.model);
  await page.locator('#setup-memory').check();
  await page.locator('#setup-start').click();
  await page.waitForFunction(() => document.querySelector('#setup-checks').textContent.includes('服务已就绪'));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].apiKey, '');
  assert.equal(submitted[0].embeddingApiKey, '');
  assert.equal(submitted[0].model, savedChat.model);
  assert.equal(submitted[0].embeddingModel, 'saved-embedding');
});

test('pause, reload and resume show the persisted enabled state', async (t) => {
  submitted = [];
  state = savedState(true);
  const page = await setupPage(t);
  await page.locator('#setup-stop').click();
  await page.waitForFunction(() => document.querySelector('#setup-stop').hidden);
  await page.reload();
  await page.locator('#tab-setup').click();
  await page.locator('#setup-retry').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#setup-memory').isChecked(), false);
  assert.equal(await page.locator('#setup-stop').isVisible(), false);
  assert.equal(await page.locator('#setup-retry').textContent(), '恢复记忆');
  await page.locator('#setup-retry').click();
  await page.locator('#setup-stop').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#setup-memory').isChecked(), true);
  assert.deepEqual(submitted, [{ action: 'stop' }, { action: 'retry' }]);
});

test('region presets fill endpoints and clear a key from the previous region', async (t) => {
  submitted = [];
  state = { stage: 'idle', busy: false, chatReady: false, message: '开始养鱼' };
  const page = await setupPage(t);
  assert.equal(await page.locator('#setup-model-details').getAttribute('open'), null);
  await page.locator('#setup-key').fill('beijing-only-key');
  await page.locator('#setup-region').selectOption('singapore');
  assert.equal(await page.locator('#setup-url').inputValue(), 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  assert.equal(await page.locator('#setup-key').inputValue(), '');
  await page.locator('#setup-provider').selectOption('openai');
  assert.equal(await page.locator('#setup-url').inputValue(), 'https://api.openai.com/v1');
  assert.equal(await page.locator('#setup-dimension').inputValue(), '1536');
  await page.locator('#setup-provider').selectOption('custom');
  assert.equal(await page.locator('#setup-model-details').getAttribute('open'), '');
  assert.equal(submitted.length, 0);
});

test('installation shows its stage, permits chatting and can be cancelled', async (t) => {
  submitted = [];
  state = {
    ...savedState(false),
    configured: false,
    models: undefined,
    stage: 'installing_python',
    message: '正在准备本机 Python 环境…',
    busy: true,
    canCancel: true,
    startedAt: Date.now() - 4000,
  };
  const page = await setupPage(t);
  assert.equal(await page.locator('#setup-start').isDisabled(), true);
  assert.match(await page.locator('#setup-status').textContent(), /Python/);
  assert.match(await page.locator('#setup-elapsed').textContent(), /已等待/);
  assert.equal(await page.locator('#setup-steps [aria-current="step"]').count(), 1);
  await page.locator('#setup-chat').click();
  assert.equal(await page.locator('#tab-chat').getAttribute('aria-selected'), 'true');
  await page.locator('#tab-setup').click();
  await page.locator('#setup-cancel').click();
  await page.waitForFunction(() => document.querySelector('#setup-cancel').hidden);
  assert.match(await page.locator('#setup-status').textContent(), /已取消/);
  assert.deepEqual(submitted, [{ action: 'cancel' }]);
});

test('an initial status failure recovers with the saved chat and correct controls', async (t) => {
  submitted = [];
  state = savedState(false);
  const page = await browser.newPage();
  t.after(() => page.close());
  let requests = 0;
  await page.route('**/standalone-ai/setup', (route) => {
    if (++requests === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.goto(origin + '/standalone-ai/#token=synthetic-page-token');
  await page.locator('#tab-setup').click();
  await page.locator('#setup-retry').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page.locator('#setup-reuse').isChecked(), true);
  assert.equal(await page.locator('#setup-url').inputValue(), savedChat.baseUrl);
  assert.equal(await page.locator('#setup-retry').isEnabled(), true);
  assert.equal(await page.locator('#setup-memory').isChecked(), false);
});
