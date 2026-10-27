/**
 * preload 桥：向渲染端暴露窗口控制与跨窗碰撞的原语。
 *
 * 只做 IPC 转发，不持有状态、不做判定；翻转与判定都在主进程。依赖 Electron 的
 * contextBridge/ipcRenderer，频道名必须与主进程逐字一致。
 *
 * @module dsh-pet/runtime/electron-helper/preload
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  // 宠物窗口逐帧跟随：x/y/width/height 是窗口内容区坐标（用于移动窗口），
  // boxX/boxY 是宠物包围盒左上角的工作区坐标——碰撞站场必须用包围盒，窗口坐标差半只宠物宽。
  // size/bottomPad 让静止宠物也登记进碰撞站场，vx/vy 是当前速度（静止/拖拽为 0）。
  // marginL/marginT 是窗口左右/上余量：上边距按气泡最大高度加高后余量不再四边相等，
  // 主进程不能按「窗口宽/4」反推命中区，所以必须上报。
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
  // 点击穿透翻转：窗口默认整窗穿透，渲染端在光标进出身体命中区时上报。
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  // 我正在用这个窗口的鼠标输入（拖拽中/菜单开/弹窗开）。主进程光看光标与窗口位移分不清
  // 拖拽跟手与漫游/抛掷，而渲染端知道；busy 期间兜底通道绝不翻回穿透，否则输入链会断。
  // 只在状态翻转时发一次，不逐帧。
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  // 控件矩形：菜单/聊天框只让自己那块接收点击，其余透明区域继续穿透。
  setInputRegions(input) {
    ipcRenderer.send('pet:input-regions', input);
  },
  /**
   * 上报窗口形状（Linux `shape` 输入模型）：矩形是**窗口内容区坐标**，形状之外不接收鼠标也不绘制。
   * @param {{rects: Array<{x:number,y:number,width:number,height:number}>}} input 形状矩形
   */
  setShape(input) {
    ipcRenderer.send('pet:shape', input);
  },
  // 右键菜单「打开网站」：去向由主进程按宿主形态决定——桌面应用宿主唤起主窗口，否则用系统浏览器打开站点。
  openDshSite(url) {
    ipcRenderer.send('pet:open-site', { url });
  },
  // 截一帧桌面（宠物所在那块屏）：一次性读取，不建流、不留存。
  // 返回 { mediaType, data, width, height, bytes } 或 null（取不到画面）。
  captureScreen() {
    return ipcRenderer.invoke('pet:capture-screen');
  },
  // 宠物间碰撞（跨窗 broker）：飞行方上报状态，主进程汇聚广播；被撞方收 pet:hit 后按新初速抛出。
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
  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转后主进程重算并推来桌面几何（屏幕坐标），
  // 渲染端就地重挂视口与边界。
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (e, geo) => cb(geo));
  },
});
