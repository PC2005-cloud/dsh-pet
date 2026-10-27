/**
 * 气泡与悬浮提示的渲染：工作状态 / 碎碎念 / 余额三段内容共用一个气泡槽，按优先级择一显示。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 只读实例状态，除 DOM 与 syncInputBusy() 之外不写任何字段。
 * @module dsh-pet/runtime/electron-helper/sprite-bubble
 */
'use strict';

Object.assign(PetSprite.prototype, {
  setTip(on) {
    const next = !!on;
    if (next === this.tipOn) return;
    this.tipOn = next;
    this.renderTip();
    this.syncShape(); // 提示在窗口形状之外就看不见：显示/收起都要同步形状
  },

  /**
   * 悬浮提示渲染：文本 = 宠物显示名（宿主已保证非空）；位置 = 光标右下（装不下自动翻边），
   * 摆位判据与浏览器端共用 shared 的 tooltipPlacement。
   *
   * 光标存的是视口坐标，而提示是 position:fixed、DOM 坐标相对窗口，所以这里减掉窗口原点。
   * 存视口坐标而非窗口坐标，是因为窗口会随宠物移动：只在这里按当前原点重算一次，贴光标不会漂。
   */
  renderTip() {
    if (this.tip.textContent !== this.pet.name) this.tip.textContent = this.pet.name;
    const cursor = this.tipCursor;
    if (cursor) {
      const wr = this.winRect();
      const winX = wr.x;
      const winY = wr.y;
      const winW = wr.w;
      const winH = wr.h;
      // 允许显示范围 = 窗口 ∩ 光标所在屏的工作区：只按窗口夹会画到屏幕外，只按工作区夹会落到
      // 窗口外（html/body 是 overflow:hidden，一样看不见）。
      const area = S.resolveRect(WORK_AREAS, cursor.x, cursor.y) ?? { x: winX, y: winY, width: winW, height: winH };
      const x0 = Math.max(winX, area.x);
      const y0 = Math.max(winY, area.y);
      const x1 = Math.min(winX + winW, area.x + area.width);
      const y1 = Math.min(winY + winH, area.y + area.height);
      const p = S.tooltipPlacement(
        { x: cursor.x - winX, y: cursor.y - winY },
        { w: this.tip.offsetWidth, h: this.tip.offsetHeight },
        { x: x0 - winX, y: y0 - winY, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
        this.size * S.TOOLTIP_GAP_RATIO,
      );
      this.tip.style.left = p.x + 'px';
      this.tip.style.top = p.y + 'px';
    }
    this.tip.classList.toggle('is-on', this.tipOn);
    window.__dshPetDebug.tooltipOn = this.tipOn;
  },
  renderBubble() {
    // 气泡单槽：同一时刻只显示一个（优先级：终态任务 > 碎碎念/对话 > 余额 > 非终态任务）。
    // 终态任务不让位：完成/失败气泡只活 10s，被顶掉就彻底看不到；非终态气泡常驻，让位零损失。
    // 工作气泡与碎碎念同款样式（宽度自适应 + 自动换行）；配图标记交给 CSS（带图时取消 min-width）。
    // 图片 URL 与视频同规则：传 BASE 前缀（桌面是 file:// 页面，必须绝对地址），素材根同理。
    const workOn = !!(this.workOn && this.workText);
    const whisperOn = !!(this.whisperOn && this.whisperView);
    const balanceOn = !!(this.bubbleOn && this.balanceView);
    const workTerminal = this.workState === 'success' || this.workState === 'error';
    const slot =
      workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : balanceOn ? 'balance' : workOn ? 'work' : 'none';
    // 配图两种形态二选一：url 用完整地址，image 按素材根拼表情包路径；样式/class 共用。
    const whisperImg =
      slot === 'whisper'
        ? this.whisperUrl
          ? S.createMemeImageFromUrl(this.whisperUrl)
          : S.createMemeImage(this.whisperImage, BASE, this.assetRoot)
        : null;
    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」也套紧凑变体：字号更小、宽度下限更窄，多行说明更紧凑
      slot === 'whisper' || slot === 'work' || (slot === 'balance' && this.balanceWrap),
    );
    this.bubble.classList.toggle(S.MEME_BUBBLE_CLASS, !!whisperImg);
    // 可点/展开两个状态类：可点 → 气泡参与命中区（见 syncInputRegions）；index>0 → 更宽的盒与紧凑字号。
    // 展开态仅内置 windows 的收起/展开两页使用；custom 各页是对等页面，翻页不切紧凑字号。
    const isCustom = !!(this.balanceState && S.customViews(this.balanceState));
    const clickable = slot === 'balance' && this.balanceClickable();
    const expanded = clickable && !isCustom && this.balanceViewIndex > 0;
    this.bubble.classList.toggle('is-clickable', clickable);
    this.bubble.classList.toggle('is-expanded', expanded);
    if (slot === 'none') {
      // 三者都没有可显示的内容：隐藏（不占位，也就不会挡住任何一层）
      this.bubble.classList.remove('is-on');
      window.__dshPetDebug.lastBubbleTitle = '';
      this.syncInputBusy(); // 气泡没了 → 撤销它的控件矩形与 busy 标记（否则整窗还留着可点区域）
      return;
    }
    this.bubble.innerHTML = '';
    if (slot === 'work') {
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.workText;
      this.bubble.appendChild(line);
    } else if (slot === 'whisper') {
      // 配图（shared 生成的 <img> + 共用样式）：先看图再读话
      if (whisperImg) this.bubble.appendChild(whisperImg);
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.whisperView[0]?.text ?? '';
      this.bubble.appendChild(line);
    } else if (this.balanceState && S.customViews(this.balanceState)) {
      // custom 形态：第三方自己的节点树。页索引取当前页；页数变少时夹到最后一页，不显示残页。
      const views = S.customViews(this.balanceState);
      const page = views[Math.min(this.balanceViewIndex, views.length - 1)];
      if (page) this.bubble.appendChild(this.renderTree(page));
    } else {
      // 展开态的行在这里现算：renderBubble 是只读渲染路径，不缓存（余额每轮都在变，缓存反而要同步失效）
      const rows =
        clickable && this.balanceViewIndex > 0 && this.balanceState
          ? S.balanceDetailView(this.balanceState)
          : this.balanceView;
      const hasTier = rows.some((r) => r.role === 'tier');
      if (hasTier) {
        // deepseek 余额单行：余额（峰/谷）¥x — 档位字着色
        const line = document.createElement('div');
        line.className = 'pet-bub-row';
        for (const r of rows) {
          const span = document.createElement('span');
          if (r.role === 'tier') span.className = 'pet-bub-tier pet-bub-tier-' + r.tier;
          span.textContent = r.text;
          line.appendChild(span);
        }
        this.bubble.appendChild(line);
      } else {
        for (const r of rows) {
          // 展开态一行 = 一个窗口：窗口名 + 进度条 + 已用百分比 + 重置倒计时，四段 flex 同行，条吃剩余宽度。
          if (r.role === 'quota') {
            const row = document.createElement('div');
            row.className = 'pet-bub-quota';
            const label = document.createElement('span');
            label.className = 'pet-bub-quota-label';
            label.textContent = r.label;
            const bar = document.createElement('span');
            bar.className = 'pet-bub-quota-bar';
            const fill = document.createElement('i');
            fill.className = 'pet-bub-quota-fill pet-bub-quota-' + r.tone;
            fill.style.width = Math.max(0, Math.min(100, r.percent)) + '%';
            bar.appendChild(fill);
            const used = document.createElement('span');
            used.className = 'pet-bub-quota-used';
            used.textContent = r.usedText;
            const reset = document.createElement('span');
            reset.className = 'pet-bub-quota-reset';
            reset.textContent = r.resetText;
            row.append(label, bar, used, reset);
            this.bubble.appendChild(row);
            continue;
          }
          const div = document.createElement('div');
          if (r.role === 'error') div.className = 'pet-bub-err';
          else if (r.role === 'sub') div.className = 'pet-bub-row pet-bub-sub';
          else div.className = 'pet-bub-row';
          div.textContent = r.text;
          this.bubble.appendChild(div);
        }
      }
    }
    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
    // 气泡内容/尺寸变了 → 重报控件矩形并同步 busy 标记。这里是所有显隐与换内容的汇聚点。
    this.syncInputBusy();
  },
});
