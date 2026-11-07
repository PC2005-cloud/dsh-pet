/** 采集桥、事件提醒与演示的配置表单。 */
import { object } from './api.ts';
import { action, card, checkbox, el, field, input, profile, select, type PanelContext } from './dom.ts';

/** 创建当前游戏的采集坐标和轮询设置。 */
export function connectionCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(t('游戏连接与采集', 'Game connection and capture'));
  if (ctx.game === 'classic') {
    result.append(
      el(
        'p',
        t(
          '怀旧服暂未接入实时像素采集桥；可使用知识库、游戏启动、截图辅助和插件管理。',
          'Classic has no live pixel bridge yet. Knowledge, launcher, screenshot assistance and addons are available.',
        ),
      ),
    );
    return result;
  }
  result.append(
    el(
      'p',
      t(
        '在游戏中启用 WowCompanion 插件，保持左上角像素条可见。坐标是屏幕像素；暂停采集不会关闭游戏。',
        'Enable the WowCompanion addon and keep its top-left pixel strip visible. Coordinates use screen pixels. Pausing capture leaves the game running.',
      ),
      'dsh-wow-hint',
    ),
  );
  result.append(
    el(
      'p',
      t(
        '实时采集桥需要本机 Python 3.10 或更新版本，无需 pip 安装依赖。游戏插件与桥接文件目录：',
        'The live bridge requires local Python 3.10 or newer, with no pip dependencies. Bundled game addons and bridge directory:',
      ),
      'dsh-wow-hint',
    ),
  );
  result.append(el('code', String(object(ctx.state.runtime).directory ?? 'runtime/wow')));
  const config = object(object(profile(ctx).bridge).config);
  const grid = el('div', '', 'dsh-wow-grid');
  const fields = [
    ['x', t('采集 X', 'Capture X'), -32768, 32767, 8],
    ['y', t('采集 Y', 'Capture Y'), -32768, 32767, 8],
    ['cellSize', t('像素格大小', 'Cell size'), 1, 12, 1],
    ['pollMs', t('轮询间隔（毫秒）', 'Poll interval (ms)'), 100, 5000, 100],
  ] as const;
  const inputs = new Map<string, HTMLInputElement>();
  for (const [key, label, min, max, fallback] of fields) {
    const control = input(config[key] ?? fallback, 'number');
    control.min = String(min);
    control.max = String(max);
    control.required = true;
    inputs.set(key, control);
    grid.append(field(label, control));
  }
  const paused = checkbox(t('暂停采集', 'Pause capture'), config.paused === true);
  const form = el('form');
  const save = action(
    ctx,
    t('保存采集设置', 'Save capture settings'),
    async () => {
      if (!form.reportValidity()) return;
      const settings = Object.fromEntries([...inputs].map(([key, control]) => [key, control.valueAsNumber]));
      await ctx.api.action('capture.save', ctx.game, { ...settings, paused: paused.input.checked });
      await ctx.refresh();
    },
    t('采集设置已保存', 'Capture settings saved'),
  );
  form.append(grid, paused.node, save);
  form.addEventListener('submit', (event) => event.preventDefault());
  result.append(form);
  return result;
}

/** 创建版本独立的陪伴事件配置。 */
export function companionCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(t('陪伴与事件提醒', 'Companion and event notifications'));
  const settings = object(profile(ctx).settings);
  if (!Object.keys(settings).length) {
    result.append(
      el('p', t('当前分区没有实时陪伴设置。', 'This game has no live companion settings.'), 'dsh-wow-hint'),
    );
    return result;
  }
  const options = [
    ['enabled', t('启用陪伴事件', 'Enable companion events')],
    ['muted', t('静音', 'Mute')],
    ['quietInCombat', t('战斗时保持安静', 'Stay quiet during combat')],
    ['allowDemo', t('允许演示事件提醒', 'Allow demo event notifications')],
    ['levelUp', t('升级', 'Level up')],
    ['zone', t('切换区域', 'Zone change')],
    ['death', t('死亡', 'Death')],
    ['revive', t('复活', 'Revive')],
  ] as const;
  const controls = options.map(([key, label]) => ({ key, ...checkbox(label, settings[key] === true) }));
  const grid = el('div', '', 'dsh-wow-grid');
  grid.append(...controls.map((control) => control.node));
  const cooldown = input(settings.cooldownSeconds ?? 20, 'number');
  cooldown.min = '0';
  cooldown.max = '300';
  result.append(grid, field(t('提醒冷却（秒）', 'Notification cooldown (seconds)'), cooldown));
  result.append(
    action(
      ctx,
      t('保存事件设置', 'Save event settings'),
      async () => {
        if (!cooldown.reportValidity()) return;
        const values = Object.fromEntries(controls.map((control) => [control.key, control.input.checked]));
        await ctx.api.action('settings.save', ctx.game, { ...values, cooldownSeconds: cooldown.valueAsNumber });
        await ctx.refresh();
      },
      t('事件设置已保存', 'Event settings saved'),
    ),
  );
  result.append(demoControls(ctx));
  return result;
}

/** 显式进入演示模式，防止模拟数据混作真实角色记录。 */
function demoControls(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = el('div', '', 'dsh-wow-row');
  const type = select(
    [
      ['none', t('演示在线', 'Demo online')],
      ['level_up', t('升级', 'Level up')],
      ['zone', t('切换区域', 'Zone change')],
      ['death', t('死亡', 'Death')],
      ['revive', t('复活', 'Revive')],
      ['combat', t('战斗', 'Combat')],
    ],
    'none',
  );
  result.append(field(t('演示事件（模拟数据）', 'Demo event (simulated data)'), type));
  for (const enabled of [true, false]) {
    result.append(
      action(ctx, enabled ? t('运行演示', 'Run demo') : t('停止演示', 'Stop demo'), async () => {
        await ctx.api.action('demo', ctx.game, { enabled, action: enabled ? type.value : 'none' });
        await ctx.refresh();
      }),
    );
  }
  return result;
}
