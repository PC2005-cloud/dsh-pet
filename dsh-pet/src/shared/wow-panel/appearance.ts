/** 已安装宠物的陪伴形象选择；草稿仅预览，用户应用后才改变实际显示。 */
import { list, object, text, type JsonObject } from './api.ts';
import { action, card, el, field, select, type PanelContext } from './dom.ts';

/** 将服务端已安装形象投影为本地选项，不接受任意图片地址或文件路径。 */
function installedOptions(appearance: JsonObject): JsonObject[] {
  const seen = new Set<string>();
  return list(appearance.options).filter((option) => {
    const id = text(option.id, '');
    if (option.builtin === true || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 默认使用 dsh-pet 原有形象；其它选项只来自当前宿主已安装的宠物实例。 */
export function appearanceCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const initial = object(ctx.state.appearance);
  const options = installedOptions(initial);
  const original = list(initial.options).find((option) => option.builtin === true);
  const defaultLabel = t('dsh-pet 原有形象（默认）', 'Original dsh-pet appearance (default)');
  const result = card(
    t('陪伴形象', 'Companion appearance'),
    t(
      '默认使用 dsh-pet 原有形象。也可选择已安装的宠物作为陪伴精灵，应用后切换显示，保留各自已有的动画与聊天记录。',
      'Use the original dsh-pet appearance by default, or choose an installed pet. Applying switches the companion while keeping each pet’s animations and chat history.',
    ),
  );
  if (initial.error) result.append(el('p', text(initial.error), 'dsh-wow-hint'));
  const choices: [string, string][] = [
    ['', defaultLabel],
    ...options.map((option): [string, string] => [text(option.id), text(option.name, text(option.id))]),
  ];
  const savedId = text(initial.selectedPetId, '');
  const selected = select(choices, choices.some(([id]) => id === savedId) ? savedId : '');
  const preview = el('img');
  preview.width = 96;
  preview.height = 96;
  preview.alt = t('陪伴形象预览', 'Companion appearance preview');
  preview.decoding = 'async';
  const draft = el('p', '', 'dsh-wow-hint');
  const current = el('p', '', 'dsh-wow-hint');
  const label = (id: string): string => choices.find(([value]) => value === id)?.[1] ?? defaultLabel;
  const showCurrent = (): void => {
    const appearance = object(ctx.state.appearance);
    current.textContent = `${t('当前陪伴形象', 'Current companion appearance')}：${label(text(appearance.selectedPetId, ''))}`;
  };
  const showPreview = (): void => {
    const option = selected.value === '' ? original : options.find((entry) => entry.id === selected.value);
    const root = text(option?.avatarRoot, text(option?.entry, 'main'));
    preview.src = `/dsh-pet-7340/logo?root=${encodeURIComponent(root)}&v=${Date.now()}`;
    const committed = text(object(ctx.state.appearance).selectedPetId, '');
    draft.textContent =
      selected.value === committed
        ? t('已应用此形象。', 'This appearance is applied.')
        : t('仅预览；点击“应用陪伴形象”后生效。', 'Preview only. Choose Apply companion appearance to use it.');
  };
  selected.addEventListener('change', showPreview);
  showCurrent();
  showPreview();
  result.append(field(t('选择陪伴形象', 'Choose companion appearance'), selected), preview, current, draft);
  if (!options.length) {
    result.append(
      el(
        'p',
        t(
          '尚未安装其它宠物形象。安装兼容的 dsh-pet 宠物包后，刷新本页即可选择。',
          'No other appearances are installed. Install a compatible dsh-pet pet pack and refresh this page to select it.',
        ),
        'dsh-wow-hint',
      ),
    );
  }
  result.append(
    action(
      ctx,
      t('应用陪伴形象', 'Apply companion appearance'),
      async () => {
        const requested = selected.value;
        const saved = object(await ctx.api.action('appearance.select', ctx.game, { petId: requested }));
        ctx.state = { ...ctx.state, appearance: saved };
        await ctx.refresh();
        window.dispatchEvent(new Event('dsh-pet-appearance-changed'));
        // A later draft chosen while saving must remain a draft, rather than silently becoming the applied value.
        showCurrent();
        showPreview();
      },
      t('陪伴形象已应用', 'Companion appearance applied'),
    ),
  );
  return result;
}
