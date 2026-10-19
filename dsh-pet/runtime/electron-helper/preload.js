// preload 桥：只暴露窗口控制原语——
//   - setBounds：宠物窗口逐帧跟随（renderer 上报包围盒的屏幕坐标，主进程 setContentBounds）。
//     x/y/width/height = 窗口内容区坐标（用于移动窗口）；boxX/boxY = 宠物包围盒左上角
//     （工作区坐标）——碰撞站场必须用包围盒坐标，不能用窗口坐标（窗口 = 包围盒 + 四周外扩 margin，
//     差半只宠物宽，会让跨窗碰撞检测整体错位）。
//     size/bottomPad = 碰撞站场登记用（静止宠物只发 set-bounds，靠它带上尺寸才能被其它
//     飞行宠物撞到）；vx/vy = 当前速度（飞行中实时值，静止/拖拽 = 0）。
//     marginL/marginT = 窗口左右/上余量（DIP）——主进程算宠物身体命中区要用。**不能再省**：
//     上边距按气泡最大高度加高后余量不再四边相等，主进程按「窗口宽/4」反推会让命中区整体偏上。
//   - setInteractive：点击穿透翻转——窗口默认整窗穿透（透明像素不挡下层应用），
//     renderer 在光标进/出宠物身体命中区时上报，主进程 setIgnoreMouseEvents 翻转。
//   - setInputBusy：**我正在用这个窗口的鼠标输入**（拖拽中 / 菜单开着 / 对话弹窗开着），
//     由渲染端上报。主进程光看光标位置与窗口位移分不清"拖拽跟手"和"漫游/抛掷"，而渲染端知道。
//     busy 期间主进程的兜底通道**绝不翻回穿透**（一旦翻回，渲染端正在用的 window 级
//     pointermove/pointerup 就断了：宠物会按旧速度飞出去，连松手的 pointerup 都收不到）。
//     只在状态翻转时发一次（幂等，不逐帧）。
//   - 宠物间碰撞（跨窗，主进程 broker）：
//       reportFlight：飞行中每 ~30ms 上报自己的状态（位置/速度/尺寸）→ 主进程汇聚并广播；
//       onFlightStates：订阅主进程广播的全量宠物状态（碰撞检测用其它宠物的最新位置/速度）；
//       reportCollide：本窗飞行方检测到撞到 targetId → 主进程把动量结果转发给目标窗；
//       onPetHit：订阅「你被撞了」→ 用新初速 startThrow 抛出去（与浏览器 onHit 同语义）。
const { contextBridge, ipcRenderer } = require('electron');
// 焦点策略：「这个元素要不要键盘」的纯判定（与 main 侧同一份模块，可单测）
const { needsKeyboardFocus } = require('./focus-lease.js');

contextBridge.exposeInMainWorld('petBridge', {
  setBounds(x, y, width, height, boxX, boxY, size, bottomPad, vx, vy, marginL, marginT) {
    ipcRenderer.send('pet:set-bounds', {
      x,
      y,
      width,
      height,
      boxX,
      boxY,
      size,
      bottomPad,
      vx,
      vy,
      marginL,
      marginT,
    });
  },
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  // 忙碌态配合 setInputRegions：拖拽持续捕获，菜单/聊天框外仍可点击其它应用。
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  setInputRegions(input) {
    ipcRenderer.send('pet:input-regions', input);
  },
  // 右键菜单「打开网站」：主进程按宿主形态打开——桌面应用宿主唤起桌面窗口（dsh://open），否则系统默认浏览器打开 DSH 网站（等效网页 Ctrl+点击链接）
  openDshSite(url) {
    ipcRenderer.send('pet:open-site', { url });
  },
  // ---- 宠物间碰撞（跨窗 broker）----
  reportFlight(state) {
    ipcRenderer.send('pet:report-flight', state);
  },
  onFlightStates(cb) {
    ipcRenderer.on('pet:flight-states', (e, states) => cb(states));
  },
  reportCollide(targetId, vx, vy) {
    ipcRenderer.send('pet:collide-result', { targetId, vx, vy });
  },
  onPetHit(cb) {
    ipcRenderer.on('pet:hit', (e, payload) => cb(payload));
  },
  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转后主进程重算桌面几何并推来
  // （{hull, areas, primaryIndex}，屏幕坐标）——渲染端就地重挂视口与边界。
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (e, geo) => cb(geo));
  },
  // 键盘租约：窗口默认**不可激活**（点击不抢前台，全屏游戏里误触宠物不会把游戏打回桌面），
  // 只有手指真的落到文本控件时主进程才临时解锁并要前台（下方 pointerdown/focusin 自动收发；
  // 这里额外暴露手动入口，供渲染端在特殊流程里显式声明）。
  setKeyboardFocus(want) {
    ipcRenderer.send('pet:keyboard-focus', !!want);
  },
});

// ---- 键盘租约自动收发（唯一入口是 pointerdown / focusin / focusout / blur）----
// 为什么放在 preload 而不是渲染端：这是「窗口该不该被激活」的宿主级事实，preload 天然能看到
// 页面里任何一处文本控件，不必让每个弹窗各自记得上报（漏一处 = 那个弹窗打不了字）。
//
// **触发必须挂在 pointerdown 上，不能只靠 focusin**（真实 Electron 窗口实测）：窗口处于
// 非激活态（WS_EX_NOACTIVATE）时，`input.focus()` 只改 `document.activeElement`，**focusin 不发声**
// ——只在 focusin 上要租约，等于"越打不了字越要不来键盘"。鼠标事件反过来照常到达，
// 所以「点进输入框」这一刻就是唯一可靠的信号；focusin 留着接窗口本来就激活时的键盘 Tab 切换。
let keyboardWanted = false;
let releaseTimer = null;
/** 用户最后点/聚焦的那一格文本控件：拿到租约、窗口真激活之后把光标还给它 */
let lastText = null;

const askKeyboard = (want) => {
  if (want === keyboardWanted) return;
  keyboardWanted = want;
  ipcRenderer.send('pet:keyboard-focus', want);
};
const cancelRelease = () => {
  if (releaseTimer === null) return;
  clearTimeout(releaseTimer);
  releaseTimer = null;
};

document.addEventListener(
  'pointerdown',
  (e) => {
    if (!needsKeyboardFocus(e.target)) return;
    lastText = e.target;
    cancelRelease();
    askKeyboard(true);
  },
  true,
);
document.addEventListener(
  'focusin',
  (e) => {
    if (!needsKeyboardFocus(e.target)) return;
    lastText = e.target;
    cancelRelease();
    askKeyboard(true);
  },
  true,
);
document.addEventListener(
  'focusout',
  () => {
    // 焦点在控件之间移动时 focusout 早于 focusin，所以延到下一个宏任务再判：
    // 只有「窗口还活着 + 新焦点仍是文本控件」才继续持有；否则收回。
    cancelRelease();
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (document.hasFocus() && needsKeyboardFocus(document.activeElement)) return;
      askKeyboard(false);
    }, 0);
  },
  true,
);
// 页面失活（用户点了别处 / 切走了）必然打不了字：立刻收回，绝不留着可激活态给下一次误触用
window.addEventListener('blur', () => {
  cancelRelease();
  askKeyboard(false);
});
// 主进程解锁并拿到前台之后回执：此刻窗口已激活，DOM 焦点事件恢复正常，把光标还给用户点的那一格
ipcRenderer.on('pet:keyboard-granted', () => {
  if (!lastText || document.activeElement === lastText) return;
  try {
    lastText.focus();
  } catch {
    /* 元素已被移除（弹窗关了）：忽略，下一条 pointerdown 会重新要 */
  }
});
