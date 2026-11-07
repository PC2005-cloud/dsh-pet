/** 游戏启动、主动截图与宏导入的设置表单。 */
import { object, text } from './api.ts';
import { action, card, checkbox, details, el, field, input, select, type PanelContext } from './dom.ts';

/** 创建经宿主验证可执行文件身份后保存的启动器配置。 */
export function launcherCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const state = object(ctx.state.launcher);
  const result = card(
    t('快捷启动魔兽世界', 'Quick launch World of Warcraft'),
    t(
      '选择战网或对应版本的游戏启动程序。保存时会检查文件身份与版本，校验通过后才能启动。',
      'Choose Battle.net or the executable for the selected game. Saving validates the executable identity and game version before it can be launched.',
    ),
  );
  const target = select(
    [
      ['battle-net', t('战网', 'Battle.net')],
      ['retail', t('正式服', 'Retail')],
      ['forever', t('无限服', 'Forever')],
      ['classic', t('怀旧服', 'Classic')],
    ],
    state.defaultTarget ?? ctx.game,
  );
  const paths = object(state.paths);
  const path = input(paths[target.value]);
  path.maxLength = 4096;
  path.placeholder = t('例如 D:\\Battle.net\\Battle.net.exe', 'e.g. D:\\Battle.net\\Battle.net.exe');
  target.addEventListener('change', () => {
    path.value = text(paths[target.value], '');
  });
  const makeDefault = checkbox(t('设为默认启动目标', 'Set as default launch target'), true);
  const output = el('div', '', 'dsh-wow-output');
  result.append(
    field(t('启动目标', 'Launch target'), target),
    field(t('启动程序完整路径', 'Full executable path'), path),
    makeDefault.node,
  );
  const row = el('div', '', 'dsh-wow-row');
  row.append(
    action(
      ctx,
      t('校验并保存启动程序', 'Validate and save launcher'),
      async () => {
        const saved = await ctx.api.action('launcher.save', ctx.game, {
          target: target.value,
          path: path.value.trim(),
          makeDefault: makeDefault.input.checked,
        });
        paths[target.value] = path.value.trim();
        output.replaceChildren(details(t('启动程序校验结果', 'Executable validation result'), saved));
        await ctx.refresh();
      },
      t('启动程序已通过校验并保存', 'Executable validated and saved'),
    ),
  );
  row.append(
    action(
      ctx,
      t('启动游戏', 'Launch game'),
      async () => {
        await ctx.api.action('launcher.launch', ctx.game, { target: target.value });
      },
      t('已发送启动请求', 'Launch request sent'),
    ),
  );
  if (state.supported === false) {
    row.querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
    result.append(
      el(
        'p',
        t(
          '当前平台不支持 Windows 启动程序校验与快捷启动。',
          'Windows executable validation and quick launch are unavailable on this platform.',
        ),
        'dsh-wow-hint',
      ),
    );
  }
  result.append(row, output);
  return result;
}

/** 配置用户主动询问时的游戏窗口截图。 */
export function screenCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(
    t('游戏截图与攻略辅助', 'Game screenshot assistance'),
    t(
      '启用后，在对话中主动说“帮我看看地形”或“带我找 NPC”，精灵会按请求获取游戏画面并分析。截图需要游戏窗口可见，以及支持图片的聊天模型。',
      'When enabled, ask the pet to inspect terrain or help find an NPC. It captures the game on request and analyzes it. Keep the game window visible and use an image-capable chat model.',
    ),
  );
  const screen = object(ctx.state.screen);
  const settings = object(screen.settings ?? screen);
  if (screen.error) result.append(el('p', text(screen.error), 'dsh-wow-hint'));
  result.append(
    el(
      'p',
      t(
        '临时截图分析目前适用于独立桌面模式；DSH 插件模式的聊天附件接口尚不支持临时截图，会明确提示无法分析。',
        'Temporary screenshot analysis is currently available in standalone desktop mode. DSH plugin chat cannot yet accept temporary screenshots and reports this limitation explicitly.',
      ),
      'dsh-wow-hint',
    ),
  );
  const enabled = checkbox(t('允许主动请求游戏截图', 'Allow requested game screenshots'), settings.enabled === true);
  const game = select(
    [
      ['auto', t('自动识别唯一游戏窗口', 'Detect the only running game window')],
      ['retail', t('正式服', 'Retail')],
      ['forever', t('无限服', 'Forever')],
      ['classic', t('怀旧服', 'Classic')],
    ],
    settings.game ?? 'auto',
  );
  result.append(enabled.node, field(t('截图游戏窗口', 'Game window to capture'), game));
  result.append(
    action(
      ctx,
      t('保存截图设置', 'Save screenshot settings'),
      async () => {
        await ctx.api.action('screen.save', ctx.game, {
          enabled: enabled.input.checked,
          game: game.value,
        });
        await ctx.refresh();
      },
      t('截图设置已保存', 'Screenshot settings saved'),
    ),
  );
  return result;
}

/** 导入宏仅发送到受控剪贴板桥，不执行游戏操作。 */
export function macroCard(ctx: PanelContext): HTMLElement {
  const { t } = ctx;
  const result = card(
    t('宏导入', 'Macro import'),
    t(
      '输入以 / 或 # 开头的宏，每个宏最多 255 个 UTF-8 字节。请在游戏中确认导入结果。',
      'Enter macro lines beginning with / or #, up to 255 UTF-8 bytes. Confirm the imported macro in game.',
    ),
  );
  if (ctx.game === 'classic') {
    result.append(el('p', t('怀旧服尚未接入宏导入桥。', 'Classic has no macro import bridge yet.'), 'dsh-wow-hint'));
    return result;
  }
  const body = el('textarea');
  body.maxLength = 2048;
  body.spellcheck = false;
  body.placeholder = '/cast ...';
  const count = el('p', '0 / 255 bytes', 'dsh-wow-hint');
  body.addEventListener('input', () => {
    count.textContent = `${new TextEncoder().encode(body.value).length} / 255 bytes`;
  });
  result.append(field(t('宏内容', 'Macro body'), body), count);
  result.append(
    action(
      ctx,
      t('导入游戏宏', 'Import macro'),
      async () => {
        const normalized = body.value.replace(/\r\n?/g, '\n').trim();
        if (!normalized || new TextEncoder().encode(normalized).length > 255)
          throw new Error(t('宏内容不能为空且不能超过 255 字节。', 'The macro must contain 1–255 UTF-8 bytes.'));
        await ctx.api.action('macro.import', ctx.game, { game: ctx.game, body: normalized });
      },
      t('宏导入请求已发送', 'Macro import request sent'),
    ),
  );
  return result;
}
