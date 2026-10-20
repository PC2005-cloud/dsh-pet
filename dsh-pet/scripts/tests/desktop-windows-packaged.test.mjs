// Windows 打包冒烟测试（ticket 04）：用 Playwright 的 _electron 启动**打包后的可执行文件**（helper 角色），
// 验证装好的应用真的能按配置跑出宠物窗口并加载全部素材。
//
// 只有这条测试能拦住「路径改错但开发形态看不出来」：开发形态跑的是 electron.exe + 仓库里的脚本，
// 打包形态跑的是 asar 内的 desktop/main.mjs + runtime/electron-helper/。这里不接受任何源码级断言，
// 只看外部行为：窗口数量/尺寸、页面可见性、素材 HTTP 状态。
//
// 前置：先 `pnpm run dist` 产出 dist/win-unpacked/DSH Pet.exe（或指向安装目录里的同名 exe），然后：
//   DSH_PET_PACKAGED_EXE="<绝对路径>/DSH Pet.exe" pnpm run test:packaged
// 未设置 DSH_PET_PACKAGED_EXE 时跳过并打印可操作提示（不静默通过）。
//
// 隔离：mock 宿主只提供内置配置与仓库素材；--user-data-dir 指向临时目录，不碰真实
// %APPDATA%\dsh-pet-electron-helper。DSH_PET_FORCE_DSF=0 关闭 Windows 的 DPI 线性化，使窗口尺寸
// 不依赖运行机器的缩放（线性化本身已由 ticket 03 的打包实测与 dpi-linearization 单测覆盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));

// 两只尺寸不同的宠物：同时验证「窗口数 = 配置数」与「每只窗口按自己的 size 建窗」。
const PETS = [
  { id: 'main', size: 150 },
  { id: 'second', size: 220 },
];

const MIME = { '.webm': 'video/webm', '.ttf': 'font/ttf', '.png': 'image/png' };

/** 与 runtime/electron-helper/main.js 的 petWindowSize 同式：宠物包围盒 + 四周各半只宠物的外扩余量 */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (height * 30) / 360;
  const margin = Math.round(size * 0.5);
  return { width: Math.round(size) + margin * 2, height: Math.round(height + bottomPad) + margin * 2 };
}

test(
  'Windows packaged app: helper windows match configured pets and load all assets',
  { timeout: 90000 },
  async (t) => {
    if (process.platform !== 'win32') {
      t.skip(`仅 Windows 平台运行（当前 ${process.platform}）`);
      return;
    }
    const configured = process.env.DSH_PET_PACKAGED_EXE;
    if (!configured) {
      t.diagnostic('跳过：未设置 DSH_PET_PACKAGED_EXE（打包可执行文件路径）。');
      t.diagnostic('先运行 `pnpm run dist` 产出安装包，然后执行：');
      t.diagnostic('  DSH_PET_PACKAGED_EXE="<包根绝对路径>/dist/win-unpacked/DSH Pet.exe" pnpm run test:packaged');
      t.diagnostic('（也可以指向安装目录里的 `DSH Pet.exe`）');
      t.skip('未设置 DSH_PET_PACKAGED_EXE');
      return;
    }
    const executablePath = resolve(configured);
    assert.ok(
      existsSync(executablePath),
      `DSH_PET_PACKAGED_EXE 指向的文件不存在：${executablePath}\n` +
        '先运行 `pnpm run dist`，再指向 dist/win-unpacked/DSH Pet.exe 或安装目录里的 DSH Pet.exe。',
    );

    // mock 宿主：从仓库 assets/config.jsonc 取出完整默认配置，只替换宠物列表。
    const source = readFileSync(join(root, 'assets/config.jsonc'), 'utf8');
    const config = JSON.parse(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1'));
    const template = config.pets[0];
    config.pets = PETS.map((pet) => ({
      ...template,
      id: pet.id,
      size: pet.size,
      fixedEnabled: true,
      balanceEnabled: false,
      whisperEnabled: false,
      workStatusEnabled: false,
      display: 'desktop',
      position: { corner: 'top-left', marginX: 120, marginY: 120 },
    }));

    /** 宿主实际应答过的每个请求：{ path, status }。素材 404 会留在这里并被断言抓住。 */
    const served = [];
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (path.endsWith('/config')) {
        served.push({ path, status: 200 });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ main: config }));
        return;
      }
      const assetDir = path.includes('/thumb/')
        ? 'assets/webm'
        : path.includes('/font/')
          ? 'assets/fonts'
          : path.includes('/pic/')
            ? 'assets/pic'
            : '';
      if (assetDir) {
        const file = join(root, assetDir, basename(path));
        if (!existsSync(file)) {
          served.push({ path, status: 404 });
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        served.push({ path, status: 200 });
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        createReadStream(file).pipe(res);
        return;
      }
      // /state 等运行期轮询：返回空对象即可，页面不依赖其中的叶子。
      served.push({ path, status: 200 });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));

    const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-pet-packaged-'));
    let app;
    let processExited = false;
    try {
      const env = {
        ...process.env,
        DSH_PET_BRIDGE: '0',
        DSH_PET_SMOKE: '0',
        DSH_PET_CONFIG_URL: `http://127.0.0.1:${server.address().port}/dsh-pet-7340/config`,
        DSH_PET_PETS: JSON.stringify(PETS),
        DSH_PET_SCALE: '1',
        // 见文件头：让窗口尺寸与机器 DPI 解耦，测试在任何缩放下都断言同一组数值。
        DSH_PET_FORCE_DSF: '0',
      };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({
        executablePath,
        // Playwright 会自动追加 --inspect=0 / --remote-debugging-port=0；角色参数必须保留。
        args: ['--dsh-pet-helper', `--user-data-dir=${userDataDir}`],
        env,
      });
      const child = app.process();

      await waitFor(
        () => app.windows().length === PETS.length,
        `只出现了 ${app.windows().length} 个页面，期望 ${PETS.length} 个宠物窗口`,
      );
      const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      assert.equal(windowCount, PETS.length, '主进程创建的窗口数应等于 DSH_PET_PETS 的宠物数');

      const seenIndexes = new Set();
      for (const page of app.windows()) {
        await page.waitForFunction(() => window.__dshPetDebug?.configOk === true, undefined, { timeout: 30000 });
        await page.waitForFunction(() => document.visibilityState === 'visible', undefined, { timeout: 30000 });
        // 页面真正解出了动画帧，才算素材链路通（mock 404 会让这里超时，并在 served 里留下证据）。
        await page.waitForFunction(
          () => [...document.querySelectorAll('video')].some((video) => video.readyState >= 2 && !video.error),
          undefined,
          { timeout: 30000 },
        );
        const debug = await page.evaluate(() => ({
          petIndex: CONFIG.petIndex,
          configOk: window.__dshPetDebug.configOk,
          spriteCount: window.__dshPetDebug.spriteCount,
          errors: window.__dshPetDebug.errors,
          visibility: document.visibilityState,
        }));
        assert.equal(debug.configOk, true, `petIndex=${debug.petIndex} 的页面未加载出配置`);
        assert.equal(debug.spriteCount, 1, `petIndex=${debug.petIndex} 的页面应恰好有 1 只宠物`);
        assert.deepEqual(debug.errors, [], `petIndex=${debug.petIndex} 的页面有未捕获错误`);
        assert.equal(debug.visibility, 'visible', `petIndex=${debug.petIndex} 的窗口不可见`);
        assert.ok(debug.petIndex >= 0 && debug.petIndex < PETS.length, `petIndex=${debug.petIndex} 超出配置范围`);
        assert.ok(!seenIndexes.has(debug.petIndex), `petIndex=${debug.petIndex} 出现了重复窗口`);
        seenIndexes.add(debug.petIndex);

        const pet = PETS[debug.petIndex];
        const expected = petWindowSize(pet.size);
        const windowHandle = await app.browserWindow(page);
        await waitFor(async () => {
          const bounds = await windowHandle.evaluate((win) => win.getContentBounds());
          return Math.abs(bounds.width - expected.width) <= 4 && Math.abs(bounds.height - expected.height) <= 4;
        }, `petIndex=${debug.petIndex}（size=${pet.size}）的窗口尺寸未达到 ${expected.width}×${expected.height}`);
        const actual = await windowHandle.evaluate((win) => ({
          bounds: win.getContentBounds(),
          visible: win.isVisible(),
        }));
        assert.ok(
          Math.abs(actual.bounds.width - expected.width) <= 4,
          `petIndex=${debug.petIndex} 窗口宽 ${actual.bounds.width}，期望 ${expected.width}`,
        );
        assert.ok(
          Math.abs(actual.bounds.height - expected.height) <= 4,
          `petIndex=${debug.petIndex} 窗口高 ${actual.bounds.height}，期望 ${expected.height}`,
        );
        assert.equal(actual.visible, true, `petIndex=${debug.petIndex} 的窗口未显示`);
        t.diagnostic(
          `petIndex=${debug.petIndex} size=${pet.size} 内容区=${actual.bounds.width}×${actual.bounds.height}（期望 ${expected.width}×${expected.height}）`,
        );
      }
      assert.equal(seenIndexes.size, PETS.length, '每只配置宠物都应有一个窗口');

      const materialFailures = served.filter((entry) => entry.status >= 400);
      assert.deepEqual(materialFailures, [], '渲染端请求了宿主无法提供的素材（4xx/5xx）');
      assert.ok(
        served.some((entry) => entry.path.includes('/thumb/')),
        '渲染端没有请求任何动画素材，素材链路未被验证',
      );
      t.diagnostic(`宿主应答 ${served.length} 个请求，全部 2xx`);

      await app.close();
      app = undefined;
      processExited = await waitForProcessExit(child, 10000);
    } finally {
      if (app) {
        const child = app.process();
        await app.close().catch(() => {});
        processExited = await waitForProcessExit(child, 10000);
      }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      rmSync(userDataDir, { recursive: true, force: true });
    }
    assert.ok(processExited, '应用关闭后进程没有退出（有残留）');
  },
);

/** 轮询直到 check() 为真；超时用 assert.fail 报出可读原因 */
async function waitFor(check, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(message);
}

/** app.close() 之后确认启动的进程确实退出（Electron 主进程不残留） */
async function waitForProcessExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}
