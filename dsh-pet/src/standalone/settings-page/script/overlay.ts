/**
 * 自绘的弹窗与下拉选择器：替代 window.confirm 与原生 select。
 *
 * 两者都挂在 body 上并用 fixed 定位，避免被面板的滚动容器裁掉；关闭路径统一走 capture 监听，
 * 打开新菜单前一定先关掉旧的。选择器不持有业务状态，值由调用方的 onChange 收走。
 * 需要搜索的菜单（上百个模型）在顶部固定一个输入框，过滤只影响可见项，不改变候选顺序。
 * @module dsh-pet/src/standalone/settings-page/script/overlay
 */

/** 生成覆盖层片段。 */
export function overlayScript(): string {
  return `
let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  const dispose = openMenu;
  openMenu = null;
  dispose();
}

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'selectChevron');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 6.5 8 10.5 12 6.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function placeMenu(menu, trigger, widthOf) {
  const rect = trigger.getBoundingClientRect();
  const span = widthOf ? widthOf.getBoundingClientRect() : rect;
  const below = window.innerHeight - rect.bottom;
  const height = Math.min(260, Math.max(120, below > 200 ? below - 16 : rect.top - 16));
  menu.style.left = Math.round(span.left) + 'px';
  menu.style.width = Math.round(span.width) + 'px';
  menu.style.maxHeight = Math.round(height) + 'px';
  if (below > 200 || rect.top < 220) menu.style.top = Math.round(rect.bottom + 4) + 'px';
  else menu.style.top = Math.round(rect.top - height - 4) + 'px';
}

/**
 * 打开一个下拉菜单。
 * @param trigger - 触发按钮，用来定位、判断「点外面」与标记展开状态。
 * @param options - 候选项，每项 { value, label }。
 * @param current - 当前值。
 * @param onPick - 选中回调。
 * @param widthOf - 菜单对齐宽度的参照元素；缺省与 trigger 同宽，用于触发按钮比菜单窄的组合框。
 * @param search - 搜索框占位文案；给出时菜单顶部固定一个过滤输入框。
 */
function openSelectMenu(trigger, options, current, onPick, widthOf, search) {
  closeMenu();
  const menu = make('ul', { class: 'selectMenu' });
  menu.setAttribute('role', 'listbox');
  const items = [];
  // 分组标题只是分隔行：不进 items，键盘索引与高亮完全不受影响
  let prevGroup = null;
  // 搜索框必须先插进菜单，再插候选项，保证它固定在最上面
  let searchInput = null;
  if (search) {
    const row = make('li', { class: 'selectSearchRow' });
    row.setAttribute('role', 'presentation');
    searchInput = make('input', { type: 'search', class: 'selectSearch', placeholder: search });
    searchInput.setAttribute('aria-label', search);
    row.append(searchInput);
    menu.append(row);
  }
  for (const option of options) {
    if (option.group && option.group !== prevGroup) {
      const title = make('li', { class: 'selectGroup', text: option.group });
      title.setAttribute('role', 'presentation');
      menu.append(title);
      prevGroup = option.group;
    }
    const item = make('li', { class: 'selectItem', text: option.label });
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option.value === current ? 'true' : 'false');
    item.addEventListener('click', () => pick(option.value));
    menu.append(item);
    items.push({ node: item, value: option.value });
  }
  // 过滤后一个都不剩时的说明行；没有搜索框时永远隐藏
  const emptyRow = make('li', { class: 'selectEmpty', text: '没有匹配的模型' });
  emptyRow.setAttribute('role', 'presentation');
  emptyRow.hidden = true;
  menu.append(emptyRow);
  document.body.append(menu);
  placeMenu(menu, trigger, widthOf);
  trigger.setAttribute('aria-expanded', 'true');
  // 可见项：没有搜索框时就是全部；过滤后只留命中的那些
  let visible = items.slice();
  let active = 0;
  const start = visible.findIndex((entry) => entry.value === current);
  highlight(start < 0 ? 0 : start);

  function highlight(index) {
    if (visible.length === 0) {
      active = 0;
      return;
    }
    active = (index + visible.length) % visible.length;
    visible.forEach((entry, position) => {
      const on = position === active;
      entry.node.classList.toggle('active', on);
      if (on) entry.node.scrollIntoView({ block: 'nearest' });
    });
  }

  function applyFilter() {
    const query = searchInput.value.trim().toLowerCase();
    visible = [];
    for (const entry of items) {
      // 命中判定用渲染出来的文字：id 与显示名都在里面，搜哪个都行
      const hit = query === '' || entry.node.textContent.toLowerCase().indexOf(query) >= 0;
      entry.node.hidden = !hit;
      if (hit) visible.push(entry);
    }
    // 搜索期间分组标题只会挡路，有查询词时一并藏起来
    for (const title of menu.querySelectorAll('.selectGroup')) title.hidden = query !== '';
    emptyRow.hidden = visible.length > 0;
    highlight(0);
  }

  function pick(value) {
    dispose();
    onPick(value);
  }

  function onKey(event) {
    // 搜索框里的空格是输入，不能被当成「选中当前项」
    const inSearch = searchInput !== null && event.target === searchInput;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dispose();
      trigger.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === ' ' && inSearch) {
      // 交给输入框
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (visible.length === 0) return;
      event.preventDefault();
      pick(visible[active].value);
      trigger.focus();
    } else if (event.key === 'Tab') {
      dispose();
    }
  }

  function onPointer(event) {
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    dispose();
  }

  function onReflow() {
    placeMenu(menu, trigger, widthOf);
  }

  function dispose() {
    if (!menu.isConnected) return;
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('scroll', onReflow, true);
    window.removeEventListener('resize', onReflow);
    if (openMenu === dispose) openMenu = null;
  }

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('scroll', onReflow, true);
  window.addEventListener('resize', onReflow);
  openMenu = dispose;
  if (searchInput) {
    searchInput.addEventListener('input', applyFilter);
    searchInput.focus();
  }
}

/**
 * 造一个下拉选择器。
 * @param options - 候选项，每项 { value, label }。
 * @param value - 初始值。
 * @param onChange - 用户选择后回调。
 * @returns 根节点与读写当前值、替换选项的方法。
 */
function createSelect(options, value, onChange) {
  const root = make('div', { class: 'select' });
  const trigger = make('button', { type: 'button', class: 'selectTrigger' });
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = make('span', { class: 'selectValue' });
  trigger.append(label, chevron());
  root.append(trigger);
  let current = value;

  function paint() {
    const hit = options.find((option) => option.value === current);
    label.textContent = hit ? hit.label : current;
    trigger.disabled = options.length <= 1;
  }

  trigger.addEventListener('click', () => {
    if (openMenu) {
      closeMenu();
      return;
    }
    openSelectMenu(trigger, options, current, (picked) => {
      current = picked;
      paint();
      onChange(picked);
    });
  });

  paint();
  return {
    root: root,
    getValue: () => current,
    setValue: (next) => {
      current = next;
      paint();
    },
    setOptions: (next) => {
      options = next;
      paint();
    },
    redraw: paint,
  };
}

/**
 * 弹出确认框。
 * @param options - 标题、正文、按钮文案与是否危险操作。
 * @returns 用户确认时为 true。
 */
function confirmDialog(options) {
  const config = options || {};
  return new Promise((resolve) => {
    const mask = make('div', { class: 'dialogMask' });
    const panel = make('div', { class: 'dialog' });
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', config.title || '确认');
    const text = make('p', { class: 'dialogText', text: config.text || '' });
    // cancelLabel 传 null 表示只提示、不给取消：用于「不能删除最后一只」这类纯说明。
    const cancel =
      config.cancelLabel === null
        ? null
        : make('button', { type: 'button', class: 'btn', text: config.cancelLabel || '取消' });
    const confirm = make('button', {
      type: 'button',
      class: 'btn ' + (config.danger ? 'danger' : 'primary'),
      text: config.confirmLabel || '确定',
    });
    const actions = make('div', { class: 'dialogActions' }, cancel ? [cancel, confirm] : [confirm]);
    panel.append(make('h2', { class: 'dialogTitle', text: config.title || '确认' }), text, actions);
    mask.append(panel);
    document.body.append(mask);

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      resolve(result);
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      if (event.key !== 'Tab' || !cancel) return;
      event.preventDefault();
      (document.activeElement === confirm ? cancel : confirm).focus();
    }

    if (cancel) cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    mask.addEventListener('pointerdown', (event) => {
      if (event.target === mask) close(false);
    });
    document.addEventListener('keydown', onKey, true);
    confirm.focus();
  });
}
`;
}
