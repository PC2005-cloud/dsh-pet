/**
 * 右键菜单：打开/关闭、叶子动作派发，以及菜单里用到的自绘节点渲染。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 菜单结构与文案来自 shared-core（两端同一份）；这里只决定点下去之后做什么。
 * @module dsh-pet/runtime/electron-helper/sprite-menu
 */
'use strict';

Object.assign(PetSprite.prototype, {
  onContextMenu(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged || this.menuOpen) return;
    e.preventDefault();
    this.stopThrow(); // 菜单弹出前停住飞行中的宠物
    this.stopMove(); // 菜单悬停期间宠物不漫游
    // 桌面专属工具根项 + 共享菜单树（动作 → 分类 → 具体动画）。碎碎念/对话无条件显示：手动触发
    // 不受 whisperEnabled 限制（该字段只影响自动轮询）。首项文案随宿主形态变：桌面宿主说「打开软件」。
    const tools = [
      {
        label: OPEN_TARGET === 'desktop' ? '打开软件' : '打开网站',
        action: 'open-site',
        hint: OPEN_SHORTCUT_HINT,
      },
    ];
    // 「查看余额」无条件显示：关了 balanceEnabled 的宠物也能点，手动请求不受开关限制，点了一定给答复。
    tools.push({ label: '查看余额', action: 'show-balance' });
    tools.push(
      { label: '碎碎念', action: 'whisper' },
      { label: '对话', action: 'chat', hint: S.CHAT_HOTKEY_HINT },
      { label: '回到初始位置', action: 'home' },
      // 显示位置（仅网页/仅桌面/两者/都不）：改这只宠物的 display 配置，由宿主重载生效。
      // 与浏览器端注入同一份子菜单，两端文案与取值不会漂移。不就地开关窗：窗口是进程启动时按
      // DSH_PET_PETS 一次性建的，就地增删既改不了磁盘配置也改不了窗口数量。
      S.displayMenuBranch(),
      // 重载配置：请宿主重启桌面 Helper，全部窗口按最新配置重建。放在最后——它是维护动作。
      { label: '重载配置', action: 'reload' },
    );
    // 第三方菜单项统一收在「更多」下：0 项不出现；某个 owner 只有 1 项时跳过 owner 那层直接平铺。
    // 放在整棵动作树之后——「更多」不插在工具项与动作之间。
    const more = S.buildMoreBranch(this.menuItems);
    const tree = tools.concat(S.buildMenuTree(this.animations), more ? [more] : []);
    if (!tree.length) return;
    this._marginBeforeMenu = { l: this.margin.l, t: this.margin.t };
    this.menuOpen = true;
    this.menuOpenedAt = performance.now(); // 宽限期起点：改窗口尺寸引发的 blur/leave 不算数
    this.setInteractive(true); // 菜单是窗口内 DOM：悬停期间整窗保持可交互，关闭后恢复命中区穿透
    this.syncInputBusy();
    // 开菜单会让余量变大，窗口原点随之左移/上移；e.clientX/Y 是**旧窗口**的坐标，
    // 必须按余量差补偿，否则菜单整体错位、还会跳一下（见 syncMargin）。
    const mDx = this.margin.l - this._marginBeforeMenu.l;
    const mDy = this.margin.t - this._marginBeforeMenu.t;
    window.__dshPetDebug.menuOpen = true;
    const m = S.mountContextMenu({
      tree,
      x: e.clientX + mDx,
      y: e.clientY + mDy,
      // 只允许在「窗口 ∩ 工作区」内显示：宠物贴边时外扩余量伸出屏幕，菜单走进那里会被 OS 裁掉
      clamp: this.visibleClampRect(),
      onAction: (leaf) => this.onMenuAction(leaf),
      // 菜单被点外/Esc 关闭（非菜单项路径）：同样复位可交互标记，恢复命中区判定
      onClose: () => {
        this.menuOpen = false;
        window.__dshPetDebug.menuOpen = false;
        this.syncInputBusy();
        if (!this.inputBusy()) this.setInteractive(false);
      },
    });
    this.menuClose = m.close;
    this.syncInputRegions(); // mountContextMenu 完成布局后才能读取菜单矩形
  },

  /** keepFacing = 调用方已显式指定朝向：跳过下面「文字类动画点播前强制朝左」的镜像修正，显式值优先。 */
  onMenuAction(leaf, keepFacing) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    if (leaf.action === 'third-party') {
      // 第三方菜单项：只把 (owner, label) 交给宿主，具体做什么由注册方自己查 /menu/events。
      // 带上宠物 id——同一条菜单项在不同宠物上被点，注册方要能分辨是哪只。
      if (leaf.owner) {
        S.postAction(BASE + '/menu/click', { owner: leaf.owner, label: leaf.label, pet: this.pet.id }).catch(() => {
          /* 上报失败不影响本地：注册方下次轮询自然拿不到这次触发 */
        });
      }
      return;
    }
    if (leaf.action === 'open-site') {
      if (window.petBridge) window.petBridge.openDshSite(ORIGIN); // 系统默认浏览器打开（等效 Ctrl+点击链接）
      return;
    }
    if (leaf.action === 'show-balance') {
      this.showBalanceFromMenu(); // 立即拉余额并展示（无需等 1s 触发轮询，展示路径与周期触发一致）
      return;
    }
    if (leaf.action === 'whisper') {
      this.showWhisperFromMenu(); // 立即让 host 强制新生成一句并展示（绕过节流；展示路径与周期触发一致）
      return;
    }
    if (leaf.action === 'chat') {
      this.showChatFromMenu(); // 打开对话弹窗（记忆经 host /chat 读写，浏览器/桌面同一实例共享）
      return;
    }
    if (leaf.action === 'home') {
      this.goHome(); // 停漫游/移动，清会话位置，回配置角落
      return;
    }
    if (leaf.action === 'set-display') {
      this.setPetDisplay(leaf.display); // 改这只宠物的显示位置：写 display 配置，由宿主重载生效
      return;
    }
    if (leaf.action === 'reload') {
      this.reloadDesktop(); // 请宿主重启桌面 Helper：全部桌面宠物窗口按最新配置重建
      return;
    }
    if (!leaf.anim) return;
    // 回执归属：这一段若来自第三方点播，编号跟着换源走（自播动画传 null）
    const playbackId = typeof leaf.playbackId === 'string' && leaf.playbackId ? leaf.playbackId : null;
    // 文字类（noMirror）朝右是镜像的：点播前强制朝左，避免文字镜像。keepFacing 时跳过（显式值优先）。
    if (!keepFacing && S.isNoMirrorAnimation(this.animations.categories, leaf.anim) && this.facing === 'right') {
      this.facing = 'left';
    }
    // 点播移动动画：走真实移动（与随机游走同一套），只有「选哪个动画」由菜单决定；挪不动则退化纯播放。
    if (this.animations.moves.actions.some((a) => a.name === leaf.anim)) {
      const moved = this.tryMove(leaf.anim, playbackId);
      if (moved === false) this.playOnce(leaf.anim, playbackId);
      // moved === true = 已有移动/抛掷在进行中（没换源）：本段不会真的播起来 → 如实回 failed/busy
      else if (moved === true && playbackId) this.reportPlayback(playbackId, 'failed', 'busy');
      return;
    }
    this.playOnce(leaf.anim, playbackId);
  },

  closeMenu() {
    if (this.menuClose) {
      this.menuClose();
      this.menuClose = null;
    }
    this.menuOpen = false;
    window.__dshPetDebug.menuOpen = false;
    this.syncInputBusy(); // 菜单关：若没有别的占用（拖拽/弹窗）则交还常规判定
    if (!this.inputBusy()) this.setInteractive(false);
  },

  // 「查看余额」菜单：POST 动作让宿主刷新余额。结果这里什么都不用做——写叶子会让版本号变，
  // 挂着的长轮询那一拍立刻返回并展示（同一展示路径）。数据只有一个出口（S），菜单只负责让它刷新。
  // 不做 balanceEnabled 门控：手动请求不受开关限制，关了余额的宠物被点一次也该看到数据。
  showBalanceFromMenu() {
    S.postAction(BALANCE_URL)
      .then((ok) => {
        if (!ok) console.warn('[dsh-pet] 菜单查看余额：刷新动作未成功');
      })
      .catch((e) => {
        console.error('[dsh-pet] 菜单查看余额异常', e);
      });
  },

  // 「碎碎念」菜单：POST 动作让宿主立即新生成一句（写进 S）。动作不回文本，文本随版本号变化由
  // 挂着的长轮询送达。手动触发不受 whisperEnabled 限制（该字段只关自动周期）。
  showWhisperFromMenu() {
    // surface 必填：本窗口就是桌面端
    S.postAction(WHISPER_URL + '?pet=' + encodeURIComponent(this.pet.id) + '&surface=desktop')
      .then((ok) => {
        if (!ok) console.warn('[dsh-pet] 菜单碎碎念：生成动作未成功 pet=' + this.pet.id);
      })
      .catch((e) => {
        console.warn('[dsh-pet] 菜单碎碎念异常', e);
      });
  },

  // 「对话」菜单：最简输入框（shared 组件）——回车发送后弹窗消失，回复用碎碎念同款显示（说话动画 +
  // 气泡 10s），只多一步用户输入。记忆经宿主 /chat 读写，同一实例的浏览器与桌面共享。
  // 弹窗跟随身体命中区 this.hit（桌宠在视频中间，视频框右上角 ≠ 宠物右上角），超出视口自动夹回；
  // 弹窗是窗口内 DOM，期间整窗保持可交互，关闭后恢复命中区穿透。
  showChatFromMenu(image) {
    if (this.chatClose) {
      this.chatClose();
      this.chatClose = null;
      return; // 已开着：先关旧的
    }
    const m = S.mountChatDialog({
      petId: this.pet.id,
      baseUrl: BASE + '/chat',
      surface: 'desktop',
      x: Math.max(4, this.hit.getBoundingClientRect().right + 6),
      y: Math.max(4, this.hit.getBoundingClientRect().top + 6),
      // 拖拽落到宠物身上时直接带着图开弹窗
      ...(image ? { initialImage: image } : {}),
      // 截屏：主进程取宠物所在屏的一帧（JPEG base64），形状与浏览器侧一致
      capture: async () => {
        if (!window.petBridge || typeof window.petBridge.captureScreen !== 'function') {
          throw new Error('当前环境不支持截屏');
        }
        const shot = await window.petBridge.captureScreen();
        if (!shot) throw new Error('没有取到屏幕画面');
        return {
          base64: shot.data,
          mediaType: shot.mediaType,
          bytes: shot.bytes,
          width: shot.width,
          height: shot.height,
          resized: true,
          previewUrl: 'data:' + shot.mediaType + ';base64,' + shot.data,
        };
      },
      // 弹窗同菜单：只允许在「窗口 ∩ 工作区」内显示，贴边时不被屏幕裁掉
      clamp: this.visibleClampRect(),
      onSent: () => {
        // 发送成功：回复已写进 S → 版本号变 → 挂着的长轮询立刻返回并弹气泡
        console.info('[dsh-pet] 对话已发送 pet=' + this.pet.id);
      },
      onClose: () => {
        this.chatClose = null;
        this.chatOpen = false;
        window.__dshPetDebug.chatOpen = false;
        this.syncInputBusy(); // 弹窗关：交还常规判定（菜单还开着的话仍保持忙）
        if (!this.menuOpen) this.setInteractive(false); // 无菜单时恢复命中区穿透
      },
    });
    this.chatClose = m.close;
    this.chatOpen = true; // 穿透守卫：弹窗期间整窗保持可交互
    window.__dshPetDebug.chatOpen = true;
    this.syncInputBusy();
    this.setInteractive(true);
  },

  // 「回到初始位置」菜单：停掉漫游/移动，清掉会话位置，回到配置角落
  goHome() {
    this.stopThrow();
    this.stopMove();
    this.customPos = null;
    this.position();
  },

  // 「重载配置」菜单：请宿主重启桌面 Helper，与设置页「保存」同一条重启路径（宿主 POST /reload →
  // syncDesktop）。不在渲染端就地重拉：窗口数量/display/size 由宿主按 DSH_PET_PETS 建，且全局轮询是
  // 一次性启动的（loopsStarted），就地重建会漏启新循环或留下旧定时器。
  // 本请求由即将被重启的进程发出，响应可能永远不回（宿主杀进程时回调地址已失效），故不 await、
  // 不重试，失败只记日志——重载本身就是把本进程换掉。
  reloadDesktop() {
    fetch(BASE + '/reload', { method: 'POST' }).catch((e) => {
      console.warn('[dsh-pet] 重载配置请求失败（宿主不可达？）', e);
    });
  },

  // 「显示位置」菜单：改这一只宠物的 display，写它自己的配置，再由宿主重载生效。取值直接来自菜单项，
  // 渲染端不做推导（当前状态以配置为准）。不就地开关窗：窗口是进程启动时按 DSH_PET_PETS 一次性建的。
  // 与 reloadDesktop 同一处境：选「仅网页/都不」时本进程会在重载中被换掉，故不 await、不重试。
  setPetDisplay(display) {
    if (!display) return;
    fetch(BASE + '/pet-display', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.pet.id, display }),
    }).catch((e) => {
      console.warn('[dsh-pet] 显示位置请求失败（宿主不可达？）', e);
    });
  },

  /**
   * 自定义节点树 → DOM（custom 形态的渲染器）。
   *
   * tag 与样式白名单在 shared 的解析层已裁过，这里只做映射：不用 innerHTML，文本走 createTextNode，
   * 第三方内容因而没有注入面。样式键是 camelCase，直接赋给 el.style 即可。
   */
  renderTree(node) {
    const el = document.createElement(node.tag);
    if (node.style) {
      for (const [key, value] of Object.entries(node.style)) el.style[key] = value;
    }
    if (node.tag === 'img') {
      el.src = node.src || '';
      el.alt = '';
      return el;
    }
    // 文本与子节点可同时存在：先文本、后子节点（与 textContent + appendChild 的顺序一致）
    if (node.text) el.appendChild(document.createTextNode(node.text));
    for (const child of node.children || []) el.appendChild(this.renderTree(child));
    return el;
  },
});
