// Offline Chromium recommendations: all installation requests are intercepted.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

const addon = {
  id: 10,
  name: 'Quest helper',
  summary: 'Find quest NPCs',
  websiteUrl: 'https://www.curseforge.com/wow/addons/quest-helper',
  downloadCount: 1000,
  relevance: 100,
  fileId: 20,
  fileVersion: '12.0-release',
  gameVersions: ['12.0'],
  installable: true,
  unavailableReason: null,
};
let browser, server, url;
before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./wow-chat.fixture.js', import.meta.url)),
    platform: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  const { output } = await bundle.generate({ format: 'iife' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(output[0].code);
    }
    const report = {
      kind: 'wow-addon-recommendations',
      version: 1,
      id: 'report-1',
      game: 'retail',
      query: req.url === '/english' ? 'quest addons' : '任务插件',
      versionTypeId: 1,
      versionName: 'Retail branch',
      createdAt: Date.now(),
      expiresAt: req.url === '/expired' ? 0 : Date.now() + 600000,
      addons: [
        addon,
        {
          ...addon,
          id: 11,
          name: 'Unavailable helper',
          installable: false,
          unavailableReason: 'curseforge-distribution-disabled',
        },
      ],
    };
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<html><head><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#555;--dsw-alias-border-l2:#ccc}</style></head><body><div id="root"></div><script>window.report=${JSON.stringify(report)}</script><script src="/fixture.js"></script></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function open(t, path = '/', reply = () => ({ ok: true, data: {} }), region = '魔兽插件推荐') {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const writes = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/dsh-pet-7340/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404 });
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: await reply(writes.length) });
  });
  await page.goto(url + path);
  await page.getByRole('region', { name: region }).waitFor();
  return { page, writes };
}

test('history renders project, compatibility and availability, installation requires one explicit click', async (t) => {
  const { page, writes } = await open(t);
  assert.equal(writes.length, 0);
  assert.equal(
    await page.getByRole('link', { name: '查看 CurseForge 项目' }).first().getAttribute('href'),
    addon.websiteUrl,
  );
  await page.getByText('文件：12.0-release · 兼容版本：12.0', { exact: true }).first().waitFor();
  assert.equal(
    await page.getByRole('button', { name: '安装推荐：Unavailable helper', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '安装推荐：Quest helper', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '安装完成' }).waitFor();
  assert.deepEqual(writes, [
    { action: 'addons.installRecommendation', game: 'retail', data: { recommendationId: 'report-1', modId: 10 } },
  ]);
  assert.equal(await page.getByRole('button', { name: '安装推荐：Quest helper', exact: true }).isDisabled(), true);
});

test('expired persisted report disables all installation buttons without issuing requests', async (t) => {
  const { page, writes } = await open(t, '/expired');
  await page.getByText('推荐已过期，请重新向精灵请求推荐。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '安装推荐：Quest helper', exact: true }).isDisabled(), true);
  assert.equal(writes.length, 0);
});

test('host installation rejection is shown and retry remains an explicit user action', async (t) => {
  const { page, writes } = await open(t, '/', (count) =>
    count === 1 ? { ok: false, error: 'wow-addons-recommendation-expired' } : { ok: true, data: {} },
  );
  await page.getByRole('button', { name: '安装推荐：Quest helper', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'wow-addons-recommendation-expired' }).waitFor();
  assert.equal(writes.length, 1);
  await page.getByRole('button', { name: '安装推荐：Quest helper', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '安装完成' }).waitFor();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  await page.evaluate(() => window.disposeWowChat());
});

test('English recommendation requests receive English labels and installation feedback', async (t) => {
  const { page, writes } = await open(t, '/english', undefined, 'Warcraft addon recommendations');
  await page.getByText('File: 12.0-release · Compatible versions: 12.0', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Install recommendation: Quest helper', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Installation completed' }).waitFor();
  assert.equal(writes.length, 1);
});
