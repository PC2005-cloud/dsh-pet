/**
 * 开机自启的跨文件接线契约（ticket 09）。
 *
 * 纯逻辑（初始化决策/登录项适配层/延迟参数）在 autostart.test.ts 里测；这里钉住
 * Electron/NSIS 侧的接线不能改错：
 *   - 宿主在启动 standalone **之前**初始化默认自启，且延迟也在 startStandalone 之前；
 *   - 延迟期间收到 second-instance 只记 pending，不许提前启动服务（ticket 05 的闸门）；
 *   - 宿主进程不创建任何窗口（自启时不弹窗、不抢焦点）；
 *   - 托盘勾选走同一个适配层（读系统真实状态），不直接散调 Electron API；
 *   - 卸载清理 HKCU Run 启动项，但升级安装不得清除（否则升级后自启静默丢失）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读包根下的文件（本测试位于 src/host/，包根是两级之上） */
function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

const mainSource = readPackageFile('desktop/main.mjs');
const traySource = readPackageFile('desktop/tray.mjs');
const autostartSource = readPackageFile('src/host/autostart.ts');

describe('desktop/main.mjs —— 默认开启与自启启动时序', () => {
  const startStandaloneAt = mainSource.indexOf('await startStandalone(');

  test('宿主启动 standalone 之前初始化默认自启（只写一次）', () => {
    assert.match(mainSource, /\.\.\/lib\/autostart\.js/, '必须复用 src/host/autostart.ts 的构建产物');
    const initAt = mainSource.indexOf('applyDefaultAutostart(app)');
    assert.ok(initAt > 0, '宿主必须调用默认自启初始化');
    assert.ok(startStandaloneAt > 0, '宿主必须启动 standalone');
    assert.ok(initAt < startStandaloneAt, '默认自启初始化必须在启动服务之前');
    assert.match(mainSource, /initializeAutostartOnce\(/);
    assert.match(mainSource, /createLoginItemAdapter\(app\)/);
    assert.match(mainSource, /createFileMarker\(defaultAutostartMarkerPath\(\)\)/);
    // 初始化失败不能拖垮宿主（宠物窗口与托盘仍要起来）
    assert.match(mainSource, /初始化开机自启失败/);
  });

  test('--autostart 的延迟发生在 startStandalone 之前，默认可被环境变量覆盖', () => {
    const delayAt = mainSource.indexOf('resolveAutostartDelayMs(process.env)');
    assert.ok(delayAt > 0, '必须用 resolveAutostartDelayMs(process.env) 解析延迟');
    assert.ok(delayAt < startStandaloneAt, '延迟必须在启动服务之前（登录后约 4 秒才出现桌宠）');
    assert.match(mainSource, /if \(invocation\.autostart && delayMs > 0\)/);
    assert.match(mainSource, /await sleep\(delayMs\)/);
    // 延迟不能在入口的顶层 await 里：否则 Electron 的 ready / second-instance 处理都会被
    // 推迟到延迟结束，用户双击的第二个进程会一直挂到那时才退出（实测约等于延迟时长）。
    assert.match(mainSource, /void startHost\(app\)/);
    assert.ok(!/await startHost\(/.test(mainSource), '宿主启动不得阻塞入口求值');
  });

  test('延迟期间收到 second-instance 只置 pending，绝不提前 startStandalone', () => {
    const handlerStart = mainSource.indexOf("app.on('second-instance'");
    assert.ok(handlerStart > 0, '必须监听 second-instance');
    const handlerEnd = mainSource.indexOf('});', handlerStart);
    assert.ok(handlerEnd > handlerStart, '必须能找到 second-instance 处理块');
    const handler = mainSource.slice(handlerStart, handlerEnd);
    assert.match(handler, /gate\.request\(\)/);
    assert.ok(!handler.includes('startStandalone'), 'second-instance 不得提前启动服务/打断延迟');
  });

  test('宿主进程不创建任何窗口（自启不弹窗、不抢焦点）', () => {
    assert.ok(!/new BrowserWindow/.test(mainSource), '宿主角色只跑服务与托盘，窗口由桌面壳创建');
  });
});

describe('desktop/tray.mjs —— 勾选读系统真实状态', () => {
  test('自启读写走 autostart 适配层，不直接散调 Electron 登录项 API', () => {
    assert.match(traySource, /\.\.\/lib\/autostart\.js/);
    assert.match(traySource, /createLoginItemAdapter\(app\)/);
    assert.match(traySource, /loginItem\.isEnabled\(\)/);
    assert.match(traySource, /loginItem\.setEnabled\(/);
    assert.ok(!/app\.getLoginItemSettings\(/.test(traySource), '状态判断必须集中在适配层');
    assert.ok(!/app\.setLoginItemSettings\(/.test(traySource), '写入必须集中在适配层');
  });

  test('参数恒含 --autostart（set 与 get 比对同一个启动项）', () => {
    assert.match(autostartSource, /AUTOSTART_ARGS[^=]*=\s*\['--autostart'\]/);
    assert.match(autostartSource, /getLoginItemSettings\(\{ args: \[\.\.\.AUTOSTART_ARGS\] \}\)/);
    assert.match(autostartSource, /args: \[\.\.\.AUTOSTART_ARGS\]/);
  });
});

describe('NSIS 卸载 —— 清理 HKCU Run 启动项', () => {
  const nsh = readPackageFile('build/installer.nsh');
  const yml = readPackageFile('electron-builder.yml');

  test('electron-builder 挂上自定义卸载宏', () => {
    assert.match(yml, /include:\s*build\/installer\.nsh/);
  });

  test('卸载删除 Electron 登录项（值名由 Electron 生成，按安装目录 + --autostart 匹配）', () => {
    assert.match(nsh, /!macro customUnInstall/);
    assert.match(nsh, /HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
    assert.match(nsh, /DeleteRegValue/, '必须真正删除注册表值');
    assert.match(nsh, /EnumRegValue/, '值名不可硬编码：Electron 用 electron.app.<app name>');
    assert.match(nsh, /--autostart/, '只删除本应用的启动项，不误伤其它软件');
    assert.match(nsh, /APP_EXECUTABLE_FILENAME|\$INSTDIR/, '匹配当前安装目录下的可执行文件');
    assert.match(nsh, /StartupApproved/, '任务管理器禁用态也应一并清理');
  });

  test('升级安装（isUpdated）不得清除启动项，否则升级后自启静默丢失', () => {
    assert.match(nsh, /isUpdated/);
    const guardAt = nsh.indexOf('isUpdated');
    const deleteAt = nsh.indexOf('DeleteRegValue');
    assert.ok(guardAt >= 0 && deleteAt > guardAt, '删除逻辑必须包在 !isUpdated 保护里');
  });
});

describe('构建产物 —— lib/autostart.js 必须进包', () => {
  test('tsdown 产出 autostart 入口', () => {
    assert.match(readPackageFile('tsdown.config.mjs'), /autostart:\s*['"]src\/host\/autostart\.ts['"]/);
  });

  test('electron-builder 的 lib/** 白名单覆盖新入口', () => {
    assert.match(readPackageFile('electron-builder.yml'), /lib\/\*\*\/\*/);
  });
});
