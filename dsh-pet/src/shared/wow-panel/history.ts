/** 分版本展示本机持久化的金币、装备与升级档案。 */
import { list, object, text, type JsonObject } from './api.ts';
import { action, card, date, details, el, field, input, money, profile, table, type PanelContext } from './dom.ts';

/** 展示账户账本并允许修改本地账户名称。 */
export function goldCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const gold = object(profile(ctx).gold);
  const result = card(t('金币账本', 'Gold ledger'));
  if (gold.storageError) result.append(el('p', text(gold.storageError), 'dsh-wow-hint'));
  for (const account of list(gold.accounts)) {
    const block = el('div', '', 'dsh-wow-output');
    block.append(el('h4', text(account.name ?? account.account)));
    block.append(
      table(
        [account],
        [
          [t('余额', 'Balance'), (row) => money(row.balance, t)],
          [t('收入', 'Earned'), (row) => money(row.earned, t)],
          [t('支出', 'Spent'), (row) => money(row.spent, t)],
          [t('净收入', 'Net'), (row) => money(row.net, t)],
        ],
        '',
      ),
    );
    block.append(
      table(
        list(account.characters),
        [
          [t('角色', 'Character'), (row) => `${text(row.name)} · ${text(row.realm)}`],
          [t('携带金币', 'Carried money'), (row) => money(row.copper, t)],
          [t('收入', 'Earned'), (row) => money(row.earned, t)],
          [t('支出', 'Spent'), (row) => money(row.spent, t)],
        ],
        t('暂无角色', 'No characters'),
      ),
    );
    const name = input(account.name);
    name.maxLength = 64;
    block.append(field(t('本地账户名称', 'Local account name'), name));
    block.append(
      action(
        ctx,
        t('重命名账户', 'Rename account'),
        async () => {
          await ctx.api.action('account.rename', ctx.game, { account: account.account, name: name.value.trim() });
          await ctx.refresh();
        },
        t('账户名称已保存', 'Account name saved'),
      ),
    );
    result.append(block);
  }
  if (!list(gold.accounts).length)
    result.append(
      el(
        'p',
        t('尚无金币记录，等待真实游戏数据。', 'No gold records yet. Waiting for real game data.'),
        'dsh-wow-hint',
      ),
    );
  return result;
}

/** 最近获取装备的摘要与原始属性。 */
export function equipmentCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const history = object(profile(ctx).equipmentHistory);
  const entries = list(history.entries).reverse();
  const result = card(t('装备获取记录', 'Equipment acquisitions'));
  result.append(
    table(
      entries,
      [
        [t('时间', 'Time'), (row) => date(row.receivedAt, ctx.locale)],
        [t('角色', 'Character'), (row) => `${text(row.name)} · ${text(row.realm)}`],
        [t('装备', 'Item'), (row) => object(row.record).name ?? object(row.record).itemID],
        [t('装等', 'Item level'), (row) => object(row.record).itemLevel],
        [t('数量', 'Quantity'), (row) => object(row.record).quantity],
      ],
      t('尚无装备获取记录。', 'No equipment acquisitions yet.'),
    ),
  );
  appendArchive(result, ctx, history, entries);
  return result;
}

/** 升级记录明确展示基线、缺口与不完整时长。 */
export function levelCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const history = object(profile(ctx).levelHistory);
  const result = card(t('升级历程', 'Level history'));
  for (const character of list(history.characters)) {
    result.append(el('h4', `${text(character.name)} · ${text(character.realm)} · ${text(character.currentLevel)}`));
    result.append(
      table(
        list(character.records).reverse(),
        [
          [t('等级', 'Level'), (row) => `${text(row.fromLevel)} → ${text(row.level)}`],
          [t('时间', 'Time'), (row) => date(row.recordedAt, ctx.locale)],
          [
            t('升级耗时', 'Level duration'),
            (row) => (typeof row.durationMs === 'number' ? `${Math.round(row.durationMs / 60000)} min` : '—'),
          ],
          [t('记录依据', 'Record basis'), (row) => `${text(row.source)} / ${text(row.durationBasis)}`],
        ],
        t('尚无升级事件。', 'No level events yet.'),
      ),
    );
  }
  if (!list(history.characters).length)
    result.append(el('p', t('尚无升级记录。', 'No level history yet.'), 'dsh-wow-hint'));
  appendArchive(result, ctx, history, history.characters);
  return result;
}

/** 获取时的装备对比保留目标槽位与不完整数据，避免冒充配装建议。 */
export function comparisonCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const history = object(profile(ctx).equipmentComparisons);
  const entries = list(history.entries).reverse();
  const result = card(
    t('装备对比', 'Equipment comparisons'),
    t(
      '对比来自获取装备时的槽位快照。特殊效果、属性取舍和不完整观测需要进一步确认。',
      'Comparisons use the target slot when the item was acquired. Special effects, stat tradeoffs and incomplete observations require review.',
    ),
  );
  result.append(
    table(
      entries,
      [
        [t('角色 / 时间', 'Character / time'), (row) => `${text(row.name)}\n${date(row.receivedAt, ctx.locale)}`],
        [t('新装备', 'Candidate'), (row) => itemSummary(object(object(row.comparison).candidate))],
        [t('原装备', 'Equipped at acquisition'), (row) => itemSummary(object(object(row.comparison).current))],
        [t('槽位', 'Slot'), (row) => object(row.comparison).slot],
        [t('保守评估', 'Conservative assessment'), (row) => assessmentText(row.assessment, ctx)],
        [
          t('可用 / 专精匹配', 'Usable / spec match'),
          (row) =>
            `${textFlag(object(row.comparison).usable, ctx)} / ${textFlag(object(row.comparison).specMatch, ctx)}`,
        ],
      ],
      t('尚无装备对比记录。', 'No equipment comparisons yet.'),
    ),
  );
  appendArchive(result, ctx, history, entries);
  return result;
}

/** 只读展示每个角色最近保存的十九槽配装。 */
export function loadoutCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const archive = object(profile(ctx).equipmentLoadouts);
  const result = card(
    t('配装档案', 'Equipment loadouts'),
    t(
      '展示已保存的完整槽位快照；未知槽位不代表空槽，旧档案不代表当前在线装备。',
      'Saved full-slot snapshots. Unknown slots are not empty slots, and saved loadouts may differ from current equipment.',
    ),
  );
  const entries = list(archive.entries);
  for (const entry of entries) {
    const loadout = object(entry.loadout);
    const block = el('details');
    block.append(el('summary', `${text(entry.name)} · ${text(entry.realm)} · ${date(entry.receivedAt, ctx.locale)}`));
    block.append(
      table(
        list(loadout.slots),
        [
          [t('槽位', 'Slot'), (row) => row.slot],
          [t('状态', 'State'), (row) => row.state],
          [t('装备', 'Item'), (row) => object(row.item).name ?? object(row.item).itemID],
          [t('装等', 'Item level'), (row) => object(row.item).itemLevel],
          [
            t('属性', 'Stats'),
            (row) =>
              list(object(row.item).stats)
                .map((stat) => `${text(stat.key)}: ${text(stat.value)}`)
                .join('\n'),
          ],
        ],
        '',
      ),
    );
    block.append(details(t('配装完整记录', 'Full loadout record'), entry));
    result.append(block);
  }
  if (!entries.length) result.append(el('p', t('尚无配装档案。', 'No saved loadouts yet.'), 'dsh-wow-hint'));
  if (archive.storageError) result.append(el('p', text(archive.storageError), 'dsh-wow-hint'));
  return result;
}

function appendArchive(result: HTMLElement, ctx: PanelContext, history: JsonObject, value: unknown): void {
  if (history.storageError) result.append(el('p', text(history.storageError), 'dsh-wow-hint'));
  result.append(details(ctx.t('完整记录', 'Full records'), value));
}

function itemSummary(item: JsonObject): string {
  return `${text(item.name ?? item.itemID)} · ${text(item.itemLevel)}`;
}

function textFlag(value: unknown, ctx: PanelContext): string {
  return value === true ? ctx.t('是', 'Yes') : value === false ? ctx.t('否', 'No') : ctx.t('未知', 'Unknown');
}

/** 评估结论只读宿主统一算法输出，不在界面按装等推断收益。 */
function assessmentText(value: unknown, ctx: PanelContext): string {
  const assessment = object(value);
  const verdicts: Record<string, readonly [string, string]> = {
    upgrade: ['属性提升', 'Upgrade'],
    not_upgrade: ['未证明提升', 'Not an upgrade'],
    review: ['需要复核', 'Review required'],
  };
  const reasons: Record<string, readonly [string, string]> = {
    empty_slot: ['原槽位为空', 'Empty slot'],
    stats_upgrade: ['属性提升且装等不降低', 'Improved stats without losing item level'],
    unusable: ['当前角色不可用', 'Unusable'],
    wrong_spec: ['专精不匹配', 'Wrong specialization'],
    weaker_stats: ['属性下降', 'Weaker stats'],
    equivalent: ['已支持属性相同', 'Equivalent supported stats'],
    incomplete: ['数据不完整', 'Incomplete data'],
    unknown_spec: ['专精信息不明', 'Unknown specialization'],
    weapon_change: ['武器或装备类型变化', 'Weapon or item type change'],
    complex_item: ['特殊效果需复核', 'Complex effects need review'],
    stat_tradeoff: ['属性存在取舍', 'Stat tradeoff'],
    primary_upgrade_tradeoff: ['主属性提升但损失其他属性', 'Primary gain with stat tradeoffs'],
    no_target: ['没有明确目标槽位', 'No target slot'],
  };
  const verdict = verdicts[text(assessment.verdict)] ?? verdicts.review;
  const reason = reasons[text(assessment.reason)];
  return `${ctx.t(...verdict)}${reason ? ` · ${ctx.t(...reason)}` : ''}`;
}
