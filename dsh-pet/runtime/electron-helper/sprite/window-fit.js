/**
 * 窗口落位与上报：把「本体屏幕位置」换算成窗口矩形，把窗口管理器钳掉的那截转成本体偏移，再报给主进程。
 *
 * 四边都钳：贴顶时窗口停在 y=0，本体在窗口内下移，窗口上方那截余量正好留给气泡。
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * @module dsh-pet/runtime/electron-helper/sprite-window-fit
 */
'use strict';

Object.assign(PetSprite.prototype, {
  /**
   * 越界允许量：命中区至少留 MIN_REACHABLE_PX 在屏幕内，其余部分可以挂到屏幕外。
   * 与网页端 clampReachableBox 同一条规则：宠物能挂出去，但右键永远点得到。
   * 上/下按「命中区的另一条边」留：挂在上方时留的是底边，挂在下方时留的是顶边。
   */
  reachInset() {
    const hit = this.hitRect;
    const keep = S.MIN_REACHABLE_PX;
    return {
      left: hit.x + hit.w - keep,
      right: this.size - hit.x - keep,
      top: hit.y + hit.h - keep,
      bottom: this.winH - hit.y - keep,
    };
  },

  /**
   * 算窗口落位并就地应用本体偏移；所有位移经 sendBounds 逐帧走到这里。
   *
   * @returns 窗口内容区（屏幕坐标系，CSS 像素）x/y/width/height 与本体在窗口内的偏移 offsetX/offsetY。
   */
  fitWindow() {
    const width = this.size + this.margin.l + this.margin.r;
    const height = this.winH + this.margin.t + this.margin.b;
    // 工作区取本体中心所在那块屏：窗口跨屏时按本体所在屏钳，与「窗口被关在单屏工作区内」一致
    const area = CONFIG.isWindowClampedToWorkArea
      ? S.resolveRect(WORK_AREAS, this.pos.x + this.halfW, this.pos.y + this.halfH)
      : undefined;
    const fit = S.fitWindowInArea({
      bodyX: this.pos.x,
      bodyY: this.pos.y,
      width,
      height,
      bodyWidth: this.size,
      // 纵向是「精灵总高」（含脚底透明垫），不是视频高：偏移上限按精灵算才对得上窗口尺寸
      bodyHeight: this.winH,
      insetX: this.margin.l,
      insetY: this.margin.t,
      reach: this.reachInset(),
      area,
    });
    this.applyWinOffset(fit.offsetX, fit.offsetY);
    return { x: fit.x, y: fit.y, width, height, offsetX: fit.offsetX, offsetY: fit.offsetY };
  },

  /** 本体在窗口内的偏移落到 DOM；逐帧调用，值没变就不写样式。 */
  applyWinOffset(x, y) {
    if (this.winOffset.x === x && this.winOffset.y === y) return;
    this.winOffset.x = x;
    this.winOffset.y = y;
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
    window.__dshPetDebug.winOffset = { x, y };
  },

  /**
   * 把窗口落位连同宠物状态报给主进程：命中区判定与跨窗碰撞站场都读这一份。
   *
   * @param fit - fitWindow 的返回值。
   */
  reportWindow(fit) {
    if (!window.petBridge) return;
    // 完整状态一次捎带：size/bottomPad 让静止宠物从首帧起就登记进碰撞站场；
    // vx/vy 带当前速度（飞行中实时值、静止/拖拽 = 0），避免落地后残留旧速度干扰碰撞动量。
    const fly = this.throwState;
    window.petBridge.setBounds(
      toScreen(fit.x + VIEW.x),
      toScreen(fit.y + VIEW.y),
      toScreen(fit.width),
      toScreen(fit.height),
      toScreen(this.pos.x), // 包围盒左上角（碰撞站场用：窗口坐标 ≠ 包围盒坐标）
      toScreen(this.pos.y),
      toScreen(this.size),
      toScreen(this.bottomPad),
      fly ? toScreen(fly.vx) : 0,
      fly ? toScreen(fly.vy) : 0,
      // 窗口原点到本体原点的距离（DIP）：主进程据此算命中区，它不再恒等于余量——窗口被钳后
      // 偏移变大，只能按上报值算，不能按「窗口宽/4」反推（见 spriteHitRect）。
      toScreen(fit.offsetX),
      toScreen(fit.offsetY),
    );
  },
});
