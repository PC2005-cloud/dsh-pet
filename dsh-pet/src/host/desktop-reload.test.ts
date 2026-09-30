/**
 * 桌面端「重载配置」契约测试：右键菜单 → POST /dsh-pet-7340/reload → 宿主 syncDesktop()。
 *
 * 背景：桌面宠物的配置只在 Helper 启动时拉一次（renderer.js 的 boot → GET /config），手改配置文件后
 * 桌面端不会自己跟上——此前唯一的生效途径是回设置页点「保存」，而保存只是顺带重启了 Helper。
 * 菜单项「重载配置」把这条路径显式暴露出来（浏览器端刷新页面即可，故为桌面专属）。
 *
 * 为什么必须走「宿主重启 Helper」而不是渲染端就地重拉配置：
 *   ① 每只桌面宠物一个窗口，是宿主启动时按 DSH_PET_PETS 建的——就地重拉改不了宠物数量 / display / size；
 *   ② 本页的余额 / 触发计数 / 工作状态等全局轮询由 events.js 的 loopsStarted 一次性启动，
 *      就地重建 sprite 会漏启新循环（新宠物没有碎碎念/广播轮询）或留下旧定时器。
 * 因此「重载」必须复用 syncDesktop()（串行队列 + 等旧进程真正退出），不得自己实现一套停/起。
 *
 * 本文件钉住跨半侧契约（两半各自构建、无法互相 import，只能读源码断言）：
 *   ① 宿主有 POST /reload 路由，且它调用的正是 syncDesktop()，且**不写任何配置文件**；
 *   ② 桌面端菜单项与宿主路由名一致（从桌面源码抽出路由名再回查宿主：改名漏改一侧即失败）；
 *   ③ 浏览器端不得注入该项。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const sprite = readSource('../../runtime/electron-helper/sprite.js');
const clientPet = readSource('../client/pet.ts');
const menu = readSource('../shared/menu.ts');

describe('桌面端「重载配置」—— 菜单 → 宿主重启 Helper', () => {
  test('宿主：POST /reload 复用 syncDesktop()，且只重启、不写配置文件', () => {
    const block = /if \(rest === 'reload'\) \{([\s\S]*?)\n {4}\}/.exec(host);
    assert.ok(block, '宿主必须有 /reload 路由');
    const body = block[1];
    assert.ok(/method !== 'POST'/.test(body), 'reload 只接受 POST（重载是动作，不是可缓存的资源）');
    assert.ok(/void syncDesktop\(\)/.test(body), 'reload 必须复用 syncDesktop()：与保存同一条重启路径');
    assert.ok(
      !/writeFile|saveUserConfig|syncUserConfigFromDefault/.test(body),
      'reload 只重启 Helper，绝不碰配置文件（写盘是 PUT /config 的职责）',
    );
  });

  test('桌面端：菜单项存在、动作有分支，且请求的路由名与宿主一致', () => {
    assert.ok(/label: '重载配置', action: 'reload'/.test(sprite), '桌面端右键菜单必须有「重载配置」项');
    assert.ok(/leaf\.action === 'reload'/.test(sprite), 'onMenuAction 必须有 reload 分支（否则点了没反应）');
    const m = /fetch\(BASE \+ '\/([a-z-]+)', \{ method: 'POST' \}\)/.exec(sprite);
    assert.ok(m, "reloadDesktop() 必须 POST 到 BASE + '/<路由名>'（bridge 已支持 POST，无需新增 IPC）");
    const route = m[1];
    assert.ok(
      new RegExp(`rest === '${route}'`).test(host),
      `桌面端请求的路由 /${route} 在宿主不存在（改名只改了一侧）`,
    );
  });

  test('浏览器端不注入该项：网页刷新即可，重载是桌面专属', () => {
    assert.ok(!/action: 'reload'/.test(clientPet), '浏览器端不得有 reload 菜单项（它会重启整个桌面 Helper）');
  });

  test('syncDesktop 是唯一的重启入口：两个 /config 写接口与 /reload 都走它', () => {
    const calls = host.match(/void syncDesktop\(\)/g) ?? [];
    assert.equal(calls.length, 3, 'PUT /config、POST /config、POST /reload 都应走 syncDesktop()');
  });

  test('shared 菜单契约放行 reload（桌面壳注入该动作，类型必须包含它）', () => {
    assert.ok(/'reload'/.test(menu), "shared/menu.ts 的 MenuLeaf.action 必须包含 'reload'");
  });
});
