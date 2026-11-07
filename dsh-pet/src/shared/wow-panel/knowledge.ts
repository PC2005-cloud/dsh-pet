/** 本地魔兽知识检索与旧版只读档案迁移入口。 */
import { data, list, object, text } from './api.ts';
import { action, card, checkbox, details, el, field, input, type PanelContext } from './dom.ts';

/** 搜索结果同时展示版本、语言社区、用法与来源。 */
export function knowledgeCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(
    t('魔兽知识与社区用语', 'Warcraft knowledge and community language'),
    t(
      '按当前游戏与语言环境检索通用知识、缩写和热梗，例如 DZ、部落都是废物、你们这是自寻死路。聊天时也会按上下文自动引用。',
      'Search general knowledge, abbreviations and memes for the selected game and language community. Chat also retrieves relevant references automatically.',
    ),
  );
  const query = input();
  query.maxLength = 16000;
  const output = el('div', '', 'dsh-wow-output');
  result.append(field(t('知识关键词或聊天片段', 'Knowledge keywords or chat text'), query));
  result.append(
    action(ctx, t('搜索知识库', 'Search knowledge'), async () => {
      if (!query.value.trim()) throw new Error(t('请输入检索内容。', 'Enter a search query.'));
      const response = object(
        data(
          await ctx.api.action('knowledge.search', ctx.game, {
            query: query.value.trim(),
            locale: ctx.locale,
            server: ctx.game,
          }),
        ),
      );
      const entries = list(response.entries);
      output.replaceChildren();
      for (const entry of entries) {
        const block = card(text(entry.title), `${text(entry.game)} · ${text(entry.locale)} · ${text(entry.kind)}`);
        block.append(el('p', text(entry.text)), el('p', text(entry.usage), 'dsh-wow-hint'));
        block.append(
          details(t('别名与来源', 'Aliases and provenance'), {
            aliases: entry.aliases,
            matchedAliases: entry.matchedAliases,
            provenance: entry.provenance,
          }),
        );
        output.append(block);
      }
      if (!entries.length)
        output.append(
          el(
            'p',
            t(
              '没有匹配记录。可以补充游戏版本、社区语言或具体缩写。',
              'No matching references. Include the game, community language or abbreviation.',
            ),
            'dsh-wow-hint',
          ),
        );
    }),
  );
  result.append(output);
  return result;
}

/** 显式迁移旧版 AIRI 档案；服务端只读取白名单 JSON 并先备份当前目标。 */
export function importCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(
    t('迁移原魔兽陪伴精灵档案', 'Import previous companion history'),
    t(
      '输入旧版 AIRI 的用户数据目录，导入金币、装备、升级和配装等档案。导入前会备份当前档案；旧目录只读。模型连接与 API 密钥不在迁移范围内。',
      'Enter the old AIRI user-data directory to import gold, equipment, levels and loadouts. Existing history is backed up first, and the source stays read-only. Model connections and API keys are excluded.',
    ),
  );
  const directory = input();
  directory.maxLength = 4096;
  const confirm = checkbox(
    t('我已核对旧版目录，并确认导入档案', 'I checked the source directory and want to import history'),
    false,
  );
  const output = el('div', '', 'dsh-wow-output');
  result.append(field(t('旧版用户数据目录', 'Previous user-data directory'), directory), confirm.node);
  result.append(
    action(
      ctx,
      t('备份并导入档案', 'Back up and import history'),
      async () => {
        if (!directory.value.trim() || !confirm.input.checked)
          throw new Error(t('请填写源目录并勾选导入确认。', 'Enter the source directory and confirm the import.'));
        const imported = await ctx.api.action('history.import', ctx.game, { sourceDirectory: directory.value.trim() });
        output.replaceChildren(details(t('导入结果与备份位置', 'Import result and backup location'), imported));
        confirm.input.checked = false;
        await ctx.refresh();
      },
      t('档案导入已完成', 'History import completed'),
    ),
  );
  result.append(output);
  return result;
}

/** 保存跨游戏的陪伴开关，保留当前模型绑定与语言选择。 */
export function preferencesCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(t('全局陪伴偏好', 'Global companion preferences'));
  const settings = object(ctx.state.settings);
  if (ctx.state.settingsError) result.append(el('p', text(ctx.state.settingsError), 'dsh-wow-hint'));
  const notify = checkbox(
    t('显示魔兽事件通知', 'Show Warcraft event notifications'),
    settings.eventNotifications !== false,
  );
  const mute = checkbox(t('全局静音', 'Mute all companion events'), settings.muted === true);
  result.append(notify.node, mute.node);
  result.append(
    action(
      ctx,
      t('保存陪伴偏好', 'Save companion preferences'),
      async () => {
        await ctx.api.action('preferences.save', ctx.game, {
          activeGame: ctx.game,
          locale: ctx.locale,
          petId: text(object(ctx.state.settings).petId, ''),
          eventNotifications: notify.input.checked,
          muted: mute.input.checked,
        });
        await ctx.refresh();
      },
      t('陪伴偏好已保存', 'Companion preferences saved'),
    ),
  );
  return result;
}
