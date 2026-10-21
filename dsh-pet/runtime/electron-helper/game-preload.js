// 「弹弓」窗口的 preload 桥：只暴露一个口子——
//   reportInput({regions, busy})：页面把可交互区域（宠物身体 / 右键菜单，CSS 像素）与「正拿着鼠标」
//   （拖拽 / 菜单开着）告诉主进程；主进程按真实光标位置决定整窗穿透与否（见 game-launch.js 的 gameIgnoresMouse）。
// 只在状态变化时发（页面侧去重），不逐帧。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameBridge', {
  reportInput(input) {
    ipcRenderer.send('game:input', input);
  },
});
