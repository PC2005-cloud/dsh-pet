/**
 * 桌面端「临时关闭桌宠」契约测试：右键菜单 → POST /dsh-pet-7340/pause → 宿主置位（内存态）→
 * 重启 Helper 只留托盘 → 托盘点「显示桌宠」→ POST /dsh-pet-7340/resume → 重启 Helper 建回窗口。
 *
 * 为什么与「重载配置」（desktop-reload.test.ts）分开写：那条路是维护动作（配置改了重拉），
 * 这条是**状态**动作（桌宠收起），跨半侧的接缝更多——宿主内存态 + Helper 托盘 + 浏览器 overlay
 * 三处都得跟上，任何一处漏改都会露出"点了关不掉 / 关了回不来 / 网页还在显示"的破绽。
 *
 * 本文件钉住跨半侧契约（两半各自构建、无法互相 import，只能读源码断言）：
 *   ① 宿主有 POST /pause 与 /resume，都复用 syncDesktop()、**都不写配置文件**，并把状态写进
 *      /state 的 sections.power（浏览器端据此停渲染）；
 *   ② 关闭期间手动动作（/balance /whisper /chat）与自动行为（余额轮询/碎碎念轮询/事件监听）
 *      全部短路——"完全停掉"的语义不能只靠"没有窗口"；
 *   ③ 桌面端菜单项与宿主路由名一致（从桌面源码抽出路由名再回查宿主：改名漏改一侧即失败）；
 *   ④ Helper 在 DSH_PET_PAUSED=1 时只建托盘、不开窗口，且"没有窗口"时不得退出进程
 *      （托盘是唯一恢复入口，退出了就再也点不回来）；
 *   ⑤ 浏览器端不注入该菜单项（它是桌面专属），但必须尊重 sections.power。
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
const hostState = readSource('./state.ts');
const helper = readSource('../../runtime/electron-helper/main.js');
const sprite = readSource('../../runtime/electron-helper/sprite.js');
const clientPet = readSource('../client/pet.ts');
const menu = readSource('../shared/menu.ts');

describe('桌面端「临时关闭桌宠」—— 菜单 → 宿主内存态 → 托盘恢复', () => {
  test('宿主：/pause 与 /resume 复用 syncDesktop()，且只重启、不写配置文件', () => {
    const block = /if \(rest === 'pause' \|\| rest === 'resume'\) \{([\s\S]*?)\n {4}\}/.exec(host);
    assert.ok(block, '宿主必须有 /pause · /resume 路由');
    const body = block[1];
    assert.ok(/method !== 'POST'/.test(body), '关闭/恢复都是动作，只接受 POST');
    assert.ok(/void syncDesktop\(\)/.test(body), '必须复用 syncDesktop()：与「重载配置」同一条重启路径');
    assert.ok(
      !/writeFile|saveUserConfig|syncUserConfigFromDefault/.test(body),
      '临时关闭是**内存态**：绝不碰配置文件（DSH 重启即恢复）',
    );
    assert.ok(
      /state\.writeSection\('power'/.test(body),
      '状态必须写进 /state 的 sections.power（浏览器 overlay 靠它一并停渲染）',
    );
  });

  test('宿主：sections.power 是合法段名（SectionName 必须包含 power）', () => {
    assert.ok(
      /SectionName = 'balance' \| 'workStatus' \| 'notify' \| 'power'/.test(hostState),
      "host/state.ts 的 SectionName 必须包含 'power'，否则写状态无法通过类型检查",
    );
  });

  test('宿主：关闭期间手动动作全部短路（"完全停掉"不能只靠没有窗口）', () => {
    const gated = [
      /if \(rest === 'balance'\) \{[\s\S]*?if \(petPaused\) return/,
      /if \(rest === 'whisper'\) \{[\s\S]*?if \(petPaused\) return/,
      /if \(rest === 'chat'\) \{[\s\S]*?if \(method === 'POST'\) \{[\s\S]*?if \(petPaused\) return/,
    ];
    for (const re of gated) assert.ok(re.test(host), '手动动作端点必须有 petPaused 门');
    const polls = host.match(/petPaused/g) ?? [];
    assert.ok(polls.length >= 8, '自动行为（余额/碎碎念轮询、工作状态、通知）也必须有 petPaused 门');
  });

  test('桌面端：菜单项存在、动作有分支，且请求的路由名与宿主一致', () => {
    assert.ok(/label: '临时关闭桌宠', action: 'close-all'/.test(sprite), '桌面端右键菜单必须有「临时关闭桌宠」项');
    assert.ok(/leaf\.action === 'close-all'/.test(sprite), 'onMenuAction 必须有 close-all 分支（否则点了没反应）');
    const m = /closeAllPets\(\) \{[\s\S]*?fetch\(BASE \+ '\/([a-z-]+)', \{ method: 'POST' \}\)/.exec(sprite);
    assert.ok(m, "closeAllPets() 必须 POST 到 BASE + '/<路由名>'");
    const route = m[1];
    assert.ok(
      new RegExp(`rest === '${route}'`).test(host),
      `桌面端请求的路由 /${route} 在宿主不存在（改名只改了一侧）`,
    );
  });

  test('桌面端：托盘恢复请求的路由名与宿主一致', () => {
    const m = /HOST_PREFIX \+ '\/([a-z-]+)'/.exec(helper);
    assert.ok(m, "托盘的「显示桌宠」必须 POST 到 HOST_PREFIX + '/<路由名>'");
    const route = m[1];
    assert.ok(new RegExp(`rest === '${route}'`).test(host), `托盘请求的路由 /${route} 在宿主不存在（改名只改了一侧）`);
  });

  test('Helper：DSH_PET_PAUSED=1 时只建托盘不开窗口', () => {
    assert.ok(/DSH_PET_PAUSED/.test(helper), 'Helper 必须读 DSH_PET_PAUSED');
    assert.ok(
      /if \(PAUSED\) showTray\(\);\s*\n\s*else createPetWindows\(\);/.test(helper),
      'whenReady 必须在关闭态只建托盘、否则才建宠物窗口',
    );
    assert.ok(/new Tray\(/.test(helper), '关闭态必须真的建出托盘（唯一恢复入口）');
  });

  test('Helper：「没有窗口」在关闭态是故意的，不得退出进程', () => {
    const block = /app\.on\('window-all-closed', \(\) => \{([\s\S]*?)\n\}\);/.exec(helper);
    assert.ok(block, 'Helper 必须有 window-all-closed 处理');
    assert.ok(
      /if \(!tray\) app\.quit\(\)/.test(block[1]),
      '有托盘时不得因为"窗口全关"就退出——退出了托盘随之消失，用户再也点不回来',
    );
  });

  test('浏览器端：不注入该菜单项，但必须尊重 sections.power', () => {
    assert.ok(!/action: 'close-all'/.test(clientPet), '浏览器端不得有 close-all 菜单项（关闭是桌面专属入口）');
    assert.ok(/sections\.power/.test(clientPet), '浏览器 overlay 必须读 sections.power，关闭期间一并停渲染');
  });

  test('shared 菜单契约放行 close-all（桌面壳注入该动作，类型必须包含它）', () => {
    assert.ok(/'close-all'/.test(menu), "shared/menu.ts 的 MenuLeaf.action 必须包含 'close-all'");
  });
});
