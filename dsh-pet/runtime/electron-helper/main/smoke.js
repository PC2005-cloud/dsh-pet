'use strict';
/**
 * 冒烟自检：DSH_PET_SMOKE=1 时延时检查窗口、渲染、动画与交互链路，截图后退出。
 *
 * 只在开发与排查时进入；检查项要读主进程侧的窗口表与穿透镜像，所以由调用方传入，不自己持状态。
 * @module dsh-pet/runtime/electron-helper/main-smoke
 */

const path = require('node:path');
const { writeFileSync } = require('node:fs');

/**
 * 跑一次冒烟检查。
 * @param deps.app - Electron app（退出与临时目录）。
 * @param deps.windows - 宠物窗口表。
 * @param deps.windowIgnore - 每个窗口当前是否穿透（主进程镜像）。
 * @param deps.setPointerFallbackPaused - 检查穿透往返期间暂停兜底轮询。
 */
function runSmokeCheck({ app, windows, windowIgnore, setPointerFallbackPaused }) {
  const smokeOut = process.env.DSH_PET_SMOKE_OUT || path.join(app.getPath('temp'), 'dsh-pet-smoke.png');
  const afterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS || 9000);
  const target = windows.values().next().value;
  if (target) {
    // 转发渲染端 console（定位动画/余额/错误问题）
    target.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`);
    });
  }
  setTimeout(async () => {
    try {
      const first = windows.values().next().value;
      if (first && !first.isDestroyed()) {
        const dump = await first.webContents.executeJavaScript(`(async () => ({
          hasBridge: typeof window.petBridge !== 'undefined',
          hasSetInteractive: typeof window.petBridge?.setInteractive === 'function',
          viewport: window.innerWidth + 'x' + window.innerHeight,
          dpr: window.devicePixelRatio,
          debug: window.__dshPetDebug || null,
          sprites: document.querySelectorAll('.pet-sprite').length,
          errorVisible: document.getElementById('pet-error').classList.contains('visible'),
          errorText: document.getElementById('pet-error').textContent,
          firstBubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent.slice(0, 120),
          hitCursor: (function () {
            var hit = document.querySelector('.pet-hit');
            return hit ? getComputedStyle(hit).cursor : '';
          })(),
          dragTransform: (function () {
            var hit = document.querySelector('.pet-hit');
            var stage = document.querySelector('.pet-stage');
            if (!hit || !stage) return 'no-sprite';
            var out = { idle: stage.style.transform };
            hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
            out.duringClick = stage.style.transform;
            hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
            out.afterClick = stage.style.transform;
            hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200, screenX: 200, screenY: 200, pointerId: 92 }));
            hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
            out.duringDrag = stage.style.transform;
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
            out.afterDrag = stage.style.transform;
            return out;
          })(),
          releaseKeptPosition: await (async function () {
            // 独立不变量：把宠物先拖到工作区内的固定安全点（600,300），松手后窗口位置必须原地不动。
            // 拖拽抛掷物理（弹簧跟手+甩抛）下：指针长距跳跃后弹簧需要 ~0.3s 收敛，
            // 松手前停留超过 RELEASE_STALE_MS(150ms) 判为「温柔放下」（估速 null，不抛掷）——
            // 所以先等弹簧到位、再停留才松手，只测"释放瞬间是否位移"。
            var d = window.__dshPetDebug;
            var hit = document.querySelector('.pet-hit');
            if (!d || !d.dragPos || !hit) return null;
            var P = { x: d.dragPos.x, y: d.dragPos.y };
            var T = { x: 600, y: 300 }; // 目标窗口左上角（1708×1020 工作区内，远离四边）
            var upX = 1000 + (T.x - P.x);
            var upY = 600 + (T.y - P.y);
            var sleep = function (ms) {
              return new Promise(function (r) {
                setTimeout(r, ms);
              });
            };
            hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, clientY: 600, screenX: 1000, screenY: 600, pointerId: 93 }));
            hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
            await sleep(400); // 弹簧跟随收敛
            var during = { x: d.dragPos.x, y: d.dragPos.y };
            await sleep(200); // 轨迹过期 → 估速 null → 温柔放下（不抛掷）
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
            await sleep(80); // 释放处理完成
            var released = d.lastDragRelease ? { x: d.lastDragRelease.x, y: d.lastDragRelease.y } : null;
            return {
              during: during,
              released: released,
              kept: !!(released && Math.abs(released.x - during.x) <= 1 && Math.abs(released.y - during.y) <= 1),
            };
          })(),
          interactiveFlip: (function () {
            // 点击穿透命中判定：光标在命中区内→可交互；移出→穿透；拖拽中（pointer 已捕获）→强制可交互。
            // hitRect 是 sprite 坐标，mousemove 用窗口坐标——测试事件需加上本体在窗口内的偏移 winOffset。
            var d = window.__dshPetDebug;
            var hit = document.querySelector('.pet-hit');
            if (!d || !d.hitRect || !d.winOffset || !hit) return null;
            var r = d.hitRect;
            var m = d.winOffset;
            var xIn = m.x + r.x + r.w / 2;
            var yIn = m.y + r.y + r.h / 2;
            var xOut = Math.max(0, m.x + r.x - 20);
            var yOut = Math.max(0, m.y + r.y - 20);
            var out = {};
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn }));
            out.inside = d.interactive === true;
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
            out.outside = d.interactive === false;
            hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn, pointerId: 94 }));
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
            out.duringDragForced = d.interactive === true;
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut, pointerId: 94 }));
            return out;
          })(),
          videoSrcA: (document.querySelectorAll('.pet-sprite video')[0] || { src: '' }).src,
          videoSrcB: (document.querySelectorAll('.pet-sprite video')[1] || { src: '' }).src,
          // 右键菜单自检：在命中区派发 contextmenu → 校验菜单挂载/根文案/子面板/运行错误
          menuSmoke: await (async function () {
            // 前面 drag/release/interactive 测试刚拖过宠：justDragged 100ms 内屏蔽右键，
            // 真实用户不会拖完立刻右键——先等 250ms 消除该时序影响
            await new Promise(function (resolve) {
              setTimeout(resolve, 250);
            });
            var hit = document.querySelector('.pet-hit');
            var d = window.__dshPetDebug;
            if (!hit || !d) return null;
            var errsBefore = (d.errors || []).length;
            try {
              hit.dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 400, clientY: 260, screenX: 400, screenY: 260 }),
              );
            } catch (err) {
              return { threw: String(err), menuMounted: false };
            }
            var menu = document.querySelector('.dsh-pet-menu');
            var out = {
              threw: null,
              menuMounted: !!menu,
              menuOpen: d.menuOpen === true,
              rootText: menu ? menu.textContent.slice(0, 60) : '',
              errsNew: (d.errors || []).length - errsBefore,
            };
            if (menu) {
              var branch = menu.querySelector('.dsh-pet-menu-branch');
              if (branch) {
                branch.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: menu }));
                var panels = Array.prototype.slice.call(
                  menu.querySelectorAll('.dsh-pet-menu-column'),
                );
                var visible = function () {
                  return panels.filter(function (p) {
                    return p.style.display !== 'none';
                  });
                };
                out.panelCount = panels.length;
                out.lvl2AfterHoverRoot = visible().length;
                // 二级：悬停「动作」下的第一个分类 → 打开三级面板（具体动画）
                var panel1 = visible().filter(function (p) {
                  return p !== panels[0];
                })[0];
                if (panel1) {
                  var cat = panel1.querySelector('.dsh-pet-menu-branch');
                  if (cat) {
                    cat.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: panel1 }));
                    await new Promise(function (resolve) {
                      setTimeout(resolve, 50);
                    });
                    out.lvl3AfterHoverCat = visible().length;
                    // 重放用户路径：鼠标从分类项移向三级面板（先离开分类项进入 4px 缝隙，
                    // 再进入三级面板）——缝隙里 mouseleave 会排 160ms 关闭定时器
                    cat.dispatchEvent(
                      new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                    );
                    await new Promise(function (resolve) {
                      setTimeout(resolve, 60);
                    });
                    var panel2 = visible()[visible().length - 1];
                    if (panel2) {
                      panel2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                    }
                    await new Promise(function (resolve) {
                      setTimeout(resolve, 220);
                    });
                    out.lvl3SurvivedAfterReenter = visible().length;
                    // 极端情况：缝隙停留超过关闭延时（鼠标犹豫）
                    cat.dispatchEvent(
                      new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                    );
                    await new Promise(function (resolve) {
                      setTimeout(resolve, 260);
                    });
                    out.lvl3AfterGapHover = visible().length;
                  }
                }
              }
            }
            return out;
          })(),
        }))()`);
        console.log(
          '[dsh-pet-desktop-helper] smoke dump: windows=' +
            windows.size +
            ' ids=' +
            JSON.stringify([...windows.keys()]) +
            ' => ' +
            JSON.stringify(dump),
        );
        console.log('[dsh-pet-desktop-helper] smoke bounds:', JSON.stringify(first.getContentBounds()));
        // 点击穿透 round-trip：true → 窗口捕获输入，false → 恢复整窗穿透；状态取自主进程镜像。
        // 期间暂停兜底轮询：它按真实光标翻转，冒烟时鼠标不在宠物身上会覆盖本断言的状态。
        setPointerFallbackPaused(true);
        await first.webContents.executeJavaScript('window.petBridge.setInteractive(true); true;');
        await new Promise((r) => setTimeout(r, 80));
        const interactiveIgnoring = windowIgnore.get(first.id);
        await first.webContents.executeJavaScript('window.petBridge.setInteractive(false); true;');
        await new Promise((r) => setTimeout(r, 80));
        const passthroughIgnoring = windowIgnore.get(first.id);
        setPointerFallbackPaused(false);
        console.log(
          '[dsh-pet-desktop-helper] smoke interactive round-trip:',
          JSON.stringify({ interactiveIgnoring, passthroughIgnoring }),
        );
        const image = await first.webContents.capturePage();
        writeFileSync(smokeOut, image.toPNG());
        console.log('[dsh-pet-desktop-helper] smoke capture:', smokeOut);
      }
    } catch (error) {
      console.error('[dsh-pet-desktop-helper] smoke capture failed:', error);
    }
    setTimeout(() => app.quit(), 500);
  }, afterMs);
}

module.exports = { runSmokeCheck };
