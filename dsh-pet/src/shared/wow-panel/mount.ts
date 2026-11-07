/**
 * DSH 与独立设置页共用的魔兽工具面板装配层。
 * 配置表单只在切换版本或手动刷新时重建，实况轮询保留用户未保存的输入。
 * 所有网络走宿主同源认证路由；卸载取消请求与计时器。
 * @module dsh-pet/src/shared/wow-panel/mount
 */
import { createWowApi, object, text, type JsonObject, type WowApi, type WowGame, type WowLocale } from './api.ts';
import { addonCards } from './addons.ts';
import { appearanceCard } from './appearance.ts';
import { companionCard, connectionCard } from './connection.ts';
import { action, el, field, select, type PanelContext } from './dom.ts';
import { comparisonCard, equipmentCard, goldCard, levelCard, loadoutCard } from './history.ts';
import { importCard, knowledgeCard, preferencesCard } from './knowledge.ts';
import { liveCard } from './live.ts';
import { launcherCard, macroCard, screenCard } from './tools.ts';

/** 面板挂载选项；API 替身仅用于离线验证。 */
export interface WowPanelOptions {
  api?: WowApi;
  game?: WowGame;
  locale?: WowLocale;
}

/** 挂载完整工具面板，返回销毁函数。 */
export function mountWowPanel(host: HTMLElement, options: WowPanelOptions = {}): () => void {
  const controller = new AbortController();
  const shell = el('div', '', 'dsh-wow');
  const status = el('p', '', 'dsh-wow-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const body = el('div', '', 'dsh-wow-output');
  const live = el('div', '', 'dsh-wow-output');
  const history = el('div', '', 'dsh-wow-output');
  let historySignature = '';
  let pending = false;
  let initialized = false;
  let revision = 0;
  const ctx: PanelContext = {
    game: options.game ?? 'retail',
    locale: options.locale ?? (navigator.language.startsWith('zh') ? 'zh-CN' : 'en'),
    state: {},
    api: options.api ?? createWowApi(controller.signal),
    t: (zh, en) => (ctx.locale === 'zh-CN' ? zh : en),
    task: (button, work, success) => {
      button.disabled = true;
      status.dataset.error = 'false';
      status.textContent = ctx.t('正在处理…', 'Working…');
      void work()
        .then(() => {
          if (!controller.signal.aborted) status.textContent = success ?? ctx.t('操作完成', 'Done');
        })
        .catch((error: unknown) => report(error))
        .finally(() => {
          button.disabled = false;
        });
    },
    refresh: async () => {
      await load(false);
    },
  };
  const report = (error: unknown): void => {
    if (controller.signal.aborted) return;
    status.dataset.error = 'true';
    status.textContent = error instanceof Error ? error.message : text(error);
  };
  const render = (): void => {
    shell.replaceChildren(
      header(ctx, () => load(true)),
      status,
      live,
      history,
      body,
    );
    live.replaceChildren(liveCard(ctx));
    historySignature = '';
    updateHistory();
    body.replaceChildren(...sections(ctx));
  };
  const updateHistory = (): void => {
    const current = profileHistory(ctx);
    const signature = JSON.stringify(current);
    if (signature === historySignature || history.contains(document.activeElement)) return;
    historySignature = signature;
    history.replaceChildren(
      ...(Object.keys(current).length
        ? [goldCard(ctx), equipmentCard(ctx), levelCard(ctx), comparisonCard(ctx), loadoutCard(ctx)]
        : []),
    );
  };
  const load = async (rebuild: boolean): Promise<void> => {
    const requestRevision = ++revision;
    const state = await ctx.api.state(ctx.game);
    if (controller.signal.aborted || requestRevision !== revision) return;
    ctx.state = state;
    live.replaceChildren(liveCard(ctx));
    updateHistory();
    if (rebuild) render();
  };
  host.replaceChildren(shell);
  render();
  status.textContent = ctx.t('正在读取魔兽陪伴状态…', 'Loading Warcraft companion state…');
  const bootstrap = () =>
    initialize(ctx, options, load).then(() => {
      initialized = true;
      if (!controller.signal.aborted)
        status.textContent = ctx.t('已连接本机魔兽陪伴服务', 'Connected to local Warcraft companion service');
    });
  void bootstrap().catch(report);
  const timer = setInterval(() => {
    if (pending || document.hidden || !host.isConnected) return;
    pending = true;
    // The settings page may still be exchanging its opening token for a cookie on the first read.
    // Retry full initialization after a transient auth/startup failure so saved language/forms are restored.
    void (initialized ? load(false) : bootstrap()).catch(report).finally(() => {
      pending = false;
    });
  }, 3000);
  return () => {
    controller.abort();
    clearInterval(timer);
    host.replaceChildren();
  };
}

/** 初次读取尊重已保存的游戏与语言偏好。 */
async function initialize(
  ctx: PanelContext,
  options: WowPanelOptions,
  load: (rebuild: boolean) => Promise<void>,
): Promise<void> {
  ctx.state = await ctx.api.state(ctx.game);
  const settings = object(ctx.state.settings);
  if (!options.game && ['retail', 'forever', 'classic'].includes(text(settings.activeGame)))
    ctx.game = settings.activeGame as WowGame;
  if (!options.locale && (settings.locale === 'zh-CN' || settings.locale === 'en')) ctx.locale = settings.locale;
  await load(true);
}

/** 游戏和语言选择会保存为聊天检索的全局偏好。 */
function header(ctx: PanelContext, reload: () => Promise<void>): HTMLElement {
  const { t } = ctx;
  const result = el('div', '', 'dsh-wow-output');
  result.append(el('h2', t('魔兽陪伴精灵', 'Warcraft companion')));
  const row = el('div', '', 'dsh-wow-row');
  const game = select(
    [
      ['retail', t('正式服', 'Retail')],
      ['forever', t('无限服', 'Forever')],
      ['classic', t('怀旧服', 'Classic')],
    ],
    ctx.game,
  );
  const locale = select(
    [
      ['zh-CN', '简体中文'],
      ['en', 'English'],
    ],
    ctx.locale,
  );
  const save = action(ctx, t('应用版本与语言', 'Apply game and language'), async () => {
    const settings = object(ctx.state.settings);
    const next = { ...preferences(settings), activeGame: game.value, locale: locale.value };
    await ctx.api.action('preferences.save', game.value as WowGame, next);
    ctx.game = game.value as WowGame;
    ctx.locale = locale.value as WowLocale;
    await reload();
  });
  row.append(
    field(t('游戏分区', 'Game'), game),
    field(t('界面与社区语言', 'Interface and community language'), locale),
    save,
  );
  row.append(action(ctx, t('刷新全部数据', 'Refresh all data'), reload));
  result.append(row);
  return result;
}

/** 配置表单和历史档案仅在明确刷新时重建。 */
function sections(ctx: PanelContext): HTMLElement[] {
  const current = object(object(ctx.state.profiles)[ctx.game]);
  return [
    appearanceCard(ctx),
    connectionCard(ctx),
    preferencesCard(ctx),
    ...(Object.keys(current).length ? [companionCard(ctx)] : []),
    launcherCard(ctx),
    screenCard(ctx),
    macroCard(ctx),
    ...addonCards(ctx),
    knowledgeCard(ctx),
    importCard(ctx),
  ];
}

/** 仅以持久化档案决定重绘，像素帧更新不会打断用户输入。 */
function profileHistory(ctx: PanelContext): JsonObject {
  const current = object(object(ctx.state.profiles)[ctx.game]);
  if (!Object.keys(current).length) return {};
  return {
    gold: current.gold,
    equipmentHistory: current.equipmentHistory,
    levelHistory: current.levelHistory,
    equipmentComparisons: current.equipmentComparisons,
    equipmentLoadouts: current.equipmentLoadouts,
  };
}

/** 只传偏好白名单，避免把宿主内部状态混入保存请求。 */
function preferences(settings: JsonObject): JsonObject {
  return {
    petId: text(settings.petId, ''),
    eventNotifications: settings.eventNotifications !== false,
    muted: settings.muted === true,
  };
}
