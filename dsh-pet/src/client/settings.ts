/**
 * 「桌宠配置」设置页（`settings.section` 插槽，id 为 pet-config）：编辑 main 条目的宠物列表与全局默认值。
 * 本文件是装配根：持有表单状态、串起加载与写盘、把卡片拼成一页；卡片、字典、样式与 HTTP 都在 `settings/` 里。
 * 只读成品配置里可编辑的 main 条目，不自行拼条目级字段；文件宠物永不回写。
 * 保存与同步都全量写用户层，再把宿主返回的成品交给容器重渲染——两条路都无需刷新页面。
 * @module dsh-pet/src/client/settings
 */
import { ROUTE_PATH } from '../shared/constants.ts';
import { DEFAULT_FONT } from '../shared/fonts.ts';
import { DEFAULT_PHYSICS } from '../shared/physics.ts';
import type { FontConfig, ModelSelection, PhysicsParams } from '../shared/types.ts';
import type { FunctionComponent } from 'react';
import { requestNotificationPermission } from './notify.ts';
import { injectSettingsCss } from './settings/css.ts';
import { type Feedback, makeActions } from './settings/actions.ts';
import { petBridge } from './settings/bridge.ts';
import { type MergedConfig, readConfigEntries, readMainConfig } from './settings/config/index.ts';
import { type DialogState, makeDialog } from './settings/dialog.ts';
import { makeFontCard } from './settings/font-card.ts';
import { makeGlobalCard, type GlobalFlagKey, type GlobalFlags } from './settings/global-card.ts';
import { makeLoadStatus } from './settings/load-status.ts';
import { makeModelCard, type ChatFlagKey, type ChatFlagValues, type ModelFieldKey } from './settings/model-card.ts';
import { makeMobileCard } from './settings/mobile-card.ts';
import { makeModelPicker } from './settings/picker/index.ts';
import { makeVoicePicker } from './settings/picker/voice-picker.ts';
import { runNotificationTest } from './settings/notify-test.ts';
import { makeKindTabs } from './settings/kind-tabs.ts';
import { makePathsCards } from './settings/paths-cards.ts';
import { makePetCard } from './settings/pet-card.ts';
import { makePetTabs } from './settings/pet-tabs.ts';
import { createWriteFlow } from './settings/config/index.ts';
import { makePhysicsCard } from './settings/physics-card.ts';
import { makeShortcutsCard } from './settings/shortcuts-card.ts';
import { attachTipLayer } from './settings/tip-layer.ts';
import type { SettingsRuntime } from './settings/runtime.ts';
import { useConfigLoad } from './settings/config/index.ts';
import { usePetList } from './settings/use-pet-list.ts';
import { useRemoteData } from './settings/use-remote-data.ts';
import { makeUiKit } from './settings/ui.ts';
import { makeVoiceCard, type VoiceOption } from './settings/voice-card.ts';

// 字典与桥的真源都在 settings/ 里：宿主的 locale 注册、容器与测试夹具都经这里取，不各自深路径引用。
export { dicts, NS } from './settings/locales/index.ts';
export type { Key } from './settings/locales/index.ts';
export { petBridge };

/**
 * 制造「桌宠配置」设置页组件。
 * 浏览器半侧是 `__ModuleLoader__` 单文件形态，react 能力只能由宿主在运行时注入，
 * 因此以工厂接收依赖，造出组件后再注册进设置页插槽。
 * @param rt - 运行时注入的依赖：`h`、hooks 与翻译函数 `t`。
 * @returns 设置页组件；`close` 由设置页外壳提供，本页未使用。
 */
export function makePetConfigSection(rt: SettingsRuntime): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, useRef, useCallback, t } = rt;

  // 样式注入幂等，重复渲染不会重复插入。
  injectSettingsCss();

  const { q } = makeUiKit({ h, t });

  // 卡片在 settings/ 里各自成文件，这里只造一次实例：组件类型必须跨渲染稳定，
  // 否则选择器的浮层状态（打开 / 搜索词 / 高亮）每次渲染都会丢。
  const ModelPicker = makeModelPicker({ h, useState, useEffect, useRef, t });
  const VoicePicker = makeVoicePicker({ h, useState, useEffect, useRef });
  const PetTabs = makePetTabs({ h, t });
  const KindTabs = makeKindTabs({ h, t });
  const PetCard = makePetCard(rt);
  const GlobalCard = makeGlobalCard(rt);
  const VoiceCard = makeVoiceCard(rt, VoicePicker);
  const FontCard = makeFontCard(rt);
  const ModelCard = makeModelCard(rt, ModelPicker);
  const PhysicsCard = makePhysicsCard(rt);
  const ShortcutsCard = makeShortcutsCard(rt);
  const MobileCard = makeMobileCard(rt);
  const Actions = makeActions(rt);
  const { ConfigMetaCard, StorageCard } = makePathsCards(rt);
  const SettingsDialog = makeDialog(rt);
  const LoadStatus = makeLoadStatus({ h, t });

  return function PetConfigSection() {
    const [saving, setBusy] = useState(false);
    const [msg, setMsg] = useState<Feedback>({ kind: '', text: '' });
    // 权限申请的反馈，就地显示在按钮旁，与保存反馈分离。
    const [permMsg, setPermMsg] = useState<Feedback>({ kind: '', text: '' });
    // 设置页根节点：Ctrl+S 只在它可见时接管（DSH 若在别的设置页保持本组件挂载，不能把别人的快捷键抢走）
    const rootRef = useRef<HTMLElement | null>(null);
    // 确认 / 提示弹窗：remove 删除宠物、lastOne 只剩一只删不了、sync 同步覆盖、corrupt 用户配置已损坏。
    const [dialog, setDialog] = useState<DialogState>(null);
    // 宠物列表的增删改与选中项都在 settings/use-pet-list.ts：列表覆盖全部条目（main + 文件宠物）。
    const {
      pets,
      mainPets,
      kinds,
      kind,
      visiblePets,
      selId,
      entryPrompt,
      select,
      selectKind,
      update,
      add,
      requestRemove,
      remove,
      replace,
      packWrites,
    } = usePetList(rt, setDialog);
    // 一次性拉取的宿主数据：落盘位置（两张路径卡）与候选模型清单（下拉框）。
    const { paths, catalog, catalogFailed } = useRemoteData(rt);

    // 说明气泡：挂 body 摆位（伪元素会被窗口边缘与滚动容器裁掉），随页面卸载一起拆。
    useEffect(() => attachTipLayer(), []);

    // 音色列表：与配置无关的一次性拉取，失败留空即可（下拉会只显示当前值）。
    useEffect(() => {
      let alive = true;
      void fetch(ROUTE_PATH + '/voice/voices')
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { voices?: VoiceOption[] } | null) => {
          if (alive && body && Array.isArray(body.voices)) setVoiceOptions(body.voices);
        })
        .catch(() => undefined);
      return () => {
        alive = false;
      };
    }, []);

    // 系统通知总开关：与其余全局开关同构，切换只改本地状态、随「保存」整包写入。
    // 不做即时写入：PUT /config 会重启桌面 Helper，全部桌面宠物窗口重建（拖拽落点清空、宠物跳回角落）。
    // 引擎重读放在保存成功后（persist 里调 reloadNotifications），保存后即时生效、无需刷新。
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 点击音效开关：同通知开关，随「保存」整包写入；初值 true 是内置默认，加载效应会用成品值覆盖。
    const [clickSound, setClickSound] = useState(true);
    // 表情包配图开关（全局）：切换只改本地状态，随「保存」一起提交。
    const [whisperImage, setWhisperImage] = useState(false);
    const [chatImage, setChatImage] = useState(false);
    // 对话动作联动开关（全局）：同上，随「保存」一起提交；初值仅占位，加载成功后由成品值覆盖。
    const [chatAnimation, setChatAnimation] = useState(true);
    // 抛掷锁定开关（全局）：切换只改本地状态，随「保存」一起提交。
    const [confineScreen, setConfineScreen] = useState(false);
    // 系统托盘开关（全局）：随「保存」一起提交；宿主半侧据此决定建不建托盘、没桌面宠物时还值不值得常驻 Helper。
    const [trayEnabled, setTrayEnabled] = useState(true);
    // 语音播报开关与音色（全局默认）：随「保存」整包写入；初值即内置默认，加载后用成品值覆盖。
    const [voiceEnabled, setVoiceEnabled] = useState(false);
    const [voiceName, setVoiceName] = useState('zh-CN-XiaoyiNeural');
    // 语音的两个细分开关（周期碎碎念 / 待办提醒）：与总开关同一套语义，初值 false 是内置默认。
    const [voiceWhisperEnabled, setVoiceWhisperEnabled] = useState(false);
    const [voiceTodoEnabled, setVoiceTodoEnabled] = useState(false);
    // 可选音色：来自宿主 /voice/voices，拉不到就留空——下拉只显示当前值，绝不硬编码音色 id。
    const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
    // 物理参数（全局）：只改本地状态，随「保存」整包写入；初值仅占位，成品加载成功后才允许编辑与保存。
    const [physics, setPhysics] = useState<PhysicsParams>({ ...DEFAULT_PHYSICS });
    // 字体（全局默认）：与 physics 同一套语义；初值仅占位，成品加载成功后才允许编辑与保存。
    const [font, setFont] = useState<FontConfig>({ ...DEFAULT_FONT });
    // AI 模型（条目级）：碎碎念 / 对话各自的服务商与模型，两者都留空 = 跟随当前对话；随「保存」整包写入。
    const [whisperModel, setWhisperModel] = useState<ModelSelection>({ provider: '', model: '' });
    const [chatModel, setChatModel] = useState<ModelSelection>({ provider: '', model: '' });
    // 对话历史条数（全局默认）：初值 5 是内置默认，加载效应会用成品 main.chatMemoryRounds 覆盖。
    const [chatMemory, setChatMemory] = useState(5);
    // 对话配图张数上限（全局默认）：初值 10 是内置默认（砍掉整张清单约 2/3 开销），加载后由成品值覆盖。
    const [chatImageLimit, setChatImageLimit] = useState(10);

    // 首次读取与恢复默认必须更新同一组控件，避免下一次保存回写过期值。
    const applyConfig = useCallback(
      (merged: MergedConfig) => {
        // 条目列表与全局字段各取一份：前者给标签条与保存时的写回计划，后者给全局卡片。
        const entries = readConfigEntries(merged);
        const patch = readMainConfig(merged);
        if (entries === null || patch === null) throw new Error('Invalid config response');
        replace(entries);
        if (patch.notificationsEnabled !== undefined) setNotifyEnabled(patch.notificationsEnabled);
        if (patch.clickSoundEnabled !== undefined) setClickSound(patch.clickSoundEnabled);
        if (patch.whisperImageEnabled !== undefined) setWhisperImage(patch.whisperImageEnabled);
        if (patch.chatImageEnabled !== undefined) setChatImage(patch.chatImageEnabled);
        if (patch.chatAnimationEnabled !== undefined) setChatAnimation(patch.chatAnimationEnabled);
        if (patch.confineToScreen !== undefined) setConfineScreen(patch.confineToScreen);
        if (patch.trayEnabled !== undefined) setTrayEnabled(patch.trayEnabled);
        if (patch.voiceEnabled !== undefined) setVoiceEnabled(patch.voiceEnabled);
        if (patch.voiceName !== undefined) setVoiceName(patch.voiceName);
        if (patch.voiceWhisperEnabled !== undefined) setVoiceWhisperEnabled(patch.voiceWhisperEnabled);
        if (patch.voiceTodoEnabled !== undefined) setVoiceTodoEnabled(patch.voiceTodoEnabled);
        if (patch.physics !== undefined) setPhysics(patch.physics);
        if (patch.font !== undefined) setFont(patch.font);
        if (patch.whisperModel !== undefined) setWhisperModel(patch.whisperModel);
        if (patch.chatModel !== undefined) setChatModel(patch.chatModel);
        if (patch.chatMemoryRounds !== undefined) setChatMemory(patch.chatMemoryRounds);
        if (patch.chatImageLimit !== undefined) setChatImageLimit(patch.chatImageLimit);
      },
      [replace],
    );

    // 配置没就绪（加载中 / 失败）时整页只读，避免在占位值上编辑再保存回去。
    const { loadState, retry } = useConfigLoad(rt, applyConfig);
    const busy = saving || loadState !== 'ready';

    // 切换系统通知：只改本地状态（开启时顺带借这次用户手势申请权限），配置在点「保存」时整包写入。
    const toggleNotify = async (v: boolean) => {
      setNotifyEnabled(v);
      // 开启时借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）。
      if (v) await requestNotificationPermission();
    };

    // 「测试弹窗」：先拿权限再发一条测试通知，理由与引导就地显示。
    const testNotification = () => void runNotificationTest({ t, report: setPermMsg });

    // 当前选中的宠物对象（表单数据源）；selId 由 add/remove/sync 同步维护，列表非空时恒有效
    const cur = pets.find((p) => p.id === selId) ?? null;
    // 文件宠物条目数：只用于标题提示「另 n 只来自 pet/ 目录」。
    const packCount = kinds.filter((item) => item.kind === 'pack').length;

    // 七个顶层开关的当前值：卡片各认自己那几项，键名与成品配置字段同名。
    const globalFlags: GlobalFlags = {
      notificationsEnabled: notifyEnabled,
      clickSoundEnabled: clickSound,
      confineToScreen: confineScreen,
      trayEnabled,
    };
    const chatFlags: ChatFlagValues = {
      whisperImageEnabled: whisperImage,
      chatImageEnabled: chatImage,
      chatAnimationEnabled: chatAnimation,
    };

    // 通知开关要借用户手势申请权限，其余六个是纯 setState；统一成「键名 → setter」的查表，避免长 switch。
    // 两束开关共用这张表：键名到 setter 的映射只写一遍，卡片只管回传键名。
    const flagSetters: Record<GlobalFlagKey | ChatFlagKey, (value: boolean) => void> = {
      notificationsEnabled: (value) => void toggleNotify(value),
      clickSoundEnabled: setClickSound,
      confineToScreen: setConfineScreen,
      trayEnabled: setTrayEnabled,
      whisperImageEnabled: setWhisperImage,
      chatImageEnabled: setChatImage,
      chatAnimationEnabled: setChatAnimation,
    };
    const setGlobalFlag = (key: GlobalFlagKey, value: boolean): void => flagSetters[key](value);
    const setChatFlag = (key: ChatFlagKey, value: boolean): void => flagSetters[key](value);

    /** 局部补丁写入：字体与物理参数都是「整段对象 + 改几个字段」。 */
    const patchFont = (patch: Partial<FontConfig>): void => setFont((current) => ({ ...current, ...patch }));
    const patchPhysics = (patch: Partial<PhysicsParams>): void => setPhysics((current) => ({ ...current, ...patch }));

    /** 两个模型字段各有一份状态，卡片只回传键名。 */
    const setModel = (key: ModelFieldKey, value: ModelSelection): void => {
      if (key === 'whisperModel') setWhisperModel(value);
      else setChatModel(value);
    };

    // 写路径在 settings/write-flow.ts：保存、请求同步与「确认」派发都走同一条校验与落盘。
    // 传的是回调而不是值——save 每次渲染重建，捕获状态会拿旧值存盘。
    const write = createWriteFlow({
      fields: () => ({
        // PUT /config 只写用户主配置：只能提交 main 层实例，pack 实例走 POST /pet-config。
        pets: mainPets,
        notificationsEnabled: notifyEnabled,
        clickSoundEnabled: clickSound,
        whisperImageEnabled: whisperImage,
        chatImageEnabled: chatImage,
        chatAnimationEnabled: chatAnimation,
        confineToScreen: confineScreen,
        trayEnabled,
        voiceEnabled,
        voiceName,
        voiceWhisperEnabled,
        voiceTodoEnabled,
        physics,
        whisperModel,
        chatModel,
        chatMemoryRounds: chatMemory,
        chatImageLimit,
        font,
      }),
      busy: () => busy,
      setBusy,
      setMsg,
      setDialog,
      dialog: () => dialog,
      applyConfig,
      packWrites,
      userFile: () => paths?.user ?? '',
      t,
      onRemove: remove,
    });

    // 快捷键必须用最新的 save：save 每次渲染都重建（闭包捕获 pets / physics 等状态），
    // 直接塞进 useEffect([]) 会拿旧状态存盘；这里每次渲染转发一次。
    const saveRef = useRef<() => void>(() => {});
    useEffect(() => {
      saveRef.current = () => void write.save();
    });

    // Ctrl+S / Cmd+S 保存：页面很长，改完不必滚到底部找按钮。
    // 只在本设置页可见时接管，且只在真要保存时 preventDefault，否则会拦掉浏览器的「保存网页」。
    useEffect(() => {
      const onKey = (e: KeyboardEvent): void => {
        if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
        if (e.key.toLowerCase() !== 's') return;
        const root = rootRef.current;
        if (!root || !root.isConnected || root.getClientRects().length === 0) return;
        e.preventDefault();
        saveRef.current();
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, []);

    // 卡片顺序即阅读顺序：先编辑宠物，再改全局默认，最后是落盘位置与弹窗。
    return h('section', {
      ref: rootRef,
      className: 'dsh-pet-cfg',
      style: { maxWidth: '720px' },
      children: [
        // 标题：intro 与「额外宠物」说明都收进问号。
        h('h2', {
          className: 'dsh-pet-cfg__title',
          children: [
            t('nav'),
            q(packCount > 0 ? t('intro') + '\n' + t('extraPetsHint').replace('{n}', String(packCount)) : t('intro')),
          ],
        }),

        h(LoadStatus, { loadState, onRetry: retry }),

        h(KindTabs, { kinds, kind, busy, onSelect: selectKind }),
        h(PetTabs, { pets: visiblePets, selId, busy, onSelect: select, onAdd: add }),
        h(PetCard, {
          pet: cur,
          busy,
          msg,
          entryPrompt,
          onChange: update,
          onSave: () => void write.save(),
          onRemove: requestRemove,
        }),
        h(GlobalCard, { busy, values: globalFlags, onChange: setGlobalFlag }),
        h(VoiceCard, {
          busy,
          enabled: voiceEnabled,
          voiceName,
          voices: voiceOptions,
          whisperEnabled: voiceWhisperEnabled,
          todoEnabled: voiceTodoEnabled,
          onToggle: setVoiceEnabled,
          onVoiceChange: setVoiceName,
          onWhisperToggle: setVoiceWhisperEnabled,
          onTodoToggle: setVoiceTodoEnabled,
        }),
        h(FontCard, { busy, font, onChange: patchFont }),
        h(ModelCard, {
          busy,
          catalog,
          failed: catalogFailed,
          whisperModel,
          chatModel,
          onModelChange: setModel,
          chatMemory,
          chatImageLimit,
          onChatMemoryChange: setChatMemory,
          onChatImageLimitChange: setChatImageLimit,
          values: chatFlags,
          onFlagChange: setChatFlag,
        }),
        h(PhysicsCard, { busy, physics, onChange: patchPhysics }),
        h(MobileCard, { busy, physics, onChange: patchPhysics }),
        h(Actions, {
          busy,
          msg,
          permMsg,
          onSave: () => void write.save(),
          onSync: write.requestSync,
          onTestNotification: testNotification,
        }),

        // 保存按钮以下是参考类卡片：只读说明，改不改都不用点保存。
        h(ShortcutsCard, {}),

        // 落盘位置两张卡都靠 meta，读不到就整块不出现。
        paths ? h(ConfigMetaCard, { paths }) : null,
        paths ? h(StorageCard, { paths }) : null,

        dialog
          ? h(SettingsDialog, { dialog, selId, onDismiss: () => setDialog(null), onConfirm: write.confirmDialog })
          : null,
      ],
    });
  };
}
