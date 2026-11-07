/** 插件搜索、下载文件确认、推荐安装与已安装记录。 */
import { data, list, object, text, type JsonObject } from './api.ts';
import { addonSettings, type AddonControls } from './addon-settings.ts';
import { action, card, date, details, el, field, input, select, table, type PanelContext } from './dom.ts';

/** 创建插件工具区；任何安装均需用户显式点击对应文件或推荐。 */
export function addonCards(ctx: PanelContext): HTMLElement[] {
  const controls = addonSettings(ctx);
  const cards = [controls.node, searchCard(ctx, controls), recommendationCard(ctx), installedCard(ctx)];
  if (!ctx.state.addonsError) return cards;
  const error = card(ctx.t('插件管理暂不可用', 'Addon management unavailable'), text(ctx.state.addonsError));
  for (const card of cards) {
    card.querySelectorAll('button,input,select,textarea').forEach((control) => {
      (control as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true;
    });
  }
  return [error, ...cards];
}

/** 用户选择分支后才允许搜索，避免跨版本误装。 */
function searchCard(ctx: PanelContext, controls: AddonControls): HTMLElement {
  const { t } = ctx;
  const result = card(t('搜索与安装插件', 'Search and install addons'));
  const query = input();
  query.maxLength = 128;
  const sort = select(
    [
      ['popular', t('热门', 'Popular')],
      ['updated', t('最近更新', 'Recently updated')],
      ['downloads', t('下载量', 'Downloads')],
    ],
    'popular',
  );
  const index = input(0, 'number');
  index.min = '0';
  index.step = '20';
  const output = el('div', '', 'dsh-wow-output');
  result.append(
    field(t('插件名称或关键词', 'Addon name or keywords'), query),
    field(t('分类', 'Category'), controls.category),
  );
  const row = el('div', '', 'dsh-wow-row');
  row.append(field(t('排序', 'Sort'), sort), field(t('结果起始位置', 'Result offset'), index));
  row.append(
    action(ctx, t('搜索插件', 'Search addons'), async () => {
      const gameVersionTypeId = Number(controls.version.value);
      if (!gameVersionTypeId) throw new Error(t('请先选择并保存版本分支。', 'Select and save a version branch first.'));
      const response = object(
        data(
          await ctx.api.action('addons.search', ctx.game, {
            game: ctx.game,
            gameVersionTypeId,
            search: query.value.trim(),
            index: index.valueAsNumber || 0,
            sort: sort.value,
            ...(controls.category.value ? { categoryId: Number(controls.category.value) } : {}),
          }),
        ),
      );
      output.replaceChildren(
        el('p', `${t('匹配结果', 'Matching results')}: ${text(response.totalCount)}`, 'dsh-wow-hint'),
      );
      for (const addon of list(response.addons)) output.append(addonResult(ctx, addon, gameVersionTypeId));
      if (!list(response.addons).length) output.append(el('p', t('没有匹配插件。', 'No matching addons.')));
    }),
  );
  result.append(row, output);
  return result;
}

/** 下载前展示目标文件版本，安装结果保留备份位置。 */
function addonResult(ctx: PanelContext, addon: JsonObject, gameVersionTypeId: number): HTMLElement {
  const { t } = ctx;
  const result = card(text(addon.name), text(addon.summary, ''));
  appendWebsite(result, addon.websiteUrl, t('查看项目', 'View project'));
  const files = el('div', '', 'dsh-wow-output');
  result.append(
    action(ctx, t('查看兼容文件', 'View compatible files'), async () => {
      const response = data(
        await ctx.api.action('addons.files', ctx.game, { game: ctx.game, modId: addon.id, gameVersionTypeId }),
      );
      const rows = Array.isArray(response) ? list(response) : list(object(response).files);
      files.replaceChildren();
      for (const file of rows) {
        const row = el('div', '', 'dsh-wow-output');
        row.append(
          el(
            'p',
            `${text(file.displayName)} · ${Array.isArray(file.gameVersions) ? file.gameVersions.join(', ') : '—'}`,
          ),
        );
        row.append(
          action(
            ctx,
            t('安装此文件', 'Install this file'),
            async () => {
              const installed = await ctx.api.action('addons.install', ctx.game, {
                game: ctx.game,
                modId: addon.id,
                fileId: file.id,
              });
              row.append(details(t('安装结果与备份', 'Install result and backup'), data(installed)));
            },
            t('插件已安装', 'Addon installed'),
          ),
        );
        files.append(row);
      }
      if (!rows.length) files.append(el('p', t('没有兼容的可安装文件。', 'No compatible installable files.')));
    }),
  );
  result.append(files);
  return result;
}

/** 推荐报告携带一次性推荐标识，由宿主再次检查版本与有效期。 */
function recommendationCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(t('按需求推荐插件', 'Find addons for a need'));
  const query = input();
  query.maxLength = 128;
  const output = el('div', '', 'dsh-wow-output');
  result.append(field(t('插件需求', 'What should the addon do?'), query));
  result.append(
    action(ctx, t('查找推荐', 'Find recommendations'), async () => {
      if (!query.value.trim()) throw new Error(t('请输入插件需求。', 'Enter what you need.'));
      const report = object(
        data(await ctx.api.action('addons.recommend', ctx.game, { game: ctx.game, query: query.value.trim() })),
      );
      output.replaceChildren(
        el(
          'p',
          `${text(report.versionName)} · ${t('有效至', 'Valid until')} ${date(report.expiresAt, ctx.locale)}`,
          'dsh-wow-hint',
        ),
      );
      for (const addon of list(report.addons)) output.append(recommendation(ctx, report, addon));
      if (!list(report.addons).length)
        output.append(el('p', t('没有符合需求的推荐。', 'No matching recommendations.')));
    }),
  );
  result.append(output);
  return result;
}

function recommendation(ctx: PanelContext, report: JsonObject, addon: JsonObject): HTMLElement {
  const { t } = ctx;
  const result = card(text(addon.name), text(addon.summary, ''));
  result.append(el('p', text(addon.fileVersion), 'dsh-wow-hint'));
  appendWebsite(result, addon.websiteUrl, t('查看项目', 'View project'));
  if (addon.installable === true) {
    result.append(
      action(
        ctx,
        t('安装此推荐', 'Install recommendation'),
        async () => {
          const installed = await ctx.api.action('addons.installRecommendation', ctx.game, {
            recommendationId: report.id,
            modId: addon.id,
          });
          result.append(details(t('安装结果与备份', 'Install result and backup'), data(installed)));
        },
        t('推荐插件已安装', 'Recommended addon installed'),
      ),
    );
  } else
    result.append(
      el('p', text(addon.unavailableReason, t('暂不可安装', 'Unavailable for installation')), 'dsh-wow-hint'),
    );
  return result;
}

/** 已安装记录保留游戏目录和备份信息供用户复核。 */
function installedCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(t('已安装插件', 'Installed addons'));
  const output = el('div', '', 'dsh-wow-output');
  result.append(
    action(ctx, t('读取已安装记录', 'Load installed addons'), async () => {
      const response = data(await ctx.api.action('addons.installed', ctx.game, { game: ctx.game }));
      const entries = Array.isArray(response) ? list(response) : list(object(response).addons);
      output.replaceChildren(
        table(
          entries,
          [
            [t('名称', 'Name'), (row) => row.name],
            [t('版本', 'Version'), (row) => row.version],
            [t('目录', 'Directory'), (row) => row.clientDirectory],
            [t('安装时间', 'Installed at'), (row) => date(row.installedAt, ctx.locale)],
          ],
          t('当前版本尚无安装记录。', 'No installation records for this game.'),
        ),
        details(t('完整安装与备份记录', 'Full installation and backup records'), entries),
      );
    }),
  );
  result.append(output);
  return result;
}

/** 远端链接仅允许 HTTPS，禁用 opener 访问。 */
function appendWebsite(parent: HTMLElement, value: unknown, label: string): void {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return;
    const link = el('a', label);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
  } catch {
    /* 非法项目链接仅影响展示。 */
  }
}
