/**
 * 安装包接线的源码契约（ticket 02）。
 *
 * 这里刻意只钉**跨进程/跨工具的约定**，不测 electron-builder 或 NSIS 本身：
 *   - 包内布局不能变：`desktop/main.mjs` 必须以 `../lib/...` 与 `../runtime/electron-helper/main.js`
 *     的**相对路径**引用产物（`src/host/index.ts` 的 PACKAGE_ROOT 由 bundle 位置反推，
 *     把 lib/ 或 assets/ 挪位置会让配置、字体、视频、版本号一起错位）；
 *   - 打包入口必须是 `extraMetadata.main = desktop/main.mjs`（package.json 的 main 是插件入口，不能改）；
 *   - NSIS 配置：每用户安装、不请求管理员、不用 UPX、不把 65MB 的 assets/preview 打进包；
 *   - 构建链：`npm run dist` 先跑现有构建、再调用 scripts/dist.mjs；后者优先用本机 Electron。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读包根下的文件（本测试位于 src/host/，包根是两级之上） */
function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

describe('desktop/main.mjs —— 打包后的主进程入口（角色分流）', () => {
  const source = readPackageFile('desktop/main.mjs');

  test('包内布局不变：lib/、runtime/electron-helper/ 与 desktop/ 同级', () => {
    assert.match(source, /\.\.\/lib\/launch-plan\.js/, '角色解析必须复用 src/host/launch-plan.ts 的构建产物');
    assert.match(source, /\.\.\/lib\/standalone-app\.js/, '宿主角色必须走可编程入口，不能 import CLI');
    assert.match(source, /\.\.\/runtime\/electron-helper\/main\.js/, '桌面壳角色必须加载现有壳');
  });

  test('三种角色都接上了：helper / dpi-probe / host', () => {
    assert.match(source, /parseAppRole/);
    assert.match(source, /--dsh-pet-helper|role === 'helper'|role\s*===\s*"helper"/);
    assert.match(source, /DSH_PET_DPI_PROBE/, 'DPI 探测开关目前只认环境变量');
    assert.match(source, /startStandalone/);
  });

  test('宿主角色设置 DSH_PET_PACKAGED，且它会随 process.env 传给子进程', () => {
    assert.match(source, /DSH_PET_PACKAGED/);
  });

  test('打包宿主显式声明 DSH_PET_HOST_KIND=packaged（不能靠 Electron 嗅探）', () => {
    assert.match(
      source,
      /process\.env\.DSH_PET_HOST_KIND\s*=\s*'packaged'/,
      '打包宿主自己就是 Electron 进程，必须显式声明形态，否则「打开网站」会被误判为 DSH 桌面应用',
    );
    const kindAt = source.indexOf("process.env.DSH_PET_HOST_KIND = 'packaged'");
    const startAt = source.indexOf('await startStandalone(');
    assert.ok(startAt > 0, '宿主角色必须调用 startStandalone');
    assert.ok(kindAt >= 0 && kindAt < startAt, '形态变量必须在 startStandalone（apply 读取它）之前设置');
  });
});

describe('electron-builder.yml —— NSIS 安装包配置', () => {
  const yml = readPackageFile('electron-builder.yml');

  test('主进程入口指向 desktop/main.mjs（不改 package.json 的插件入口 main）', () => {
    assert.match(yml, /main:\s*desktop\/main\.mjs/);
    const pkg = JSON.parse(readPackageFile('package.json')) as { main?: string };
    assert.equal(pkg.main, 'lib/index.js', 'package.json 的 main 是插件入口，不能被打包入口覆盖');
  });

  test('内置 Electron 43.3.0（与 ensure-electron.mjs / helper-process.ts 一致）', () => {
    assert.match(yml, /electronVersion:\s*['"]?43\.3\.0['"]?/);
  });

  test('每用户安装、不请求管理员、允许改目录、建快捷方式、不用 UPX', () => {
    assert.match(yml, /oneClick:\s*false/);
    assert.match(yml, /perMachine:\s*false/);
    assert.match(yml, /allowToChangeInstallationDirectory:\s*true/);
    assert.match(yml, /createDesktopShortcut:\s*true/);
    assert.match(yml, /createStartMenuShortcut:\s*true/);
    assert.match(yml, /requestedExecutionLevel:\s*asInvoker/);
    assert.match(yml, /deleteAppDataOnUninstall:\s*false/);
    assert.match(yml, /compression:\s*['"]?store|compression:\s*['"]?normal|upx/i, '不显式启用 UPX');
  });

  test('元数据齐全（产品名 / appId / 版权 / 公司名 / 描述 / 图标）', () => {
    assert.match(yml, /productName:\s*DSH Pet/);
    assert.match(yml, /appId:\s*com\.dsh\.pet/);
    assert.match(yml, /copyright:/);
    // exe 属性页的 CompanyName 取自安装包内 package.json 的 author.name
    assert.match(yml, /author:\s*\n\s*name:/);
    // 安装程序 exe 的 FileDescription 取自安装包内 package.json 的 description
    assert.match(yml, /description:/);
    assert.match(yml, /icon:\s*assets\/logo\.png/);
  });

  test('files 白名单保留包内布局、且明确排除 assets/preview', () => {
    assert.match(yml, /lib\/\*\*/);
    assert.match(yml, /assets\/config\.jsonc/);
    assert.match(yml, /assets\/webm\/\*\*/);
    assert.match(yml, /runtime\/electron-helper\/\*\*/);
    assert.match(yml, /desktop\/\*\*/);
    assert.ok(!/^\s*-\s*assets\/preview/m.test(yml), 'assets/preview（约 65MB README 素材）不得进安装包');
    assert.ok(!/^\s*-\s*assets\/?\s*$/m.test(yml), '不能粗暴地把整个 assets 目录打进去');
  });
});

describe('构建链 —— npm run dist', () => {
  test('tsdown 产出 lib/launch-plan.js 与 lib/standalone-app.js（包内布局不变）', () => {
    const config = readPackageFile('tsdown.config.mjs');
    assert.match(config, /launch-plan/);
    assert.match(config, /standalone-app/);
    assert.match(config, /outDir:\s*'lib'/);
  });

  test('package.json 的 dist 脚本先构建再调用 scripts/dist.mjs', () => {
    const pkg = JSON.parse(readPackageFile('package.json')) as { scripts?: Record<string, string> };
    const dist = pkg.scripts?.dist ?? '';
    assert.match(dist, /build/);
    assert.match(dist, /scripts\/dist\.mjs/);
  });

  test('scripts/dist.mjs 优先用本机 Electron 并带 npmmirror 兜底', () => {
    const source = readPackageFile('scripts/dist.mjs');
    assert.match(source, /electronDist/);
    assert.match(source, /electron(?:\.exe|LandingDir|Dist)/);
    assert.match(source, /npmmirror\.com/);
    assert.match(source, /electron-builder/);
  });

  test('打包产物目录被 gitignore（lib/ 与 dist/ 都不入库）', () => {
    const ignore = readPackageFile('../.gitignore');
    assert.match(ignore, /dsh-pet\/lib\//);
    assert.match(ignore, /dsh-pet\/dist\//);
  });
});

describe('桌面壳仍以 CJS 被加载（包根是 type: module）', () => {
  test('runtime/electron-helper/package.json 没有 type 字段且 main 指向 main.js', () => {
    const helperPkg = JSON.parse(readPackageFile('runtime/electron-helper/package.json')) as {
      type?: string;
      main?: string;
    };
    assert.equal(helperPkg.type, undefined, '缺这个字段会被包根的 type: module 判成 ESM，main.js 直接崩');
    assert.equal(helperPkg.main, 'main.js');
  });
});
