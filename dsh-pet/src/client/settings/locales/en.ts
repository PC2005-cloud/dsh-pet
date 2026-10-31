/**
 * 设置页英文文案；键集必须与 zh 完全一致，缺键或多键在类型检查期报错。
 */
import type { Key } from './zh.ts';

export const en: Record<Key, string> = {
  nav: 'Pet Config',
  intro: 'Manage multiple pets: each pet has its own size and position (applies instantly after saving).',
  // 卡片标题与卡片级说明；说明统一进问号气泡。
  petCardTitle: 'Pet',
  petCardHint:
    'Per-pet settings: name / size / display / corner / offsets / the four feature switches. Click "Save" at the bottom to apply instantly.',
  globalTitle: 'Global switches',
  globalHint:
    'Shared by every pet (a pet pack may override them in its own kind file). These switches only change local state and are written to the user config on "Save" (never written immediately); system notifications re-read right after saving, no page refresh needed.',
  cornerHint: 'Which screen corner the pet sticks to (per-monitor work area in desktop mode).',
  marginXHint: 'Horizontal distance from the chosen corner (px); any number.',
  marginYHint: 'Vertical distance from the chosen corner (px); any number.',
  // 「/」命令菜单的行标题（图标由 app.ts 补上）。
  'cmd.chat': 'Chat',
  'cmd.pet': 'Pet',
  'cmd.balance': 'Balance',
  'shortcut.open': 'Open pet chat',
  'shortcut.chat': 'Open chat bubble',
  'shortcut.hear': 'Voice input',
  shortcutCardTitle: 'Shortcuts',
  shortcutCardHint: 'The first key needs the pointer over the pet; keys with Ctrl are global.',
  shortcutRowChat: 'Open chat',
  shortcutRowHear: 'Voice input',
  shortcutRowTodo: 'Todo list',
  shortcutRowSleep: 'Sleep / wake',
  shortcutRowSidebar: 'Open sidebar chat',
  shortcutNoteDesktop:
    'Global shortcuts do not apply to the desktop pet window; rebind them in Settings → General → Shortcuts.',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  confirmRemove: 'Delete pet "{id}"?',
  confirmTitle: 'Confirm action',
  cancel: 'Cancel',
  ok: 'Got it',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  sizePercentLabel: 'Max screen width (%)',
  sizePercentHint:
    'How much of the screen width the pet may take: 100 = never wider than one screen (identical to px on wide windows); try 30–40 to make it clearly smaller on a phone without changing the desktop. Computed once on page load; refresh after resizing.',
  nameLabel: 'Name',
  nameHint:
    'Shown on hover and added to AI personas ("your name is X"). Duplicates allowed; empty falls back to the pet id.',
  personaLabel: 'Persona (optional)',
  personaHint:
    'Applies to this pet only. Leave empty to follow the entry persona — the grey text inside the box is exactly that. The system prompt actually sent = this text + an appended 「your name is "<name>"」 line + the current time context, so do not repeat the name or the date here.',
  personaCount: '{n} chars',
  balanceEnabled: 'Balance',
  balanceEnabledHint: 'When enabled, this pet plays balance animations and shows the balance bubble.',
  whisperEnabled: 'Whisper',
  whisperEnabledHint:
    'When enabled, this pet periodically generates a line via AI and plays the whisper animation (persona = the field below; empty follows the entry).',
  workStatusEnabled: 'Work status',
  workStatusEnabledHint:
    'When enabled, this pet follows DSH work state: thinking / working / waiting / done / error switch animations and show bubbles (pool in top-level config; listening only, no model calls).',
  fixedEnabled: 'Pin in place',
  fixedEnabledHint:
    'When enabled, the random chain no longer turns this pet or walks it away — only idle and in-place actions play. Right-click picks, API triggers and balance / whisper / work-status animations are unaffected.',
  displayLabel: 'Display',
  displayHint: 'web = browser only / desktop = desktop only / both = both / none = neither',
  'display.web': 'Browser only',
  'display.desktop': 'Desktop only',
  'display.both': 'Both',
  'display.none': 'Neither',
  cornerLabel: 'Position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save',
  saveHotkey: 'Ctrl+S / Cmd+S',
  sync: 'Sync',
  confirmSync:
    'Sync? This overwrites the user config with the bundled default config (all fields + comments); current customizations are lost.',
  corruptTitle: 'User config is corrupted — not saved',
  corruptConfirm: 'Save anyway',
  corruptBody:
    'The user config file cannot be parsed (corrupted, not valid JSON/JSONC): {path}. Saving now rebuilds it from the whitelist — everything currently in that file (animations / physics / memes …) will be lost. Cancel = leave the file untouched (fix it and save again); Confirm = save anyway (discard what is in the file).',
  syncHint:
    '"Sync" writes the bundled default config (comments + every advanced field included) to the user config file, overwriting your current customizations; the file is then directly editable. Two caveats: (1) once created, that file is an explicit override layer — later changes to the bundled defaults will not take effect automatically (until you sync again or delete the file); (2) clicking "Save" on this page rewrites the file from a whitelist — field values are kept, comments are dropped.',
  configMeta: 'Advanced (files)',
  configMetaHint:
    'User config may override pets / animation pools / weights — refresh or restart to apply: refresh the page in the browser, or right-click a desktop pet → "Reload config" (rebuilds every desktop pet window). The default config is the complete reference.',
  defaultConfig: 'Default config (read-only, complete reference)',
  userConfig: 'User config (custom overrides)',
  todosFile: 'Todo data (text, due time and done state; deleting it clears every todo)',
  animationDir: 'Animation assets dir (add/customize animations here)',
  memesDir: 'Meme images dir (add/customize images here)',
  logFile: 'Log file (for troubleshooting; safe to clear)',
  logFileNote:
    'The DSH desktop app has no console, so every runtime log of the plugin (startup, desktop pet crashes/restarts, errors and warnings) goes into this single file — attach it when reporting a problem. It is capped at 1 MB; once full, only the latest 512 KB is kept.',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  saveError:
    'Failed to save config. Check the server connection, configuration directory write permissions and server log.',
  saveInvalid: 'Failed to save config: invalid configuration. Check the values and try again.',
  syncError: 'Failed to sync config. Check the server connection and configuration directory write permissions.',
  loading: 'Loading config…',
  retry: 'Retry',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  extraPetsHint:
    "{n} more kind(s) come from files in the pet/ directory (<name>-config.json + <name>-animation/). Switch to them in the Kinds row above; Save writes back to each pack's own config, never into main-config.jsonc.",
  kindLabel: 'Kinds',
  kindMain: 'Built-in',
  lastOfKind:
    '"{entry}" has only this pet left — deleting it would remove the whole kind. Delete the pet pack files to remove it entirely.',
  savePartial:
    'Main pets saved, but {names} could not be written back: check that the pack config is valid and the directory is writable.',
  notifyToggle: 'System notifications',
  notifyToggleHint:
    'OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.',
  clickSoundToggle: 'Click sound',
  clickSoundToggleHint:
    'Plays the built-in click sound (assets/sound/click-duck.wav, volume 0.5) when a pet is clicked; repeated clicks within 100ms play only once, so multiple pets never stack up. Turn it off for silence. Written to the user config together with Save.',
  whisperImageToggle: 'Whisper images',
  whisperImageToggleHint:
    'Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.',
  chatImageToggle: 'Chat images',
  chatImageToggleHint:
    'Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.',
  chatAnimationToggle: 'Chat actions',
  chatAnimationToggleHint:
    'When on, the chat request carries the list of playable animations (every action under animations.categories): if the model judges that the line really performs one, the pet acts it out on the spot; otherwise it replies in text only. Tokens: every message carries the whole list; off appends nothing. Global default for all pets (a pet pack can override it in its own config file).',
  confineToggle: 'Lock to the current screen',
  confineToggleHint:
    'Multi-monitor: when on, the pet stays inside the screen it is currently on — a thrown pet bounces only inside the screen it was released on (screen seams act as walls, so it never flies to the neighbouring monitor), and autonomous wandering only walks within the screen it is currently on (a step that would cross the seam is simply cancelled). Turn this off to let it cross screens as usual. Desktop only — the browser overlay always stays inside the viewport anyway.',
  trayToggle: 'System tray',
  trayToggleHint:
    'Shows a tray icon (notification area on Windows, menu bar on macOS) once desktop mode is running. It lists every pet in the config and toggles each one between desktop and web/none — including pets that are currently off the desktop and therefore have no window to right-click. With it off, bringing a pet back to the desktop requires opening the browser (the settings page, or right-clicking a web pet there). Windows already folds third-party icons into the "hidden icons" overflow. Desktop mode only.',
  voiceTitle: 'Voice',
  voiceHint:
    'Three switches plus a voice: the master switch gates automatic speech, the two sub-switches gate one kind of proactive message each. All off by default; written to the user config on "Save" (never written immediately).',
  voiceEnabled: 'Speak replies',
  voiceEnabledHint:
    'Master switch for automatic speech. When off, periodic whispers and todo reminders stay silent (the two sub-switches below have no effect). Manual whispers, chat replies and the speaker button in the chat panel are not gated — you asked for those, so the surface you asked from speaks them directly. It only affects whether sound is produced — bubbles, chat memory and system notifications are untouched; a failed synthesis is logged and never interrupts the conversation.',
  voiceWhisperEnabled: 'Speak whispers',
  voiceWhisperEnabledHint:
    'Speaks the periodically generated whisper (right-clicking for a manual whisper is unaffected). Gated by the master switch above. Off by default — whispers are background narration and should not make noise unasked.',
  voiceTodoEnabled: 'Speak todo reminders',
  voiceTodoEnabledHint:
    'Speaks a todo reminder when it comes due (the bubble still appears; this only decides whether it is spoken). Gated by the master switch above. Off by default.',
  voiceNameLabel: 'Voice',
  physicsTitle: 'Physics (drag & throw feel)',
  physicsHint:
    'Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on "Save" (never written immediately). Applies instantly in the browser; on the desktop it applies once Save reloads the pet windows.',
  mobileTitle: 'Mobile effects',
  mobileHint:
    'Only meaningful in a phone browser: haptics needs a vibration motor, the two motion switches need tilt / accelerometer sensors, and sensors require HTTPS or localhost.',
  'physics.gravity': 'Gravity',
  'physics.gravityHint': 'px/s² — the higher, the faster it falls; 0 = weightless (flies straight forever)',
  'physics.restitution': 'Bounciness',
  'physics.restitutionHint':
    '0–1, speed kept when bouncing off a wall or the floor (1 = perfectly elastic, 0 = stops dead)',
  'physics.groundFriction': 'Contact friction',
  'physics.groundFrictionHint':
    'per second, damping along any surface hit (wall, floor, ceiling); 0 = frictionless ice everywhere',
  'physics.throwPower': 'Throw power',
  'physics.throwPowerHint':
    '> 0, overall multiplier for spring tracking and release speed (1 = default; higher = tighter tracking, harder throws)',
  physicsCeilingBounce: 'Ceiling bounce',
  physicsCeilingBounceHint:
    'Turn this off to let a throw fly out through the top of the screen (gravity still pulls it back)',
  physicsPetCollision: 'Pet collisions',
  physicsPetCollisionHint: 'A flying pet bounces off the others with momentum conservation (mass ∝ size²)',
  physicsHaptic: 'Collision haptics',
  physicsHapticHint:
    'One buzz per hit (walls, floor, ceiling, other pets). Works in Chrome/Edge; not on iOS or WebView shells like Via. Do Not Disturb blocks it.',
  physicsTilt: 'Tilt gravity',
  physicsTiltHint:
    'Tilt the phone and gravity follows it (magnitude = the gravity value above); with gravity at 0 tilt has no effect. Requires HTTPS/localhost.',
  physicsShake: 'Shake to throw',
  physicsShakeHint:
    'Shake to fling the pet along the shake direction; strength scales with throwPower. Independent of gravity, so it still works at gravity 0. Requires HTTPS/localhost.',
  invalidPhysics: 'Check the physics values: gravity / ground friction ≥ 0, bounciness 0–1, throw power > 0.',
  fontTitle: 'Appearance & font',
  fontHint:
    'The family applies to every place that currently uses the candy font: pet bubble, hover tooltip, chat popup, score popup. The size applies only to the pet bubble and the hover tooltip (chat and score popups keep their own size). Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on "Save" — instant in the browser, and on the desktop it applies once Save reloads the pet windows.',
  fontFamilyLabel: 'Font',
  fontFamilyHint:
    '"Candy (bundled)" ships with the plugin; the others are system fonts. If a font is missing on this machine, it falls back to the next one in the stack (never blank, never an error).',
  fontSizeLabel: 'Font size (px)',
  fontSizeHint:
    'Bubble body text size; the tooltip and the smaller lines inside the bubble scale proportionally. Range 4–200.',
  fontFollowToggle: 'Scale font with pet size',
  fontFollowToggleHint:
    'On (default): the font grows with the pet — at 462 px width it is exactly the size above. Off: the size stays fixed regardless of pet size.',
  invalidFont:
    'Check the font settings: the family must be in the list and the size must be a number between 4 and 200.',
  'font.candy': 'Candy (bundled)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'System default',
  modelTitle: 'Chat & models',
  modelHint:
    'Which model each of whisper and chat uses, and how much history every chat request carries. "Follow current conversation" uses the model your current conversation is on (default). Global default: applies to every pet, and a pet pack may override it in its own kind file. The options come from the same source as the DSH model picker, served live by the host.',
  modelFollow: 'Follow current conversation',
  modelSearch: 'Search models…',
  modelEmpty: 'No matching models.',
  modelNoModels: 'No models available.',
  modelLoading: 'Refreshing model list…',
  modelTriggerAria: 'Select model, current {model}',
  modelUnknown: ' (current config, not in the list)',
  modelNone: 'No models available for this provider',
  whisperModelLabel: 'Whisper model',
  chatModelLabel: 'Chat model',
  modelFieldHint:
    '"Follow current conversation" uses the conversation model; if a chosen model fails, the plugin falls back to the conversation model and retries once.',
  invalidModel:
    'Check the model settings: pick both a provider and a model, or leave both empty (follow the current conversation).',
  modelCatalogFailed:
    'Failed to load the model list (refresh the page to retry); your current values are kept as they are.',
  chatMemory: 'Chat history rounds',
  chatMemoryHint:
    'How many recent rounds each chat request carries (1 round = 1 question + 1 answer; 0 = no history, every message starts fresh). The memory itself keeps everything — this only decides how much goes into the context: higher remembers more and costs more tokens. Global default, shared by every pet (a pet pack may override it in its own kind file).',
  invalidChatMemory: 'Check the chat history rounds: it must be a number ≥ 0.',
  chatImageLimit: 'Chat image limit',
  chatImageLimitHint:
    'How many memes at most are listed to the model during chat ("first N" = the first N you wrote in the config, so move the ones you want sent to the front). That whole list is attached to every message and tokens grow linearly with the count, so a long list is pure burn; capping it to the first N makes the model pick only among those. 0 = no limit (send everything). Built-in default 10. Global default, shared by every pet (a pet pack may override it in its own kind file). Chat only — a whisper carries just the one meme it drew.',
  invalidChatImageLimit: 'Check the chat image limit: it must be a number ≥ 0 (0 = no limit).',
  notifyTest: 'Test notification',
  notifyTestOk: 'Test notification sent — check the bottom-right of your desktop.',
  notifyDenyUnsupported: 'System notifications are not supported in this environment (no Notification API).',
  notifyDenyBlocked: 'Notification permission is blocked by the browser.',
  notifyDenyRejected: 'You chose "Block" in the permission prompt.',
  notifyDenyError: 'Failed to request permission',
  notifyGuide:
    'Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to "Allow", then refresh and retry.',
  storageTitle: 'Uninstall & storage',
  storageHint:
    'Every location this plugin writes to. Deleting cache folders is harmless (they re-download / rebuild); deleting "plugin user data" loses your config and chat memory.',
  'storage.userData':
    'Plugin user data: custom config main-config.jsonc, chat memory memory.json, custom animation assets main-animation/, file pets pet/',
  'storage.electron':
    'Electron runtime used by the desktop pet (large; re-downloaded automatically the next time desktop mode starts)',
  'storage.desktopCache':
    'Desktop pet window cache and primary-monitor scale cache (safe to delete, rebuilt automatically)',
  'storage.electronCache': 'Electron installer download cache (safe to delete, re-downloaded when needed)',
  'storage.package': 'The plugin itself (managed by DSH — remove it with the command below instead of deleting it)',
  storageMissing: ' (not created yet)',
  uninstallTitle: 'How to uninstall',
  uninstallStep1:
    '1. Quit DSH first (the desktop pet exits with it); do not delete these files while the pet is running.',
  uninstallStep2: '2. Remove the plugin itself (run in a terminal; this also drops it from the profile bundle layer):',
  uninstallStep3:
    '3. Delete the locations above as needed: cache folders are harmless; deleting "plugin user data" loses your config and chat memory (back up main-config.jsonc first if you want to keep it).',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};
