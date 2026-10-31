#!/usr/bin/env node
/**
 * 发布前健康检查，由 package.json 的 prepack 触发，任何一项失败都以非零退出码阻断发布。
 *
 * 查必需文件、待机动画素材、原始母版是否误入包、client.js 的官方 bundle 形态、
 * package.json 的 dsh.bundle 与 dsh.client 声明、表情包图片与配置键是否对齐、包体积上限，
 * 以及构建产物有没有引入未声明的 @oxc-project/runtime helper。
 * 只读检查，不构建、不打包、不改任何文件，依赖已构建好的 lib 与 assets。
 * @module dsh-pet/scripts/prepack-check
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 包根目录（scripts/ 的上一级）
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// 失败与通过两种输出的辅助函数。
const fail = (msg) => {
  console.error(`[prepack-check] FAIL: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`[prepack-check] ok: ${msg}`);
/** JSONC → JSON：字符串感知地剥离行注释与块注释（config.jsonc 里有行尾注释）。 */
const stripJsonc = (s) => {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
};

// 缺任一件，装上就是运行期报错，所以在发布前逐个点名。
const required = [
  'lib/index.js', // 宿主半侧
  'lib/client.js', // 浏览器半侧
  'lib/types/index.d.ts', // 宿主类型声明
  'lib/types/client/index.d.ts', // 客户端类型声明
  'cordis.patch.yml', // bundle patch（挂载声明）
  'runtime/electron-helper/main.js', // 桌面模式 Electron 主进程
  'runtime/electron-helper/main/smoke.js', // 桌面模式冒烟自检（main.js require，缺了启动即崩）
  'runtime/electron-helper/main/dpi.js', // 桌面模式 DPI 与指针（main.js require，缺了启动即崩）
  'runtime/electron-helper/main/bridge.js', // 桌面模式与宿主通道（同上）
  'runtime/electron-helper/main/tray.js', // 桌面模式托盘（同上）
  'runtime/electron-helper/main/windows.js', // 桌面模式窗口与两条实时泵（同上）
  'runtime/electron-helper/main/ipc.js', // 桌面模式 ipc 处理器（同上）
  'runtime/electron-helper/main/displays.js', // 桌面模式显示器热更新（同上）
  'runtime/electron-helper/main/user-data.js', // 桌面模式 userData 回退决策（main.js require，缺了会启动即崩）
  'runtime/electron-helper/pointer-target.js', // 桌面模式点击穿透兜底判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/host-liveness.js', // 桌面模式宿主存活判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/topmost-watchdog.js', // 桌面模式置顶看门狗判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/taskbar-watchdog.js', // 桌面模式任务栏看门狗判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/dpi-linearization.js', // 桌面模式 DPI 线性化判定与换算（main.js require，缺了会启动即崩）
  'runtime/electron-helper/tray-platform.js', // 桌面模式托盘平台差异判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/desktop-geometry.js', // 活动边界与菜单工作区分离
  'runtime/electron-helper/preload.js', // 桌面模式 preload 桥
  'runtime/electron-helper/renderer.js', // 桌面模式渲染端（宠物本体）
  'runtime/electron-helper/sprite/bubble.js', // 桌面模式气泡与提示渲染（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/sprite/menu.js', // 桌面模式右键菜单（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/sprite/playback.js', // 桌面模式播放状态机（同上）
  'runtime/electron-helper/sprite/motion.js', // 桌面模式运动驱动（同上）
  'runtime/electron-helper/sprite/input.js', // 桌面模式指针与命中（同上）
  'runtime/electron-helper/sprite/init.js', // 桌面模式构建期初始化（同上）
  'runtime/electron-helper/shared-core.js', // 桌面模式共享纯逻辑（src/shared 构建产物，window.PetShared）
  'runtime/electron-helper/index.html', // 桌面模式页面壳
];
for (const f of required) {
  existsSync(join(ROOT, f)) ? ok(`exists ${f}`) : fail(`missing ${f}`);
}

// 待机动画是播放链的起点，缺了宠物立不起来；浏览器与桌面 Helper 共用这一份 webm。
const idleWebm = join(ROOT, 'assets', 'webm', '待机呼吸休闲.webm');
existsSync(idleWebm) ? ok('idle webm present') : fail('missing 待机呼吸休闲.webm thumb');

// 原始母版（1200×1200）体积超限，应放 GitHub Releases，不进 npm 包。
// assets/ 根下若有 .webm 就是原始母版，播放素材在 assets/webm|mov 子目录。
const originals = [];
const assetsRoot = join(ROOT, 'assets');
for (const name of readdirSync(assetsRoot)) {
  if (name.endsWith('.webm')) originals.push(name);
}
if (originals.length > 0)
  fail(`original masters must not ship in npm package: ${originals.join(', ')} (move them to GitHub Releases)`);
else ok('no original masters in assets/');

// 宿主加载器只认官方 bundle 形态；形制不对，插件在浏览器半侧根本注册不上。
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
client.includes('__ModuleLoader__.load')
  ? ok('client bundle shell OK')
  : fail('client.js missing __ModuleLoader__.load');
const exportsPlugin =
  /exports\.(apply|inject|name)/.test(client) || /module\.exports\s*=\s*\{[^}]*apply[^}]*inject[^}]*name/.test(client);
exportsPlugin ? ok('client exports apply/inject/name') : fail('client.js missing apply/inject/name exports');

// 两项声明缺任一个都装不进宿主：bundle 声明决定挂载声明，client 声明决定浏览器半侧注入。
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.dsh?.bundle?.patch) ok('dsh.bundle.patch declared');
else fail('package.json missing dsh.bundle.patch');
if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.web declared');
else fail('package.json missing dsh.client platform web');

// 配图功能只读包内 assets/memes，漏发即整体失效。
// scripts/prepare.js 每次发布都用硬编码白名单覆盖 package.json 的 files，
// 只在 package.json 里加一行是无效的，故这里显式断言，防止再次静默漏发。
const memesDir = join(ROOT, 'assets', 'memes');
if (Array.isArray(pkg.files) && pkg.files.includes('assets/memes')) ok('files includes assets/memes');
else fail('package.json files must include assets/memes (meme images would not ship)');
const memePngs = existsSync(memesDir) ? readdirSync(memesDir).filter((n) => n.endsWith('.png')) : [];
if (memePngs.length > 0) ok(`meme images present (${memePngs.length} png)`);
else fail('no png in assets/memes (whisper/chat 配图会整体失效)');
// memes 键 ↔ 图片文件对齐：缺图条目会被 host 静默剔除（设计如此，不阻断发布），
// 但数字对不上值得发布前看一眼，故只提示
try {
  const conf = JSON.parse(stripJsonc(readFileSync(join(ROOT, 'assets', 'config.jsonc'), 'utf8')));
  const keys = Object.keys(conf.memes ?? {});
  const onDisk = new Set(memePngs.map((n) => n.slice(0, -'.png'.length)));
  const missing = keys.filter((k) => !onDisk.has(k));
  const extra = [...onDisk].filter((k) => !keys.includes(k));
  if (!missing.length && !extra.length) ok(`memes mapping aligned (${keys.length} keys = ${memePngs.length} png)`);
  else
    console.log(
      `[prepack-check] note: memes 键与图片不齐 —— 缺图 ${missing.length} 条${
        missing.length ? `（${missing.join('、')}）` : ''
      }；没写进配置的图 ${extra.length} 张${extra.length ? `（${extra.join('、')}）` : ''}`,
    );
} catch (e) {
  console.log(`[prepack-check] note: 跳过 memes 键对齐核对（config.jsonc 解析失败：${e.message}）`);
}

// 估算将进包的总大小：跳过 node_modules、.git、脚本、母版目录与 preview，
// 另不计 sourcemap 与 npm pack 遗留的 tarball。
let total = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过不会进 npm 包的目录
      // dist-app 是 electron-builder 的本地产物（.gitignore 已忽略、不进包），不参与体积估算。
      if (
        !['node_modules', '.git', 'scripts', 'step01', 'step02', 'step03', 'preview', 'dist-app'].includes(entry.name)
      ) {
        walk(p);
      }
    } else if (!entry.name.endsWith('.map')) {
      // 打包产物 tarball（npm pack 遗留）不计入自查口径
      if (!entry.name.endsWith('.tgz')) total += statSync(p).size; // sourcemap 不计
    }
  }
};
walk(ROOT);
const mb = (total / 1e6).toFixed(1);
if (total > 200e6) fail(`package too large: ${mb}MB (limit 200MB)`);
else ok(`package size ${mb}MB`);

// rolldown 在 target es2020 下会为「带初始化器的类字段」产出降级语法，
// 打包结果里就会多出 `import _defineProperty from "@oxc-project/runtime/helpers/defineProperty"`；
// 该包既不在 dependencies 也不随包发布，宿主加载插件树时会 ERR_MODULE_NOT_FOUND，整个 profile 起不来。
// 约定是类字段一律 declare 加构造器赋值，避免降级出外部 helper（见 src/host/helper-process.ts）。
const OXC_RUNTIME = '@oxc-project/runtime';
const oxcBundles = ['lib/index.js', 'lib/client.js'].filter((f) => {
  const p = join(ROOT, f);
  return existsSync(p) && readFileSync(p, 'utf8').includes(OXC_RUNTIME);
});
if (oxcBundles.length > 0)
  fail(
    `bundle imports undeclared helper ${OXC_RUNTIME} (${oxcBundles.join(', ')}) — ` +
      '类字段改用 declare + 构造器赋值（见 src/host/helper-process.ts 的约定）',
  );
else ok(`no undeclared ${OXC_RUNTIME} import in bundles`);

if (process.exitCode) console.error('\n[prepack-check] fix the failures above before publishing.');
else console.log('\n[prepack-check] all checks passed — ready to pack/publish.');
