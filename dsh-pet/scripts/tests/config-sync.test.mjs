// Separate browser pages, real host routes and isolated configuration files.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const prefix = '/dsh-pet-7340';
const previousHome = process.env.DSH_HOME;
const previousInProcess = process.env.DSH_PET_IN_PROCESS;
let dir, server, browser, base;
const disposers = [];

before(async () => {
  dir = mkdtempSync(join(root, 'node_modules', '.config-sync-'));
  mkdirSync(join(dir, 'assets'));
  copyFileSync(join(root, 'assets/config.jsonc'), join(dir, 'assets/config.jsonc'));
  process.env.DSH_HOME = join(dir, 'home');
  // This test exercises browser propagation; no Electron process or download is needed.
  process.env.DSH_PET_IN_PROCESS = '1';
  const host = await rolldown({
    input: join(root, 'src/host/index.ts'),
    platform: 'node',
    external: (id) => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Z]:/i.test(id),
  });
  const hostFile = join(dir, 'lib/index.mjs');
  await host.write({ file: hostFile, format: 'esm' });
  await host.close();
  const client = await rolldown({
    input: fileURLToPath(new URL('./config-sync.fixture.js', import.meta.url)),
    platform: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  const { output } = await client.generate({ format: 'iife' });
  await client.close();
  let handler;
  const noop = () => {};
  const { apply } = await import(pathToFileURL(hostFile).href);
  apply({
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    provide: () => noop,
    on: () => noop,
    commands: { register: () => noop },
    webServer: {
      register: (route) => {
        handler = route.handler;
        return noop;
      },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    llm: { listProviders: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: '', model: '' }) },
    credentials: { resolve: async () => undefined },
  });
  server = createServer((req, res) => {
    if (req.url.startsWith(prefix)) return void handler(req, res);
    if (req.url === '/fixture.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(output[0].code);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  for (const dispose of disposers.reverse()) dispose();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  if (previousInProcess === undefined) delete process.env.DSH_PET_IN_PROCESS;
  else process.env.DSH_PET_IN_PROCESS = previousInProcess;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('saving settings in another page updates the existing overlay', async () => {
  const overlay = await browser.newPage();
  const settings = await browser.newPage();
  try {
    await overlay.goto(base);
    await overlay.locator('.dsh-pet-root').first().waitFor();
    await settings.goto(`${base}/settings`);
    await settings.getByRole('button', { name: 'Save', exact: true }).first().waitFor();
    const display = settings.locator('select').filter({ has: settings.locator('option[value="desktop"]') });
    await display.selectOption('desktop');
    const saved = settings.waitForResponse(
      (res) => res.url().endsWith(`${prefix}/config`) && res.request().method() === 'PUT',
    );
    await settings.getByRole('button', { name: 'Save', exact: true }).first().click();
    assert.equal((await saved).status(), 200);
    const disk = JSON.parse(readFileSync(join(dir, 'home/dsh-pet/main-config.jsonc'), 'utf8'));
    assert.equal(disk.pets[0].display, 'desktop');
    const effective = await (await fetch(`${base}${prefix}/config`)).json();
    assert.equal(effective.main.pets[0].display, 'desktop');
    await overlay.locator('.dsh-pet-root').waitFor({ state: 'detached', timeout: 3000 });
    const reset = await fetch(`${base}${prefix}/config`, { method: 'POST' });
    assert.equal(reset.status, 200);
    await overlay.locator('.dsh-pet-root').first().waitFor({ timeout: 3000 });
  } finally {
    await settings.close();
    await overlay.close();
  }
});

test('rejected saves do not notify other pages or overwrite configuration', async () => {
  const file = join(dir, 'home/dsh-pet/main-config.jsonc');
  const original = readFileSync(file, 'utf8');
  const config = await (await fetch(`${base}${prefix}/config`)).json();
  const before = await (await fetch(`${base}${prefix}/state`)).json();
  const put = (body) => fetch(`${base}${prefix}/config`, { method: 'PUT', body: JSON.stringify(body) });
  assert.equal((await put({ pets: [{ id: 'main', display: 'desktop' }] })).status, 400);
  assert.equal(readFileSync(file, 'utf8'), original);
  try {
    writeFileSync(file, '{ broken');
    assert.equal((await put({ pets: config.main.pets })).status, 409);
    assert.equal(readFileSync(file, 'utf8'), '{ broken');
    const after = await (await fetch(`${base}${prefix}/state`)).json();
    assert.deepEqual(after.sections.config, before.sections.config);
  } finally {
    writeFileSync(file, original);
  }
});
