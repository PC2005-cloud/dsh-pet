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
import { LOGO_URL } from '../shared/avatar.ts';
import { PET_DISPLAYS } from '../shared/config.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';
import { DEFAULT_FONT, FONT_PRESETS } from '../shared/fonts.ts';
import { DEFAULT_PHYSICS } from '../shared/physics.ts';
import { aiScript } from './settings-page/script/ai.ts';
import { avatarScript } from './settings-page/script/avatar.ts';
import { bootScript } from './settings-page/script/boot.ts';
import { coreScript } from './settings-page/script/core.ts';
import { globalsScript } from './settings-page/script/globals.ts';
import { modelPickerScript } from './settings-page/script/model-picker.ts';
import { overlayScript } from './settings-page/script/overlay.ts';
import { petCardScript } from './settings-page/script/pet-card.ts';
import { petsScript } from './settings-page/script/pets.ts';
import { widgetsScript } from './settings-page/script/widgets.ts';
import { settingsPage } from './settings-page/chrome.ts';
import { settingsStyle } from './settings-page/style.ts';

export { settingsPage, settingsStyle };

/** 头像长边上限：与 client/settings/avatar-upload.ts 的 AVATAR_MAX_SIDE 对齐；页面脚本 import 不到，由测试钉住。 */
export const AVATAR_MAX_SIDE_PX = 512;

/** 整页脚本：公共层 + 控件 + 头像 + 宠物/全局/AI 三个面板 + 模型选择 + 启动。 */
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
  avatarScript({ logoUrl: LOGO_URL, maxSide: AVATAR_MAX_SIDE_PX }),
  petCardScript(),
  petsScript(),
  globalsScript(),
  modelPickerScript(),
  aiScript(),
  bootScript(),
  'boot();',
  '})();',
].join('\n');
