// Chromium fixture only: no game, user settings, API key or external API is touched.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

const profile = {
  game: 'retail',
  settings: { enabled: true, cooldownSeconds: 20 },
  bridge: {
    status: 'live',
    source: 'screen',
    ageSeconds: 1,
    config: { x: 0, y: 0, cellSize: 3, pollMs: 500, paused: false },
    snapshot: {
      name: '游侠',
      realm: '艾泽拉斯',
      level: 80,
      class: 'HUNTER',
      px: 0,
      py: 5000,
      map: 123,
      zone: '测试区域',
      copper: 123456,
      online: true,
    },
  },
  gold: { accounts: [] },
  equipmentHistory: { entries: [] },
  levelHistory: { characters: [] },
  equipmentComparisons: { entries: [] },
  equipmentLoadouts: { entries: [] },
};
const initialState = {
  profiles: { retail: profile, forever: { ...profile, game: 'forever' } },
  appearance: {
    selectedPetId: '',
    resolvedPetId: 'main',
    options: [
      { id: 'main', name: '蓝色陪伴精灵', entry: 'main', builtin: true, avatarRoot: 'main' },
      { id: 'twilight-elf-1', name: '暮影', entry: 'twilight-elf', builtin: false, avatarRoot: 'twilight-elf' },
    ],
  },
  settings: { activeGame: 'retail', locale: 'zh-CN', petId: 'pet-1', eventNotifications: true, muted: false },
  launcher: {
    supported: true,
    defaultTarget: 'battle-net',
    paths: { 'battle-net': '', retail: '', forever: '', classic: '' },
  },
  screen: { settings: { enabled: false, game: 'retail', cooldownMs: 5000 } },
  addons: {
    hasApiKey: true,
    clients: {
      retail: { directory: 'D:\\WoW\\_retail_', gameVersionTypeId: 1 },
      forever: { directory: 'D:\\WoW\\_forever_', gameVersionTypeId: 2 },
      classic: { directory: '', gameVersionTypeId: null },
    },
  },
};
let browser, server, url;
before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./wow-panel.fixture.js', import.meta.url)),
    platform: 'browser',
  });
  const { output } = await bundle.generate({ format: 'iife' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(output[0].code);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<html lang="zh-CN"><head><style>:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#555;--dsw-alias-border-l2:#ccc}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
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

async function open(t, action = () => ({ ok: true }), override = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const requests = [],
    errors = [];
  const state = { ...structuredClone(initialState), ...override };
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/dsh-pet-7340/wow/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: state });
    const payload = request.postDataJSON();
    requests.push(payload);
    if (payload.action === 'preferences.save') Object.assign(state.settings, payload.data);
    if (payload.action === 'appearance.select') {
      state.appearance.selectedPetId = payload.data.petId;
      state.appearance.resolvedPetId = payload.data.petId || 'main';
      return route.fulfill({ json: state.appearance });
    }
    const result = await action(payload, state);
    return route.fulfill({ json: result });
  });
  await page.goto(url);
  await page.getByRole('status').filter({ hasText: '已连接本机' }).waitFor();
  return { page, requests, state };
}

test('version and language preferences keep Classic honest and preserve the pet binding', async (t) => {
  const { page, requests } = await open(t);
  assert.match(await page.locator('.dsh-wow').innerText(), /0.00%, 50.00%/);
  await page.getByLabel('游戏分区', { exact: true }).selectOption('classic');
  await page.getByRole('button', { name: '应用版本与语言' }).click();
  await page.getByText('怀旧服没有实时采集档案。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '金币账本', exact: true }).count(), 0);
  assert.deepEqual(requests[0], {
    action: 'preferences.save',
    game: 'classic',
    data: {
      activeGame: 'classic',
      locale: 'zh-CN',
      petId: 'pet-1',
      eventNotifications: true,
      muted: false,
    },
  });
  await page.getByLabel('界面与社区语言').selectOption('en');
  await page.getByRole('button', { name: '应用版本与语言' }).click();
  await page.getByRole('heading', { name: 'Warcraft companion', exact: true }).waitFor();
  assert.match(await page.locator('.dsh-wow').innerText(), /Classic has no live capture profile/);
});

test('companion appearance defaults to the original and only applies an installed choice explicitly', async (t) => {
  const { page, requests, state } = await open(t);
  const select = page.getByLabel('选择陪伴形象', { exact: true });
  assert.equal(await select.inputValue(), '');
  assert.equal(await select.locator('option:checked').innerText(), 'dsh-pet 原有形象（默认）');
  assert.match(await page.getByRole('img', { name: '陪伴形象预览', exact: true }).getAttribute('src'), /root=main/);
  await page.evaluate(() => {
    window.appearanceChanges = 0;
    window.addEventListener('dsh-pet-appearance-changed', () => window.appearanceChanges++);
  });
  await select.selectOption('twilight-elf-1');
  assert.match(
    await page.getByRole('img', { name: '陪伴形象预览', exact: true }).getAttribute('src'),
    /root=twilight-elf/,
  );
  await page.getByText('仅预览；点击“应用陪伴形象”后生效。', { exact: true }).waitFor();
  assert.equal(requests.length, 0);
  // Ordinary live-state polling must not turn an unapplied preview back into the persisted default.
  await page.waitForTimeout(3300);
  assert.equal(await select.inputValue(), 'twilight-elf-1');
  assert.equal(requests.length, 0);
  await page.getByRole('button', { name: '应用陪伴形象', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '陪伴形象已应用' }).waitFor();
  assert.deepEqual(requests.at(-1), { action: 'appearance.select', game: 'retail', data: { petId: 'twilight-elf-1' } });
  await page.getByText('当前陪伴形象：暮影', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.appearanceChanges), 1);
  const reopened = await open(t, undefined, { appearance: structuredClone(state.appearance) });
  assert.equal(await reopened.page.getByLabel('选择陪伴形象', { exact: true }).inputValue(), 'twilight-elf-1');
  assert.equal(reopened.requests.length, 0);
  await reopened.page.getByLabel('选择陪伴形象', { exact: true }).selectOption('');
  await reopened.page.getByRole('button', { name: '应用陪伴形象', exact: true }).click();
  await reopened.page.getByRole('status').filter({ hasText: '陪伴形象已应用' }).waitFor();
  assert.deepEqual(reopened.requests.at(-1).data, { petId: '' });
  await reopened.page.getByText('当前陪伴形象：dsh-pet 原有形象（默认）', { exact: true }).waitFor();
});

test('appearance stays original when no custom pack is installed and the controls support English', async (t) => {
  const { page, requests } = await open(t, undefined, {
    appearance: { selectedPetId: '', resolvedPetId: 'main', options: [] },
  });
  assert.equal(await page.getByLabel('选择陪伴形象', { exact: true }).locator('option').count(), 1);
  await page
    .getByText('尚未安装其它宠物形象。安装兼容的 dsh-pet 宠物包后，刷新本页即可选择。', { exact: true })
    .waitFor();
  await page.getByLabel('界面与社区语言', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: '应用版本与语言', exact: true }).click();
  const select = page.getByLabel('Choose companion appearance', { exact: true });
  assert.equal(await select.inputValue(), '');
  assert.equal(await select.locator('option').count(), 1);
  await page.getByRole('img', { name: 'Companion appearance preview', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Apply companion appearance', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Companion appearance applied' }).waitFor();
  assert.equal(requests.at(-1).action, 'appearance.select');
  assert.deepEqual(requests.at(-1).data, { petId: '' });
});

test('launcher validation errors remain visible, launch uses the chosen game', async (t) => {
  const { page, requests } = await open(t, ({ action }) =>
    action === 'launcher.save' ? { ok: false, code: 'wrong-executable' } : { ok: true },
  );
  await page.getByLabel('启动目标', { exact: true }).selectOption('retail');
  await page.getByLabel('启动程序完整路径').fill('D:\\Other.exe');
  await page.getByRole('button', { name: '校验并保存启动程序' }).click();
  await page.getByRole('status').filter({ hasText: 'wrong-executable' }).waitFor();
  assert.deepEqual(requests.at(-1).data, { target: 'retail', path: 'D:\\Other.exe', makeDefault: true });
  await page.getByRole('button', { name: '启动游戏', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已发送启动请求' }).waitFor();
  assert.equal(requests.at(-1).action, 'launcher.launch');
  assert.deepEqual(requests.at(-1).data, { target: 'retail' });
});

test('macro import counts UTF-8 bytes and screenshot settings are explicit', async (t) => {
  const { page, requests } = await open(t);
  await page.getByLabel('宏内容', { exact: true }).fill('/say ' + '魔'.repeat(100));
  await page.getByRole('button', { name: '导入游戏宏' }).click();
  await page.getByRole('status').filter({ hasText: '255 字节' }).waitFor();
  assert.equal(requests.length, 0);
  await page.getByLabel('宏内容', { exact: true }).fill('/say 你好');
  await page.getByRole('button', { name: '导入游戏宏' }).click();
  await page.getByRole('status').filter({ hasText: '宏导入请求已发送' }).waitFor();
  assert.deepEqual(requests.at(-1).data, { game: 'retail', body: '/say 你好' });
  await page.getByLabel('允许主动请求游戏截图', { exact: true }).check();
  await page.getByLabel('截图游戏窗口', { exact: true }).selectOption('forever');
  await page.getByRole('button', { name: '保存截图设置' }).click();
  await page.getByRole('status').filter({ hasText: '截图设置已保存' }).waitFor();
  assert.deepEqual(requests.at(-1).data, { enabled: true, game: 'forever' });
});

test('addon installation requires explicit compatible file selection and never resends a hidden key', async (t) => {
  const { page, requests } = await open(t, ({ action }) => {
    if (action === 'addons.metadata')
      return {
        ok: true,
        data: {
          versionTypes: [
            { id: 1, name: 'Retail branch', group: 'retail' },
            { id: 2, name: 'Other branch', group: 'forever' },
          ],
          categories: [],
        },
      };
    if (action === 'addons.search')
      return { ok: true, data: { totalCount: 1, addons: [{ id: 10, name: 'Quest helper', summary: 'Find NPCs' }] } };
    if (action === 'addons.files')
      return { ok: true, data: [{ id: 20, modId: 10, displayName: 'Retail file', gameVersions: ['12.0'] }] };
    return { ok: true, data: {} };
  });
  await page.getByRole('button', { name: '加载版本分支与分类' }).click();
  await page.getByRole('option', { name: 'Retail branch', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('option', { name: 'Other branch', exact: true }).count(), 0);
  await page.getByRole('button', { name: '保存插件配置' }).click();
  await page.getByRole('status').filter({ hasText: '插件配置已保存' }).waitFor();
  const save = requests.find((row) => row.action === 'addons.settings.save');
  assert.equal('apiKey' in save.data, false);
  assert.deepEqual(save.data.clients, initialState.addons.clients);
  await page.getByLabel('插件名称或关键词').fill('quest');
  await page.getByRole('button', { name: '搜索插件', exact: true }).click();
  await page.getByRole('button', { name: '查看兼容文件' }).click();
  await page.getByRole('button', { name: '安装此文件' }).waitFor();
  assert.equal(
    requests.some((row) => row.action === 'addons.install'),
    false,
  );
  await page.getByRole('button', { name: '安装此文件' }).click();
  await page.getByRole('status').filter({ hasText: '插件已安装' }).waitFor();
  assert.deepEqual(requests.at(-1).data, { game: 'retail', modId: 10, fileId: 20 });
});

test('knowledge is scoped, remote text stays inert, and history import needs explicit confirmation', async (t) => {
  const { page, requests } = await open(t, ({ action }) =>
    action === 'knowledge.search'
      ? {
          entries: [
            {
              title: 'DZ',
              text: '<img src=x onerror=alert(1)>',
              usage: '盗贼',
              game: 'shared',
              locale: 'zh-CN',
              kind: 'abbreviation',
            },
          ],
        }
      : { ok: true, imported: ['wow-gold-ledger.json'], backupPath: '/fixture/backup' },
  );
  await page.getByLabel('知识关键词或聊天片段').fill('DZ');
  await page.getByRole('button', { name: '搜索知识库' }).click();
  await page.getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor();
  assert.equal(await page.locator('.dsh-wow img[src="x"]').count(), 0);
  assert.deepEqual(requests[0].data, { query: 'DZ', locale: 'zh-CN', server: 'retail' });
  await page.getByLabel('旧版用户数据目录').fill('D:\\OldAiri');
  await page.getByRole('button', { name: '备份并导入档案' }).click();
  await page.getByRole('status').filter({ hasText: '勾选导入确认' }).waitFor();
  assert.equal(
    requests.some((row) => row.action === 'history.import'),
    false,
  );
  await page.getByLabel('我已核对旧版目录，并确认导入档案').check();
  await page.getByRole('button', { name: '备份并导入档案' }).click();
  await page.getByRole('status').filter({ hasText: '档案导入已完成' }).waitFor();
  assert.deepEqual(requests.at(-1).data, { sourceDirectory: 'D:\\OldAiri' });
});

test('polling keeps unsaved fields and removes stale position markers', async (t) => {
  const { page, state } = await open(t);
  await page.getByRole('img', { name: /测试区域.*X 0.00%, Y 50.00%/ }).waitFor();
  await page.getByLabel('启动程序完整路径').fill('D:\\Unsaved.exe');
  state.profiles.retail.bridge.ageSeconds = 10;
  await page.getByRole('img', { name: /测试区域/ }).waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('启动程序完整路径').inputValue(), 'D:\\Unsaved.exe');
  await page
    .getByText('等待 5 秒内的真实在线地图坐标；断线、演示和缺失坐标不显示当前位置。', { exact: true })
    .waitFor();
});

test('corrupt addon settings disable addon controls while other companion tools remain usable', async (t) => {
  const { page, requests } = await open(t, undefined, { addonsError: 'wow-addons-settings-invalid' });
  await page.getByText('wow-addons-settings-invalid', { exact: true }).waitFor();
  for (const name of ['保存插件配置', '加载版本分支与分类', '搜索插件', '查找推荐', '读取已安装记录']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
  }
  assert.equal(await page.getByRole('button', { name: '保存截图设置', exact: true }).isDisabled(), false);
  assert.equal(await page.getByRole('button', { name: '搜索知识库', exact: true }).isDisabled(), false);
  assert.equal(requests.length, 0);
});
