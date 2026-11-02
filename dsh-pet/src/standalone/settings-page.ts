/**
 * 本机设置页的三份静态资源：HTML、CSS 与脚本。
 *
 * 只在本机回环上由 ./server 提供；不包含构建步骤，也不依赖外部 CDN。
 * 必须始终成立：脚本从地址片段读一次令牌后立刻清掉片段；页面不内联脚本与样式，
 * 以便 CSP 保持 default-src 'none'。
 * @module dsh-pet/src/standalone/settings-page
 */
import { CORNER_SET } from '../host/config/constants.ts';
import { VOICES } from '../host/voice/voices.ts';
import { PET_DISPLAYS } from '../shared/config.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';
import { DEFAULT_FONT, FONT_PRESETS } from '../shared/fonts.ts';
import { DEFAULT_PHYSICS } from '../shared/physics.ts';
import { aiScript } from './settings-page/script/ai.ts';
import { bootScript } from './settings-page/script/boot.ts';
import { coreScript } from './settings-page/script/core.ts';
import { globalsScript } from './settings-page/script/globals.ts';
import { overlayScript } from './settings-page/script/overlay.ts';
import { petsScript } from './settings-page/script/pets.ts';
import { widgetsScript } from './settings-page/script/widgets.ts';
import { settingsPage } from './settings-page/chrome.ts';
import { settingsStyle } from './settings-page/style.ts';

export { settingsPage, settingsStyle };

/** 整页脚本：公共层 + 控件 + 宠物/全局/AI 三个面板 + 启动。 */
export const settingsScript = [
  '(function () {',
  coreScript(ROUTE_SEGMENT, {
    voices: VOICES.map((voice) => ({ id: voice.id, name: voice.name, tag: voice.tag })),
    fonts: FONT_PRESETS.map((preset) => preset.id),
    displays: PET_DISPLAYS,
    corners: [...CORNER_SET],
    physics: DEFAULT_PHYSICS,
    font: DEFAULT_FONT,
  }),
  widgetsScript(),
  overlayScript(),
  petsScript(),
  globalsScript(),
  aiScript(),
  bootScript(),
  'boot();',
  '})();',
].join('\n');
