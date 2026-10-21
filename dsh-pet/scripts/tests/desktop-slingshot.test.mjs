// 桌面「弹弓」小互动的端到端回归：真的 Electron + 真的 helper（runtime/electron-helper/main.js）+ 隔离的 mock 宿主。
// 不读写用户的 DSH 配置 / 凭证。Run after npm run build:
//   DSH_PET_ELECTRON=/path/to/electron(.exe) npm run test:ui
// 可选 DSH_PET_UI_ARTIFACTS=<目录>：保存弹弓窗口的透明截图（开局 / 拉弓 / 撞击后）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, createReadStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { _electron } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const executablePath = process.env.DSH_PET_ELECTRON;
const artifacts = process.env.DSH_PET_UI_ARTIFACTS;

const TYPES = { '.webm': 'video/webm', '.ttf': 'font/ttf', '.png': 'image/png' };

function mockHost() {
  const source = readFileSync(join(root, 'assets/config.jsonc'), 'utf8');
  const config = JSON.parse(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1'));
  config.pets = [
    {
      ...config.pets[0],
      size: 300,
      fixedEnabled: true,
      balanceEnabled: false,
      whisperEnabled: false,
      workStatusEnabled: false,
      display: 'desktop',
      position: { corner: 'bottom-left', marginX: 200, marginY: 0 },
    },
  ];
  const dirs = { thumb: 'assets/webm', font: 'assets/fonts', pic: 'assets/pic' };
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const kind = Object.keys(dirs).find((k) => path.includes('/' + k + '/'));
    if (path.endsWith('/config')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ main: config }));
    } else if (kind) {
      const file = join(root, dirs[kind], basename(path));
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('content-type', TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream');
      createReadStream(file).pipe(res);
    } else {
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    }
  });
}

async function eventually(check, message, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

test(
  'desktop slingshot: transparent click-through window, real pull + crate physics, clean exit and re-entry',
  { skip: !executablePath, timeout: 90000 },
  async (t) => {
    if (artifacts) mkdirSync(artifacts, { recursive: true });
    const server = mockHost();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let app;
    try {
      const env = {
        ...process.env,
        DSH_PET_BRIDGE: '0',
        DSH_PET_SMOKE: '0',
        DSH_PET_CONFIG_URL: `http://127.0.0.1:${server.address().port}/dsh-pet-7340/config`,
        DSH_PET_PETS: JSON.stringify([{ id: 'main', size: 300 }]),
        DSH_PET_SCALE: '1',
      };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({ executablePath, args: [join(root, 'runtime/electron-helper/main.js')], env });
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__dshPetDebug?.configOk);
      // 主进程的穿透轮询读真实光标：测试里接管它，不碰用户的鼠标；并记录每个窗口的穿透状态
      await app.evaluate(({ screen, BrowserWindow, app: electronApp }) => {
        globalThis.testCursor = { x: -9999, y: -9999 };
        screen.getCursorScreenPoint = () => globalThis.testCursor;
        const wrap = (win) => {
          if (win.testWrapped) return;
          win.testWrapped = true;
          const original = win.setIgnoreMouseEvents.bind(win);
          win.testIgnoring = true;
          win.setIgnoreMouseEvents = (value, options) => {
            win.testIgnoring = value;
            original(value, options);
          };
        };
        BrowserWindow.getAllWindows().forEach(wrap);
        electronApp.on('browser-window-created', (e, win) => wrap(win));
      });

      /** 从宠物窗口打开弹弓，返回弹弓页面 */
      async function openSlingshot() {
        const next = app.waitForEvent('window');
        await pet.evaluate('sprites[0].openSlingshot()');
        const game = await next;
        await game.waitForFunction(() => window.__dshPetGame?.ready === true);
        return game;
      }
      const gameWindowInfo = () =>
        app.evaluate(({ BrowserWindow, screen }) => {
          const wins = BrowserWindow.getAllWindows();
          const game = wins.find((w) => w.getTitle().startsWith('弹弓'));
          const petWin = wins.find((w) => !w.getTitle().startsWith('弹弓'));
          return {
            count: wins.filter((w) => w.getTitle().startsWith('弹弓')).length,
            game: game && {
              bounds: game.getContentBounds(),
              onTop: game.isAlwaysOnTop(),
              visible: game.isVisible(),
              ignoring: game.testIgnoring,
              workArea: screen.getDisplayMatching(game.getBounds()).workArea,
            },
            petVisible: petWin.isVisible(),
          };
        });

      let game = await openSlingshot();

      await t.test(
        'window: transparent, not always-on-top, covers the work area; pet at its desktop size, 1/6 layout; pet hidden + frozen',
        async () => {
          await eventually(async () => (await gameWindowInfo()).petVisible === false, 'pet window should hide');
          const info = await gameWindowInfo();
          assert.equal(info.count, 1);
          assert.equal(info.game.visible, true);
          assert.equal(info.game.onTop, false);
          // 透明：直接抓窗口真实渲染出来的像素，空的天空处 alpha 必须是 0（Windows 上 getBackgroundColor 不带 alpha，不能当证据）
          const alpha = await app.evaluate(async ({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('弹弓'));
            const img = await win.webContents.capturePage();
            const { width, height } = img.getSize();
            const bmp = img.toBitmap(); // BGRA
            const at = (x, y) => bmp[(Math.floor(y) * width + Math.floor(x)) * 4 + 3];
            return { sky: [at(width / 2, 20), at(20, 20), at(width - 20, height / 3)], width };
          });
          assert.ok(alpha.width > 0);
          assert.deepEqual(alpha.sky, [0, 0, 0], 'empty sky must be fully transparent');
          // 宠物视频帧四周不能有一圈「几乎透明」的底（webm 的 alpha 噪声）：浅色桌面上会显出一个淡淡的方框
          const petRect = await game.evaluate(() => {
            const S = window.PetShared;
            const { fit, offX, offY } = window.__dshPetGame.view;
            const box = S.petBoxAt(window.__dshPetGame.pet);
            return {
              x: offX + box.x * fit,
              y: offY + box.y * fit,
              w: S.GAME_PET_SIZE * fit,
              h: ((S.GAME_PET_SIZE * 9) / 16) * fit,
              cssW: innerWidth,
            };
          });
          const haze = await app.evaluate(async ({ BrowserWindow }, r) => {
            const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('弹弓'));
            const img = await win.webContents.capturePage();
            const { width } = img.getSize();
            const k = width / r.cssW;
            const bmp = img.toBitmap();
            let faint = 0;
            let total = 0;
            for (let y = Math.ceil(r.y * k); y < Math.floor((r.y + r.h) * k); y++) {
              for (let x = Math.ceil(r.x * k); x < Math.floor((r.x + r.w) * k); x++) {
                const a = bmp[(y * width + x) * 4 + 3];
                total++;
                if (a > 0 && a < 10) faint++;
              }
            }
            return { faint, total };
          }, petRect);
          assert.ok(
            haze.total > 0 && haze.faint / haze.total < 0.01,
            'faint haze around the pet: ' + JSON.stringify(haze),
          );
          const { bounds, workArea } = info.game;
          assert.deepEqual(bounds, workArea, 'the window covers the whole work area');
          // 宠物（弹弓）离屏幕左边 1/6，木箱垛右边缘离右边 1/6
          const layout = await game.evaluate(() => {
            const g = window.__dshPetGame;
            const { fit, offX } = g.view;
            const right = Math.max(...g.blocks.map((b) => b.x + g.spots[b.id].w / 2));
            return { sling: offX + window.PetShared.SLING_BASE.x * fit, pile: offX + right * fit, width: innerWidth };
          });
          assert.ok(Math.abs(layout.sling - layout.width / 6) < 1, JSON.stringify(layout));
          assert.ok(Math.abs(layout.pile - (layout.width * 5) / 6) < 1, JSON.stringify(layout));
          assert.equal(await pet.evaluate('sprites[0].frozen && sprites[0].inGame'), true);
          // 宠物进了弹弓大小不变：场景里画出来的宠物宽（CSS 像素）= 桌面上那只的大小
          const desk = await pet.evaluate('sprites[0].size');
          const drawn = await game.evaluate(() => window.__dshPetGame.view.fit * window.PetShared.GAME_PET_SIZE);
          assert.ok(Math.abs(drawn - desk) < 0.5, `drawn ${drawn} vs desktop ${desk}`);
          const start = await game.evaluate(() => {
            const g = window.__dshPetGame;
            return {
              mode: g.petMode,
              sessions: g.sessions,
              loops: g.loops,
              blocks: g.blocks.length === window.PetShared.STRUCTURE.length,
              asleep: g.blocks.every((b) => b.sleeping),
            };
          });
          assert.deepEqual(start, { mode: 'ready', sessions: 1, loops: 1, blocks: true, asleep: true });
          if (artifacts) await game.screenshot({ path: join(artifacts, 'slingshot-enter.png'), omitBackground: true });
        },
      );

      /** 宠物身体中心（窗口内 CSS 像素） */
      const petPoint = () =>
        game.evaluate(() => {
          const c = window.__dshPetGame.pet;
          const { fit, offX, offY } = window.__dshPetGame.view;
          return { x: offX + c.x * fit, y: offY + c.y * fit, fit };
        });

      await t.test('click-through: transparent area passes clicks to the desktop, the pet catches them', async () => {
        const { bounds } = (await gameWindowInfo()).game;
        const p = await petPoint();
        await app.evaluate((_, pt) => (globalThis.testCursor = pt), {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + 40,
        });
        await eventually(
          async () => (await gameWindowInfo()).game.ignoring === true,
          'empty area should be click-through',
        );
        await app.evaluate((_, pt) => (globalThis.testCursor = pt), { x: bounds.x + p.x, y: bounds.y + p.y });
        await eventually(async () => (await gameWindowInfo()).game.ignoring === false, 'pet should catch the mouse');
      });

      await t.test('real mouse pull → flight → crates hit → pet comes back to the pouch', async () => {
        // 木箱垛按屏宽 1/6 定位，离弹弓多远随屏而变：先在页面里用同一套物理试几种仰角，挑一发真能撞到木箱的
        const dy = await game.evaluate(() => {
          const S = window.PetShared;
          const GP = window.GamePhysics;
          const g = window.__dshPetGame;
          const opts = {
            width: S.GAME_W,
            groundY: S.GAME_GROUND_Y,
            gravity: S.GAME_GRAVITY,
            left: g.view.wallLeft,
            right: g.view.wallRight,
          };
          for (const down of [10, 30, 50, 70, 90, 110, 130, 150]) {
            const pulled = S.aimPoint({ x: S.SLING_ANCHOR.x - 150, y: S.SLING_ANCHOR.y + down });
            const w = GP.createWorld(opts);
            w.addBlocks(g.spots);
            w.launchPet(pulled, S.slingVelocity(pulled, g.view.power));
            for (let i = 0; i < 300; i++) {
              if (w.step(1000 / 60).some((im) => [im.a, im.b].includes('pet') && [im.a, im.b].some(Number.isInteger)))
                return down;
            }
          }
          return null;
        });
        assert.notEqual(dy, null, 'some pull angle must reach the crates');
        const p = await petPoint();
        await game.mouse.move(p.x, p.y);
        await game.mouse.down();
        for (let i = 1; i <= 12; i++) await game.mouse.move(p.x - (150 * p.fit * i) / 12, p.y + (dy * p.fit * i) / 12);
        await game.waitForTimeout(250);
        assert.equal(await game.evaluate(() => window.__dshPetGame.petMode), 'pull');
        if (artifacts) await game.screenshot({ path: join(artifacts, 'slingshot-pull.png'), omitBackground: true });
        // 记下松手之后宠物经历的每一个状态（回弹弓应当是 淡出 → 皮兜里淡入，不再跑回去）
        await game.evaluate(() => {
          const log = [];
          window.__modeLog = log;
          const tick = () => {
            const m = window.__dshPetGame.petMode;
            if (!log.length || log[log.length - 1].m !== m) log.push({ m, t: performance.now() });
            requestAnimationFrame(tick);
          };
          tick();
        });
        await game.mouse.up();
        await game.waitForFunction(() => window.__dshPetGame.petMode === 'fly');
        await game.waitForFunction(() => window.__dshPetGame.petMode !== 'fly', null, { timeout: 12000 });
        const after = await game.evaluate(() => {
          const S = window.PetShared;
          const g = window.__dshPetGame;
          const moved = g.blocks.filter((b) => Math.hypot(b.x - g.spots[b.id].x, b.y - g.spots[b.id].y) > 5);
          const damaged = g.state.blocks.filter((b) => b.hp < S.BLOCK_HP);
          return { moved: moved.length, damaged: damaged.length };
        });
        assert.ok(after.moved + after.damaged > 0, 'the shot should move or damage crates: ' + JSON.stringify(after));
        if (artifacts) await game.screenshot({ path: join(artifacts, 'slingshot-impact.png'), omitBackground: true });
        await game.waitForFunction(() => ['ready', 'cheer'].includes(window.__dshPetGame.petMode), null, {
          timeout: 20000,
        });
        const back = await game.evaluate(() => {
          const g = window.__dshPetGame;
          const modes = window.__modeLog.map((e) => e.m);
          const at = (m) => window.__modeLog.find((e) => e.m === m)?.t;
          return {
            modes,
            backSec: (at('ready') - at('rest')) / 1000,
            pet: g.pet,
            anchor: window.PetShared.SLING_ANCHOR,
          };
        });
        assert.ok(!back.modes.includes('run') && !back.modes.includes('hop'), 'no running back: ' + back.modes);
        const rest = back.modes.indexOf('rest');
        const cheered = back.modes.includes('cheer');
        if (!cheered) {
          assert.deepEqual(back.modes.slice(rest, rest + 4), ['rest', 'vanish', 'appear', 'ready'], String(back.modes));
          assert.ok(back.backSec < 2, `back in the sling within 2 s, took ${back.backSec}`);
          assert.ok(Math.hypot(back.pet.x - back.anchor.x, back.pet.y - back.anchor.y) < 1e-6, 'standing in the pouch');
        }
      });

      await t.test('Esc closes the window and restores the pet (visible, unfrozen)', async () => {
        // Esc 立刻关窗：页面在按键收尾前就没了，Playwright 会报 page closed——那正是我们要的结果
        await game.keyboard.press('Escape').catch(() => {});
        await eventually(async () => (await gameWindowInfo()).count === 0, 'slingshot window should close');
        await eventually(async () => (await gameWindowInfo()).petVisible === true, 'pet window should come back');
        assert.equal(await pet.evaluate('sprites[0].inGame || sprites[0].frozen'), false);
      });

      await t.test('re-entry is a brand-new session; opening again while open replaces the window', async () => {
        game = await openSlingshot();
        const fresh = await game.evaluate(() => {
          const g = window.__dshPetGame;
          return {
            mode: g.petMode,
            sessions: g.sessions,
            loops: g.loops,
            blocks: g.blocks.length === window.PetShared.STRUCTURE.length,
            asleep: g.blocks.every((b) => b.sleeping),
            particles: g.particles,
          };
        });
        assert.deepEqual(fresh, { mode: 'ready', sessions: 1, loops: 1, blocks: true, asleep: true, particles: 0 });
        const replaced = await openSlingshot();
        await eventually(async () => (await gameWindowInfo()).count === 1, 'only one slingshot window may exist');
        assert.equal(await replaced.evaluate(() => window.__dshPetGame.sessions), 1);
        await replaced.keyboard.press('Escape').catch(() => {});
        await eventually(async () => (await gameWindowInfo()).petVisible === true, 'pet window should come back');
      });
    } finally {
      if (app) await app.close();
      server.close();
    }
  },
);
