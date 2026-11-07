/** CurseForge 的本地目录、版本分支与凭据配置。 */
import { data, list, object, text, type JsonObject } from './api.ts';
import { action, card, checkbox, field, input, select, type PanelContext } from './dom.ts';

/** 插件搜索使用用户确认过的分支与分类。 */
export interface AddonControls {
  node: HTMLElement;
  version: HTMLSelectElement;
  category: HTMLSelectElement;
}

/** 创建按游戏分区的目录设置；密钥留空保留旧值，成功后清空输入。 */
export function addonSettings(ctx: PanelContext): AddonControls {
  const { t } = ctx;
  const settings = object(ctx.state.addons);
  const clients = object(settings.clients);
  const selected = object(clients[ctx.game]);
  const result = card(
    t('插件目录与 CurseForge', 'Addon directory and CurseForge'),
    t(
      '填写对应游戏客户端目录；版本分支必须与客户端一致。API 密钥仅保存到本机，不会回显。',
      'Set this game client directory and its matching version branch. API keys stay on this machine and are never displayed.',
    ),
  );
  const directory = input(selected.directory);
  directory.maxLength = 4096;
  const initialId = selected.gameVersionTypeId;
  const version = select(
    [
      ['', t('先加载并选择版本分支', 'Load and select a version branch')],
      ...(typeof initialId === 'number'
        ? [[String(initialId), `${t('已保存分支', 'Saved branch')} #${initialId}`] as const]
        : []),
    ],
    initialId ?? '',
  );
  const category = select([['', t('全部分类', 'All categories')]], '');
  const key = input('', 'password');
  key.maxLength = 8192;
  key.placeholder = settings.hasApiKey
    ? t('已配置，留空保留', 'Configured; leave empty to keep')
    : t('尚未配置', 'Not configured');
  const clear = checkbox(t('删除已保存的 CurseForge 密钥', 'Delete saved CurseForge key'), false);
  result.append(field(t('游戏客户端目录', 'Game client directory'), directory));
  result.append(field(t('CurseForge API 密钥', 'CurseForge API key'), key), clear.node);
  result.append(
    action(ctx, t('加载版本分支与分类', 'Load version branches and categories'), async () => {
      const metadata = object(data(await ctx.api.action('addons.metadata', ctx.game)));
      populateVersions(version, list(metadata.versionTypes), ctx, version.value);
      category.replaceChildren(
        ...select(
          [
            ['', t('全部分类', 'All categories')],
            ...list(metadata.categories).map((row) => [text(row.id), text(row.name)] as const),
          ],
          '',
        ).options,
      );
    }),
  );
  result.append(field(t('游戏版本分支', 'Game version branch'), version));
  result.append(
    action(
      ctx,
      t('保存插件配置', 'Save addon configuration'),
      async () => {
        const gameVersionTypeId = Number(version.value);
        if (!Number.isInteger(gameVersionTypeId) || gameVersionTypeId <= 0)
          throw new Error(t('请先加载并选择正确的版本分支。', 'Load and select the correct version branch first.'));
        const nextClients = Object.fromEntries(
          ['retail', 'forever', 'classic'].map((game) => [
            game,
            {
              directory: text(object(clients[game]).directory, ''),
              gameVersionTypeId: object(clients[game]).gameVersionTypeId ?? null,
            },
          ]),
        );
        nextClients[ctx.game] = { directory: directory.value.trim(), gameVersionTypeId };
        await ctx.api.action('addons.settings.save', ctx.game, {
          clients: nextClients,
          ...(key.value.trim() ? { apiKey: key.value.trim() } : {}),
          ...(clear.input.checked ? { clearApiKey: true } : {}),
        });
        key.value = '';
        clear.input.checked = false;
        await ctx.refresh();
      },
      t('插件配置已保存', 'Addon configuration saved'),
    ),
  );
  return { node: result, version, category };
}

/** 版本选择只展示当前游戏的有效分支，不推断模糊的 Classic 分支。 */
function populateVersions(
  selectNode: HTMLSelectElement,
  versions: JsonObject[],
  ctx: PanelContext,
  current: string,
): void {
  const choices = versions.filter((row) => row.group === ctx.game);
  const next = select(
    [
      ['', ctx.t('选择游戏版本分支', 'Select game version branch')],
      ...choices.map((row) => [text(row.id), text(row.name)] as const),
    ],
    current,
  );
  selectNode.replaceChildren(...next.options);
  if (!choices.some((row) => String(row.id) === current)) selectNode.value = '';
}
