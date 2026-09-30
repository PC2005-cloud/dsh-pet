/**
 * 桌宠配置管理设置页（settings.section 插槽，id: pet-config）
 *
 * - 多开：管理多个桌宠，每个宠物独立 id/name/size/位置（corner + marginX/Y）
 * - 数据流：设置页持有「main 条目宠物列表」→ 保存时全量 PUT /dsh-pet-7340/config
 *   （写用户层 main-config.jsonc = 可编辑层，文件宠物永不回写）
 * - 数据入口：配置由 host readAllConfig 合并为**成品**（GET /dsh-pet-7340/config），
 *   设置页只读 main 条目（可编辑）+ 统计文件宠物条数，不做任何校验
 * - 即时生效：保存/同步后用 host 返回的**成品聚合**调用 petBridge.reload，
 *   容器走同一份 flattenConfigPets 重新渲染，无需刷新页面（设置页不自己拼任何条目级字段）
 *
 * 样式对齐官方设置页：max-width 720px、全走 --dsw-alias-* 语义 token（主题跟随）。
 */
import { PET_DISPLAYS } from '../shared/config';
import { NOTIFY_ICONS, reloadNotifications, requestNotificationPermission } from './notify';
import type { Corner, Pet, PetDisplay } from '../shared/types';
import type { ChangeEvent, CSSProperties, Dispatch, FunctionComponent, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 容器与设置页共享的桥（同一 bundle 单例）：
 * current=最新完整宠物列表（**成品拍平**，含条目级字段与文件宠物，默认空；容器是唯一写入方）；
 * reload=容器注册的重载回调（未注册时为无操作函数）：传 host 保存接口返回的成品聚合即直接拍平，
 *   缺省则由容器自行 GET /config；template=main 条目的宠物[0]（「添加宠物」用它作为默认配置） */
export const petBridge: {
  current: Pet[];
  reload: (merged?: Record<string, Record<string, unknown>>) => void;
  template: Pet | undefined;
} = {
  current: [],
  reload: () => {},
  template: undefined,
};

/** 字典命名空间 */
export const NS = 'pet.config';

export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  confirmRemove: '确定删除宠物「{id}」吗？',
  confirmTitle: '确认操作',
  cancel: '取消',
  atLeastOne: '至少保留一个宠物。',
  emptyPets: '暂无宠物，点击「添加宠物」创建。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  nameLabel: '名字',
  nameHint: '显示名：鼠标悬浮宠物时弹出，也会加进 AI 人设（你的名字是 X）。可重复，留空按宠物 id 处理。',
  balanceEnabled: '余额功能',
  balanceEnabledHint: '启用后该宠物触发余额动画并显示余额气泡。',
  whisperEnabled: '碎碎念',
  whisperEnabledHint: '启用后该宠物按周期用 AI 生成一句话并播碎碎念动画（人设与周期在配置文件顶层）。',
  workStatusEnabled: '工作状态联动',
  workStatusEnabledHint:
    '启用后该宠物跟随 DSH 工作状态：思考/工作中/等待确认/完成/出错时自动切对应动画并弹气泡（动画池在配置顶层，仅监听不调用模型）。',
  displayLabel: '显示位置',
  displayHint: 'web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示',
  'display.web': '仅浏览器',
  'display.desktop': '仅桌面',
  'display.both': '两者都显示',
  'display.none': '都不显示',
  cornerLabel: '位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
  marginX: '水平偏移',
  marginY: '垂直偏移',
  save: '保存',
  sync: '同步',
  confirmSync: '确定同步吗？将用项目内置的默认配置（完整字段 + 注释）覆盖用户配置，当前的自定义内容会丢失。',
  corruptTitle: '用户配置已损坏，未保存',
  corruptConfirm: '强行保存',
  corruptBody:
    '用户配置文件解析不了（内容已损坏，不是合法 JSON/JSONC）：{path}。继续保存会按白名单重建这个文件——它里面现有的内容（animations / physics / memes 等自定义字段）会全部丢失。取消 = 不动文件（先去把配置改回合法再保存）；确认 = 强行保存（丢弃文件里现有的内容）。',
  syncHint:
    '「同步」会把项目内置的默认配置（含注释与全部高级字段）写入用户配置文件，覆盖当前自定义内容；之后可直接编辑该文件。注意两点：① 文件一旦生成即为显式覆盖层——插件升级后内置默认的变化不会自动生效（除非再次同步或删除该文件）；② 在本页点「保存」会按白名单重写该文件（字段值保留，但注释会被去掉）。',
  configMeta: '高级配置（文件）',
  configMetaHint:
    '用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效：浏览器端刷新页面，桌面端右键宠物 →「重载配置」（重载全部桌面宠物窗口）；默认配置为完整参考。',
  defaultConfig: '默认配置（只读，完整参考）',
  userConfig: '用户配置（自定义覆盖）',
  animationDir: '动画素材目录（可自定义/扩充动画）',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
  extraPetsHint:
    '另 {n} 只额外宠物由 pet/ 目录文件定义（<名>-config.json + <名>-animation/），它们不在此列表——改文件后浏览器刷新页面、桌面端右键「重载配置」即可生效。',
  notifyToggle: '系统通知',
  notifyToggleHint: '对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。',
  whisperImageToggle: '碎碎念配图',
  whisperImageToggleHint:
    '碎碎念时从表情包池随机抽一张，连同那句话一起显示（图片映射在配置文件顶层 memes）。token：碎碎念本来就每次生成都要调一次模型，配图只是把抽中那张的名称+描述（约 100 字符 / ≈60 token）加进同一次请求，增量可忽略。',
  chatImageToggle: '对话配图',
  chatImageToggleHint:
    '对话时由 AI 按当前语境从表情包池挑一张配图（可不挑；图片映射在配置文件顶层 memes）。token：每条消息都要把整张清单附进请求，当前约 1.1k 字符（≈650 token，约碎碎念配图的 11 倍），并随图片数量线性增长；关掉则一个字符都不附。',
  confineToggle: '抛掷锁定在当前屏幕',
  confineToggleHint:
    '多屏用户：甩出去的宠物只在松手时所在那块屏幕内弹（屏缝当墙，不飞到隔壁屏）；关掉则照常跨屏飞行。只影响桌面模式——浏览器 overlay 本来就只在视口内弹。',
  notifyGetPermission: '获取权限',
  notifyPermissionOk: '已获得通知权限，右下角出现测试通知。',
  notifyDenyUnsupported: '当前环境不支持系统通知（浏览器无 Notification API）。',
  notifyDenyBlocked: '通知权限已被浏览器标记为「阻止」。',
  notifyDenyRejected: '你在权限询问弹窗中选择了「阻止」。',
  notifyDenyError: '申请权限时出错',
  notifyGuide: '引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。',
  storageTitle: '卸载与存储',
  storageHint: '插件在本机落下的全部位置。删缓存不影响使用（会自动重下/重建）；删「插件用户数据」会丢配置与对话记忆。',
  'storage.userData':
    '插件用户数据：自定义配置 main-config.jsonc、对话记忆 memory.json、自定义动画素材 main-animation/、文件宠物 pet/',
  'storage.electron': '桌面宠物用的 Electron 运行时（体积较大；删除后下次启用桌面模式会自动重新下载）',
  'storage.desktopCache': '桌面宠物窗口的缓存与主屏缩放缓存（可删，会自动重建）',
  'storage.electronCache': 'Electron 安装包下载缓存（可删，需要时会重新下载）',
  'storage.package': '插件本体（由 DSH 管理，用下面的卸载命令移除，不要手删）',
  storageMissing: '（尚未创建）',
  uninstallTitle: '卸载方法',
  uninstallStep1: '1. 先退出 DSH（桌面宠物随之退出）；不要在桌宠运行时删除上面的文件。',
  uninstallStep2: '2. 卸载插件本体（终端执行，会同时从 profile 的 bundle 层移除）：',
  uninstallStep3:
    '3. 按需删除上面的位置：缓存类删了无影响；「插件用户数据」删了会丢配置与对话记忆（想保留就先备份其中的 main-config.jsonc）。',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};

export const en = {
  nav: 'Pet Config',
  intro: 'Manage multiple pets: each pet has its own size and position (applies instantly after saving).',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  confirmRemove: 'Delete pet "{id}"?',
  confirmTitle: 'Confirm action',
  cancel: 'Cancel',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  nameLabel: 'Name',
  nameHint:
    'Shown on hover and added to AI personas ("your name is X"). Duplicates allowed; empty falls back to the pet id.',
  balanceEnabled: 'Balance',
  balanceEnabledHint: 'When enabled, this pet plays balance animations and shows the balance bubble.',
  whisperEnabled: 'Whisper',
  whisperEnabledHint:
    'When enabled, this pet periodically generates a line via AI and plays the whisper animation (persona & interval live in the top-level config).',
  workStatusEnabled: 'Work status',
  workStatusEnabledHint:
    'When enabled, this pet follows DSH work state: thinking / working / waiting / done / error switch animations and show bubbles (pool in top-level config; listening only, no model calls).',
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
  animationDir: 'Animation assets dir (add/customize animations here)',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  extraPetsHint:
    '{n} extra pet(s) are file-defined in the pet/ directory (<name>-config.json + <name>-animation/). They are not in this list — after editing the files, refresh the page (browser) or right-click a desktop pet → "Reload config".',
  notifyToggle: 'System notifications',
  notifyToggleHint:
    'OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.',
  whisperImageToggle: 'Whisper images',
  whisperImageToggleHint:
    'Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.',
  chatImageToggle: 'Chat images',
  chatImageToggleHint:
    'Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.',
  notifyGetPermission: 'Get permission',
  notifyPermissionOk: 'Notification permission granted — a test notification was sent.',
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

/**
 * 制造「桌宠配置」设置页组件（工厂函数）。
 *
 * 为什么是工厂而非直接定义组件：client 半侧是 __ModuleLoader__ 单文件形态，
 * react 能力不能顶层 import，只能由 DSH 的 require('react') 在运行时注入，
 * 因此把组件依赖作为参数传入，在工厂内制造出可用的组件后再注册进设置页插槽。
 *
 * @param rt        运行时注入的依赖集合
 * @param rt.h      react/jsx-runtime 的 jsx 函数（即 factory 里的 `h`）——
 *                  用于手写 React 元素，如 `h('button', { onClick, children: '保存' })`
 * @param rt.useState react 的 useState hook——管理页面内可变状态
 *                  （宠物列表 / 选中项 / 忙碌 / 保存消息），值变化时自动重渲染
 * @param rt.t      locale 绑定到本插件的翻译函数（ctx.locale.bind(NS)）——
 *                  取中英文文案，如 `t('nav')` → '桌宠配置' / 'Pet Config'
 * @returns PetConfigSection 组件：即整个「桌宠配置」设置页
 *          （props 仅有 close，由设置页外壳提供，本页当前未使用）
 */
export function makePetConfigSection(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  t: (key: string) => string;
}): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, t } = rt;

  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  const inputStyle = {
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '5px 10px',
    fontSize: '13px',
    minHeight: '28px',
    outline: 'none',
  } as CSSProperties;

  /** 等宽字体栈（路径与命令展示用；不引外部字体，走系统栈，避免多拉一份资源） */
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

  /** 生成一个未占用的宠物 id（pet-2、pet-3…） */
  const nextId = (list: Pet[]): string => {
    let n = 2;
    for (; ; n++) {
      const id = 'pet-' + n;
      if (!list.some((p) => p.id === id)) return id;
    }
  };

  /** 全局开关的一格（2×2 网格单元）：勾选框 + 标题在上，描述在下。
   *  label 为文案键：标题 = t(label)，描述 = t(label + 'Hint')；描述左缩进 24px 与标题同列对齐
   *  （勾选框 16px + 间距 8px）。label 元素包住整格，点标题或描述都能切换。 */
  const toggleCell = (
    label: string,
    value: boolean,
    disabled: boolean,
    onToggle: (v: boolean) => void,
  ): ReturnType<typeof h> =>
    h('label', {
      key: label,
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minWidth: 0,
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      children: [
        h('span', {
          style: { display: 'flex', gap: '8px', alignItems: 'center' },
          children: [
            h('input', {
              type: 'checkbox',
              checked: value,
              disabled,
              onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
              style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
            }),
            h('span', { children: t(label) }),
          ],
        }),
        h('span', {
          style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', paddingLeft: '24px' },
          children: t(label + 'Hint'),
        }),
      ],
    });

  return function PetConfigSection() {
    const initPets = petBridge.current.filter((p) => !p.extra);
    // 文件定义宠物数量（pet/ 目录，不在本编辑列表；仅展示提示）
    const extraCount = petBridge.current.filter((p) => p.extra).length;
    const [pets, setPets] = useState<Pet[]>(initPets.map((p) => ({ ...p, position: { ...p.position } })));
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 确认/提示弹窗（仿官方弹窗：遮罩 + 居中卡片 + 双按钮）：
    //   remove  —— 删除宠物
    //   sync    —— 同步（说明会用内置默认整份覆盖）
    //   corrupt —— 保存时发现用户配置**已损坏**（解析不了）：取消 = 不动文件，确认 = 强行白名单重建
    const [dialog, setDialog] = useState<
      null | { kind: 'remove' } | { kind: 'sync' } | { kind: 'corrupt'; path: string }
    >(null);
    // 配置文件地址与存储位置清单（「高级配置」「卸载与存储」区块；读取失败仅缺省不显示，不影响表单）
    const [paths, setPaths] = useState<null | {
      user: string;
      default: string;
      animations: string;
      /** 插件落盘的全部位置（路径 + 是否已存在），host 按平台推导 */
      storage?: Array<{ key: string; path: string; exists?: boolean }>;
      /** 当前 profile 名（拼卸载命令用；反推不出时为空串） */
      profile?: string;
    }>(null);
    useEffect(() => {
      fetch('/dsh-pet-7340/config/meta')
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => setPaths(p))
        .catch(() => console.warn('[dsh-pet] 读取配置文件路径失败'));
    }, []);

    // 系统通知总开关（全局：读写用户级配置 main-config.jsonc 的 notificationsEnabled；即时生效）
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 表情包配图开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [whisperImage, setWhisperImage] = useState(false);
    const [chatImage, setChatImage] = useState(false);
    // 抛掷锁定开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [confineScreen, setConfineScreen] = useState(false);
    // 权限申请按钮的反馈（就地显示在按钮旁，与全局保存反馈分离）
    const [permMsg, setPermMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    useEffect(() => {
      let alive = true;
      // 成品聚合的 main 条目已带合并后的全局字段（用户手写值优先）
      fetch('/dsh-pet-7340/config')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive || !d || !d.main) return;
          const m = d.main as Record<string, unknown>;
          if (typeof m.notificationsEnabled === 'boolean') setNotifyEnabled(m.notificationsEnabled);
          if (typeof m.whisperImageEnabled === 'boolean') setWhisperImage(m.whisperImageEnabled);
          if (typeof m.chatImageEnabled === 'boolean') setChatImage(m.chatImageEnabled);
          if (typeof m.confineToScreen === 'boolean') setConfineScreen(m.confineToScreen);
        })
        .catch(() => {
          /* 成品拉取失败时保持默认（通知开、配图关） */
        });
      return () => {
        alive = false;
      };
    }, []);

    const toggleNotify = async (v: boolean) => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 开启时先借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）
        if (v) await requestNotificationPermission();
        // 与保存同构：整包写用户级配置（pets + 全部全局开关），避免开关写入被 sanitize 拒绝
        // 携带配图开关的当前 UI 值：整包写入下漏传即等于把它们重置掉
        const res = await fetch('/dsh-pet-7340/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pets: pets,
            notificationsEnabled: v,
            whisperImageEnabled: whisperImage,
            chatImageEnabled: chatImage,
            confineToScreen: confineScreen,
          }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // host 的 PUT 响应体就是保存后的成品聚合：直接交给容器拍平（无第二份字段填充，也不再拉一次）
        petBridge.reload((await res.json()) as Record<string, Record<string, unknown>>);
        setNotifyEnabled(v);
        void reloadNotifications(); // 引擎重读开关：即时生效，无需刷新页面
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const grantNotifyPermission = async () => {
      setPermMsg({ kind: '', text: '' });
      const r = await requestNotificationPermission();
      if (!r.ok) {
        // 红字：失败理由 + 引导（unsupported 无引导，改环境才有意义）
        const reason =
          r.reason === 'unsupported'
            ? t('notifyDenyUnsupported')
            : r.reason === 'denied'
              ? t('notifyDenyBlocked')
              : r.reason === 'rejected'
                ? t('notifyDenyRejected')
                : t('notifyDenyError') + (r.message ? '：' + r.message : '');
        setPermMsg({ kind: 'err', text: reason + (r.reason === 'unsupported' ? '' : ' ' + t('notifyGuide')) });
        return;
      }
      try {
        // 成功即发一条测试通知验证链路（绕过聚焦门，直接确认）
        new Notification('测试通知', { body: '【dsh-pet】系统通知已就绪。', icon: NOTIFY_ICONS.test });
      } catch {
        /* 个别环境构造失败：仍按已授权提示 */
      }
      setPermMsg({ kind: 'ok', text: t('notifyPermissionOk') });
    };

    // 当前选中的宠物对象（表单数据源）；selId 由 add/remove/sync 同步维护，列表非空时恒有效
    const cur = pets.find((p) => p.id === selId) ?? null;

    // 更新选中的宠物：size 走顶层；position 子字段整体替换
    const updateSel = (patch: Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> }) =>
      setPets((list) =>
        list.map((p) => {
          if (p.id !== selId) return p;
          const { position: posPatch, ...rest } = patch;
          return { ...p, ...rest, position: posPatch ? { ...p.position, ...posPatch } : p.position };
        }),
      );

    const validated = (): boolean => {
      for (const p of pets) {
        if (
          !Number.isFinite(p.size) ||
          p.size <= 0 ||
          !Number.isFinite(p.position.marginX) ||
          !Number.isFinite(p.position.marginY)
        ) {
          setMsg({ kind: 'err', text: t('invalid') });
          return false;
        }
      }
      return true;
    };

    // force 只认严格 true：**绝不能**写成 `force ? ...`——保存按钮现在是包一层再调 save，
    // 但历史上是把这个 handler 直接交给 React 的 onClick，于是 React 把 MouseEvent 当第一个
    // 实参传进来 → 真值 → 每次都拼上 ?force=1 → 宿主的损坏预检被绕过 →
    // 静默白名单重建、字段全丢、永不弹窗（真实事故，已由源码守卫钉住）。
    const save = async (force = false) => {
      const isOk = validated();
      if (!isOk) return;
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 通知总开关随保存一起写：UI 状态初始来自成品 main 条目（即保留用户手写值，不会静默覆盖）
        const body: Record<string, unknown> = {
          pets: pets,
          notificationsEnabled: notifyEnabled,
          whisperImageEnabled: whisperImage,
          chatImageEnabled: chatImage,
          confineToScreen: confineScreen,
        };
        // force === true（用户在损坏弹窗里点了确认）：带 ?force=1 才允许按白名单重建损坏文件
        const res = await fetch('/dsh-pet-7340/config' + (force === true ? '?force=1' : ''), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        // 409 = 宿主损坏预检拦下（用户配置解析不了，白名单重建会把文件里剩下的内容整份丢掉）：
        // 这里**不写盘**，弹窗让用户决定（取消 = 不动文件 / 确认 = 强行重建）
        if (res.status === 409) {
          // 路径取宿主回的真实写入路径（meta 拉取失败时也不至于空着）
          const info = (await res.json().catch(() => null)) as { userFile?: unknown } | null;
          setDialog({
            kind: 'corrupt',
            path: typeof info?.userFile === 'string' ? info.userFile : (paths?.user ?? ''),
          });
          return;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // 同上：PUT 响应即成品聚合，容器据此重新拍平（新增/删除宠物、改大小位置都走这条路）
        petBridge.reload((await res.json()) as Record<string, Record<string, unknown>>);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const sync = () => setDialog({ kind: 'sync' });

    const doSync = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 同步用户层：POST 把内置默认配置（原文，含注释）整份写入用户配置，响应体同样是成品聚合
        // （此时 main 条目 = 内置默认宠物列表），与保存走同一条路——不再"改完再拉一次"，
        // 也就没有中间失败态
        const res = await fetch('/dsh-pet-7340/config', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const merged = (await res.json()) as Record<string, Record<string, unknown>>;
        const defs = (merged.main?.pets ?? []) as Pet[];
        setPets(defs.map((p) => ({ ...p, position: { ...p.position } })));
        setSelId(defs[0]?.id ?? '');
        // 同一份成品交给容器拍平：编辑列表（裸实例）与渲染列表（含条目级字段）都由成品派生
        petBridge.reload(merged);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const addPet = () => {
      const tpl = petBridge.template;
      if (!tpl) return;
      const id = nextId(pets);
      setPets((list) => [
        ...list,
        {
          id,
          // 新宠物默认名字 = 自己的新 id（与「缺失 name 按 id 处理」同一语义，避免继承模板名字造成同名）
          name: id,
          size: tpl.size,
          balanceEnabled: tpl.balanceEnabled,
          whisperEnabled: tpl.whisperEnabled,
          workStatusEnabled: tpl.workStatusEnabled,
          display: tpl.display,
          position: { ...tpl.position },
        },
      ]);
      setSelId(id);
    };

    const removeSel = () => {
      if (pets.length <= 1) {
        setMsg({ kind: 'err', text: t('atLeastOne') });
        return;
      }
      setDialog({ kind: 'remove' });
    };

    const doRemove = () => {
      const list = pets.filter((p) => p.id !== selId);
      setPets(list);
      setSelId(list[0].id);
    };

    const field = (key: 'size' | 'marginX' | 'marginY', value: number, setter: (v: number) => void, width: string) =>
      h('input', {
        type: 'number',
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
        style: { width, ...inputStyle },
      });

    return h('section', {
      style: {
        maxWidth: '720px',
        color: 'var(--dsw-alias-label-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      children: [
        h('h2', {
          style: { margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '24px' },
          children: t('nav'),
        }),
        h('p', {
          style: {
            margin: 0,
            fontSize: '14px',
            color: 'var(--dsw-alias-label-tertiary)',
            lineHeight: '22px',
          },
          children: t('intro'),
        }),
        // 额外宠物提示（文件定义，不在此编辑列表）
        extraCount > 0
          ? h('p', {
              style: {
                margin: 0,
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary)',
                lineHeight: '18px',
              },
              children: t('extraPetsHint').replace('{n}', String(extraCount)),
            })
          : null,

        // 宠物列表 + 添加
        h('div', {
          style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' },
          children: [
            h('span', {
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              children: t('petsLabel'),
            }),
            ...pets.map((p) =>
              h('button', {
                key: p.id,
                type: 'button',
                onClick: () => setSelId(p.id),
                style: {
                  border:
                    '1px solid ' +
                    (p.id === selId ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
                  background: p.id === selId ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  borderRadius: '8px',
                  padding: '4px 12px',
                  fontSize: '13px',
                  cursor: 'pointer',
                },
                children: (p.name || p.id) + ' (' + p.size + 'px)',
              }),
            ),
            h('button', {
              type: 'button',
              onClick: addPet,
              disabled: busy,
              style: {
                border: '1px dashed var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                borderRadius: '8px',
                padding: '4px 12px',
                fontSize: '13px',
                cursor: 'pointer',
              },
              children: '+ ' + t('add'),
            }),
          ],
        }),

        // 选中宠物表单
        cur
          ? h('div', {
              style: {
                display: 'flex',
                gap: '16px',
                flexWrap: 'wrap',
                marginTop: '8px',
                padding: '12px 14px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
              },
              children: [
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('nameLabel'),
                    h('input', {
                      type: 'text',
                      value: String(cur.name ?? ''),
                      disabled: busy,
                      maxLength: 50,
                      onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ name: e.target.value }),
                      style: { width: '200px', ...inputStyle },
                    }),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('nameHint'),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('sizeLabel'),
                    field('size', cur.size, (v) => updateSel({ size: v }), '150px'),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('sizeHint'),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('cornerLabel'),
                    h('select', {
                      value: cur.position.corner,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                        updateSel({ position: { corner: e.target.value as Corner } }),
                      style: { width: '160px', ...inputStyle },
                      children: CORNERS.map((c) =>
                        h('option', {
                          key: c,
                          value: c,
                          children: cornerLabel(c),
                        }),
                      ),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('marginX'),
                    field('marginX', cur.position.marginX, (v) => updateSel({ position: { marginX: v } }), '120px'),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('marginY'),
                    field('marginY', cur.position.marginY, (v) => updateSel({ position: { marginY: v } }), '120px'),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('balanceEnabled'),
                    h('input', {
                      type: 'checkbox',
                      checked: !!cur.balanceEnabled,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ balanceEnabled: e.target.checked }),
                      style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
                    }),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('balanceEnabledHint'),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('whisperEnabled'),
                    h('input', {
                      type: 'checkbox',
                      checked: !!cur.whisperEnabled,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ whisperEnabled: e.target.checked }),
                      style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
                    }),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('whisperEnabledHint'),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('workStatusEnabled'),
                    h('input', {
                      type: 'checkbox',
                      checked: !!cur.workStatusEnabled,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLInputElement>) =>
                        updateSel({ workStatusEnabled: e.target.checked }),
                      style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
                    }),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('workStatusEnabledHint'),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('displayLabel'),
                    h('select', {
                      value: cur.display,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                        updateSel({ display: e.target.value as PetDisplay }),
                      style: { width: '160px', ...inputStyle },
                      children: PET_DISPLAYS.map((d) =>
                        h('option', {
                          key: d,
                          value: d,
                          children: t('display.' + d),
                        }),
                      ),
                    }),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('displayHint'),
                    }),
                  ],
                }),
                h('button', {
                  type: 'button',
                  onClick: removeSel,
                  disabled: busy,
                  title: t('remove'),
                  style: {
                    alignSelf: 'flex-end',
                    border: '1px solid var(--dsw-alias-state-error-secondary)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-state-error-primary)',
                    borderRadius: '8px',
                    padding: '4px 12px',
                    fontSize: '12px',
                    cursor: 'pointer',
                  },
                  children: t('remove'),
                }),
              ],
            })
          : h('p', {
              style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
              children: t('emptyPets'),
            }),

        // 四个全局开关：2×2 网格，每格「勾选框 + 标题」在上、描述在下。
        // 系统通知即时生效（改完立刻重读引擎）；其余三个随「保存」写入用户级配置——不即时写入，不改变正在进行的渲染。
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px 16px',
            marginTop: '8px',
            alignItems: 'start',
          },
          children: [
            toggleCell('notifyToggle', notifyEnabled, busy, (v) => void toggleNotify(v)),
            toggleCell('whisperImageToggle', whisperImage, busy, setWhisperImage),
            toggleCell('chatImageToggle', chatImage, busy, setChatImage),
            toggleCell('confineToggle', confineScreen, busy, setConfineScreen),
          ],
        }),

        // 权限获取按钮 + 反馈（独立一行，样式对齐设置页现有按钮）
        h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
          children: [
            h('button', {
              type: 'button',
              onClick: () => void grantNotifyPermission(),
              style: {
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
              },
              children: t('notifyGetPermission'),
            }),
            permMsg.text
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      permMsg.kind === 'err'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-state-ok-primary)',
                    lineHeight: '18px',
                  },
                  children: permMsg.text,
                })
              : null,
          ],
        }),

        // 操作区
        h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
          children: [
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => void save(),
              style: {
                border: '1px solid var(--dsw-alias-button-info-fill)',
                background: 'var(--dsw-alias-button-info-fill)',
                color: '#fff',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
                opacity: busy ? 0.5 : 1,
              },
              children: t('save'),
            }),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: sync,
              style: {
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
                opacity: busy ? 0.5 : 1,
              },
              children: t('sync'),
            }),
            msg.text
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      msg.kind === 'err' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-ok-primary)',
                    marginLeft: '4px',
                  },
                  children: msg.text,
                })
              : null,
          ],
        }),

        // 同步的副作用提示（POST 会用内置默认整份覆盖用户配置，含高级自定义）
        h('p', {
          style: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '16px' },
          children: t('syncHint'),
        }),

        // 高级配置（文件地址）：供高级用户直接编辑配置文件自定义
        paths
          ? h('div', {
              style: {
                marginTop: '12px',
                padding: '10px 14px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-secondary)',
              },
              children: [
                h('div', {
                  style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
                  children: t('configMeta'),
                }),
                h('div', { style: { fontSize: '12px', lineHeight: '20px' }, children: t('configMetaHint') }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('defaultConfig') + '：' + paths.default,
                }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('userConfig') + '：' + paths.user,
                }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('animationDir') + '：' + paths.animations,
                }),
              ],
            })
          : null,

        // 卸载与存储：先列出插件落盘的全部位置（路径在前、作用在后），再给出卸载方法
        paths && paths.storage && paths.storage.length > 0
          ? h('div', {
              style: {
                marginTop: '12px',
                padding: '10px 14px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-secondary)',
              },
              children: [
                h('div', {
                  style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
                  children: t('storageTitle'),
                }),
                h('div', { style: { fontSize: '12px', lineHeight: '20px' }, children: t('storageHint') }),
                // 存储位置清单：每条都是「路径（等宽、可选中复制）→ 作用」
                ...paths.storage.map((s) =>
                  h('div', {
                    key: s.key,
                    style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all', userSelect: 'text' },
                    children: [
                      h('span', {
                        style: { color: 'var(--dsw-alias-label-primary)', fontFamily: MONO },
                        children: s.path,
                      }),
                      // 尚未产生的目录（如从未启用桌面模式的 Electron）标一下，避免用户去找不存在的文件夹
                      h('span', {
                        children: ' — ' + t('storage.' + s.key) + (s.exists === false ? t('storageMissing') : ''),
                      }),
                    ],
                  }),
                ),
                h('div', {
                  style: {
                    marginTop: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-primary)',
                    fontWeight: 500,
                  },
                  children: t('uninstallTitle'),
                }),
                h('div', { style: { fontSize: '12px', lineHeight: '20px' }, children: t('uninstallStep1') }),
                h('div', { style: { fontSize: '12px', lineHeight: '20px' }, children: t('uninstallStep2') }),
                h('div', {
                  style: {
                    fontFamily: MONO,
                    fontSize: '12px',
                    lineHeight: '18px',
                    wordBreak: 'break-all',
                    userSelect: 'text',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-interactive-bg-active)',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                  children: t('uninstallCmd').replace('{profile}', paths.profile || '<profile>'),
                }),
                h('div', { style: { fontSize: '12px', lineHeight: '20px' }, children: t('uninstallStep3') }),
              ],
            })
          : null,

        // 确认/提示弹窗（仿官方弹窗视觉：遮罩 + 居中卡片 + 双按钮）
        dialog
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483647,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              onClick: () => setDialog(null),
              children: h('div', {
                style: {
                  width: '340px',
                  maxWidth: 'calc(100vw - 40px)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '12px',
                  padding: '16px 18px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                },
                onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
                children: [
                  h('div', {
                    style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                    children: dialog.kind === 'corrupt' ? t('corruptTitle') : t('confirmTitle'),
                  }),
                  h('div', {
                    style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                    children:
                      dialog.kind === 'remove'
                        ? t('confirmRemove').replace('{id}', selId)
                        : dialog.kind === 'corrupt'
                          ? t('corruptBody').replace('{path}', dialog.path)
                          : t('confirmSync'),
                  }),
                  h('div', {
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
                    children: [
                      h('button', {
                        type: 'button',
                        onClick: () => setDialog(null),
                        style: {
                          border: '1px solid var(--dsw-alias-border-l2)',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-primary)',
                          borderRadius: '8px',
                          padding: '4px 14px',
                          fontSize: '12px',
                          cursor: 'pointer',
                        },
                        children: t('cancel'),
                      }),
                      h('button', {
                        type: 'button',
                        onClick: () => {
                          const d = dialog;
                          setDialog(null);
                          if (d.kind === 'remove') doRemove();
                          else if (d.kind === 'corrupt')
                            void save(true); // 确认：带 ?force=1 强行重建
                          else void doSync();
                        },
                        style:
                          dialog.kind === 'sync'
                            ? {
                                border: '1px solid var(--dsw-alias-button-info-fill)',
                                background: 'var(--dsw-alias-button-info-fill)',
                                color: '#fff',
                                borderRadius: '8px',
                                padding: '4px 14px',
                                fontSize: '12px',
                                cursor: 'pointer',
                              }
                            : {
                                border: '1px solid var(--dsw-alias-state-error-secondary)',
                                background: 'transparent',
                                color: 'var(--dsw-alias-state-error-primary)',
                                borderRadius: '8px',
                                padding: '4px 14px',
                                fontSize: '12px',
                                cursor: 'pointer',
                              },
                        children:
                          dialog.kind === 'remove'
                            ? t('remove')
                            : dialog.kind === 'corrupt'
                              ? t('corruptConfirm')
                              : t('sync'),
                      }),
                    ],
                  }),
                ],
              }),
            })
          : null,
      ],
    });
  };
}
