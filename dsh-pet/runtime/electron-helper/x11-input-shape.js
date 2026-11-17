'use strict';
/**
 * Linux/X11 固定输入区域：用 Shape 扩展把窗口的输入区限定为一组矩形。
 *
 * 为什么不再用 setIgnoreMouseEvents：那套方案需要在「窗口可交互 / 整窗穿透」之间来回翻转，
 * 靠主进程 60ms 轮询光标位置追赶，存在两个固有缺陷——① 光标刚进入身体到下一拍翻转之间有一个
 * 时间窗，落在这个窗口里的点击会被透传给下层应用；② 翻转状态与 X Server 的实际输入形状可能
 * 失步，一旦失步就只能靠最小化/重映射恢复。Shape 是静态的：窗口永远是一个正常的可聚焦窗口，
 * 输入形状由 X Server 直接裁剪成「宠物身体 + 打开的菜单/气泡」，不依赖轮询，也没有竞态。
 *
 * 坐标一律是窗口内坐标（物理像素），与 setBounds 上报的命中区同源。
 * @module dsh-pet/runtime/electron-helper/x11-input-shape
 */

const { handshake } = require('./x11-pointer.js');

/** X11 核心请求：QueryExtension */
const QUERY_EXTENSION = 98;
/** Shape 扩展的 Rectangles 请求（minor opcode） */
const SHAPE_RECTANGLES = 1;
/** Shape 的输入形状枚举（0 = Bounding，1 = Clip，2 = Input） */
const SHAPE_INPUT = 2;

/** 4 字节对齐补零数 */
function pad4(n) {
  return (4 - (n % 4)) % 4;
}

/**
 * 问 X Server 要一个扩展的主操作码。
 *
 * @param socket - 已握手的 X11 连接。
 * @param name - 扩展名（本模块只用 'SHAPE'）。
 * @returns 主操作码；扩展不存在时为 0。
 */
function queryExtension(socket, name) {
  return new Promise((resolve, reject) => {
    const nameBuf = Buffer.from(name, 'latin1');
    const length = 8 + nameBuf.length + pad4(nameBuf.length);
    const req = Buffer.alloc(length);
    req[0] = QUERY_EXTENSION;
    req.writeUInt16LE(length / 4, 2);
    req.writeUInt16LE(nameBuf.length, 4);
    nameBuf.copy(req, 8);

    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('X11 QueryExtension timeout'));
    }, 1000);
    timer.unref?.();
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 32) return;
      cleanup();
      const reply = buffer.subarray(0, 32);
      // QueryExtension 应答头 8 字节（response_type/pad/sequence/length）：present 在 8、主操作码在 9
      resolve(reply[0] === 1 && reply[8] === 1 ? reply[9] : 0);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(req);
  });
}

/**
 * 创建输入形状写入器。
 *
 * 懒连接：第一次 set 时才握手；连接失败只记一次日志并继续尝试下一次，不拖垮主进程。
 * @param options.display - X display（默认取 DISPLAY）。
 * @param options.log - 失败日志出口（默认 console.error）。
 * @returns set(windowId, rects) 与 close()。
 */
function createX11InputShape(options = {}) {
  const display = options.display || process.env.DISPLAY || ':0';
  const log = options.log || ((message) => console.error('[dsh-pet-x11-shape] ' + message));
  let socket = null;
  let shapeOpcode = 0;
  let connecting = null;
  let lastKey = '';

  function ensure() {
    if (socket && shapeOpcode > 0) return Promise.resolve(true);
    if (connecting) return connecting;
    connecting = handshake(display)
      .then(async ({ socket: s }) => {
        const opcode = await queryExtension(s, 'SHAPE');
        if (!opcode) {
          s.destroy();
          throw new Error('SHAPE extension unavailable');
        }
        socket = s;
        shapeOpcode = opcode;
        const reset = () => {
          socket = null;
          shapeOpcode = 0;
        };
        s.on('error', reset);
        s.on('close', reset);
        return true;
      })
      .catch((error) => {
        log(String(error && error.message ? error.message : error));
        return false;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }

  /**
   * 把窗口输入区设为给定矩形集合（并集）。
   *
   * @param windowId - X11 窗口 ID（BrowserWindow.getNativeWindowHandle 的低 32 位）。
   * @param rects - 窗口内坐标的矩形数组；空数组按 1×1 处理（等价于整窗穿透）。
   */
  function set(windowId, rects) {
    if (!windowId) return;
    const normalized = (Array.isArray(rects) ? rects : [])
      .filter((r) => r && r.width > 0 && r.height > 0)
      .map((r) => ({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }));
    const list = normalized.length > 0 ? normalized : [{ x: 0, y: 0, width: 1, height: 1 }];
    const key = windowId + ':' + JSON.stringify(list);
    if (key === lastKey) return;
    void ensure().then((ok) => {
      if (!ok || !socket) return;
      const bytes = 16 + list.length * 8;
      const req = Buffer.alloc(bytes);
      req[0] = shapeOpcode;
      req[1] = SHAPE_RECTANGLES;
      req.writeUInt16LE(bytes / 4, 2);
      // 头 16 字节：op(4) destKind(5) ordering(6) pad(7) dest(8) xOff(12) yOff(14)
      req[4] = 0; // ShapeSet
      req[5] = SHAPE_INPUT;
      req[6] = 0; // UnSorted
      req[7] = 0;
      req.writeUInt32LE(windowId >>> 0, 8);
      req.writeInt16LE(0, 12);
      req.writeInt16LE(0, 14);
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const offset = 16 + i * 8;
        req.writeInt16LE(r.x, offset);
        req.writeInt16LE(r.y, offset + 2);
        req.writeInt16LE(r.width, offset + 4);
        req.writeInt16LE(r.height, offset + 6);
      }
      socket.write(req);
      lastKey = key;
    });
  }

  /** 关掉连接（进程退出前调用，避免定时器/句柄拖住退出）。 */
  function close() {
    if (!socket) return;
    socket.destroy();
    socket = null;
    shapeOpcode = 0;
  }

  return { set, close };
}

module.exports = { createX11InputShape };
