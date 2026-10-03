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
import { DEFAULT_PHYSICS } from '../shared/physics';
import { NOTIFY_ICONS, reloadNotifications, requestNotificationPermission } from './notify';
import type { Corner, ModelSelection, Pet, PetDisplay, PhysicsParams } from '../shared/types';
import type { ChangeEvent, Dispatch, FunctionComponent, SetStateAction } from 'react';
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

/** 一处「服务商 + 模型」是否合法：**要么都留空（= 跟随当前对话）要么都非空**。
 *  与宿主 config.ts 的 modelSelectionValid 同一套规则（非法宿主回 400，这里先就地给红字提示）。 */
const modelPairValid = (m: ModelSelection): boolean => (m.provider.trim() === '') === (m.model.trim() === '');

/** 候选清单里的一组：一个服务商 + 它名下的模型（GET /models 的响应形态） */
interface ModelCatalogGroup {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

/**
 * 设置页内联 CSS（只服务「AI 模型」单下拉选择器）。
 *
 * 为什么要有 CSS 而不是全用行内 style：hover / focus-visible / 箭头旋转这些**伪类与过渡**
 * 行内样式表达不了，而这个选择器是照 DSH 对话框右下角的模型选择器做的——触发器要有 hover、
 * 浮层要有阴影与滚动，只能落到样式表。注入方式与宠物页面同一套（data-plugin-css 去重，
 * 官方插件标准做法）。
 *
 * 类名统一 dsh-pet-mp__ 前缀（mp = model picker），不会撞到 DSH 自己的类名。
 */
const SETTINGS_CSS = [
  // 触发器：与设置页其它控件同款描边，右侧箭头表示可展开
  '.dsh-pet-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.dsh-pet-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:340px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}',
  '.dsh-pet-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
  '.dsh-pet-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
  '.dsh-pet-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}',
  '.dsh-pet-mp__chevron.is-open{transform:rotate(180deg)}',
  // 浮层：position:fixed（与 DSH 一致——脱离设置页的滚动容器，不被 overflow 裁掉）
  // 浮层：position:fixed（与 DSH 一致——脱离设置页的滚动容器，不被 overflow 裁掉）；
  // z-index 取与插件右键菜单同一档（2147483000），保证压得住 DSH 自己的层叠上下文
  '.dsh-pet-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
  '.dsh-pet-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__list{display:flex;flex-direction:column;min-height:0;overflow-y:auto;scrollbar-width:thin}',
  '.dsh-pet-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-pet-mp__item:hover:not(:disabled),.dsh-pet-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-mp__item[aria-checked="true"]{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__check{flex:none;margin-left:auto}',
  '.dsh-pet-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

  // ===================== 设置页骨架（重构后） =====================
  // 这一段只放「伪类 / 悬浮 / 栅格」这类行内样式表达不了的东西；其余排版仍走组件里的行内 style。
  // 类名统一 dsh-pet-cfg__ 前缀，不会撞 DSH 自己的类名。

  // 页面根容器与标题
  '.dsh-pet-cfg{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.dsh-pet-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}',

  // 卡片：宠物配置 / 全局开关 / AI 模型 / 物理 / 高级配置 / 卸载与存储 统一用这一个框
  '.dsh-pet-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
  '.dsh-pet-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}',
  '.dsh-pet-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',

  // 栅格：列数固定 → 行与行的控件自然对齐成一列
  '.dsh-pet-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',

  // 字段：标签（+ 问号）在上、控件在下
  '.dsh-pet-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-pet-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',

  // 输入 / 下拉
  '.dsh-pet-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
  '.dsh-pet-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',

  // 开关（勾选框 + 标题 + 问号）
  '.dsh-pet-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
  '.dsh-pet-cfg__toggle>label>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-pet-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',

  // 问号 + 悬浮说明：解释小字全部收进这里（data-tip → ::after）
  '.dsh-pet-cfg__q{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',
  // 气泡默认**左对齐**到问号（left:-4px），而不是居中。
  // 为什么不能居中：问号常常贴着卡片左缘（卡片头、栅格第一列、页标题），居中会让气泡
  // 往左伸出一大截，被设置页的滚动容器（overflow 会连带裁掉横向）切掉——看起来就是
  // 「气泡左边被左边框遮住」。左对齐则一律向右展开，左侧永不出界。
  '.dsh-pet-cfg__q::after{content:attr(data-tip);position:absolute;left:-4px;bottom:calc(100% + 8px);width:max-content;max-width:260px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:#fff;font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:2147483000}',
  '.dsh-pet-cfg__q:hover::after{opacity:1;visibility:visible}',
  // 最右一列：改为右对齐，避免气泡顶出设置页右缘
  '.dsh-pet-cfg__q.is-end::after{left:auto;right:-4px}',

  // 按钮
  '.dsh-pet-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
  // 实心主按钮**必须排除**在通用 hover 之外：interactive-bg-hover 是半透明白（#ffffff14），
  // 直接顶掉 button-info-fill 会让蓝色保存按钮一悬停就变成一块发白的透明块，非常突兀。
  // 实心按钮的 hover 走主题自己的 button-info-hover（更深的蓝）。
  '.dsh-pet-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
  '.dsh-pet-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dsh-pet-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__btn.is-sm{padding:2px 10px}',
  '.dsh-pet-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  // 宠物列表 tab
  '.dsh-pet-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dsh-pet-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}',
  '.dsh-pet-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__tab:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-pet-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  // 操作区 / 提示文字 / 路径
  '.dsh-pet-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
  '.dsh-pet-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
  '.dsh-pet-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}',
  '.dsh-pet-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
].join('\n');

const settingsCssTag = 'dsh-pet/settings.css';
/** 注入设置页 CSS（只注入一次；与宠物页面 injectCss 同一套 data-plugin-css 去重） */
function injectSettingsCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + settingsCssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = settingsCssTag;
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
}

/** 选择器浮层里的一行：跟随当前对话 / 服务商分组头 / 模型 / 该服务商没有可用模型 */
type ModelRow =
  | { kind: 'follow'; key: string }
  | { kind: 'group'; key: string; name: string }
  | { kind: 'none'; key: string }
  | { kind: 'model'; key: string; provider: string; model: { id: string; name: string } };

export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。',
  // 卡片标题 + 卡片级说明（说明都进问号，不再占一行小字）
  petCardTitle: '宠物配置',
  petCardHint:
    '每只宠物独立配置：名字 / 大小 / 显示位置 / 位置 / 偏移 / 四个功能开关。改完点最下面的「保存」即时生效。',
  globalTitle: '全局开关',
  globalHint:
    '所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。这几个开关只改本地状态，随「保存」整包写入用户配置（不做即时写入）；系统通知在保存后即时重读，无需刷新页面。',
  cornerHint: '宠物贴着屏幕的哪个角（桌面端按各自显示器的工作区算）。',
  marginXHint: '距所选角落的水平距离（px），可为任意数字。',
  marginYHint: '距所选角落的垂直距离（px），可为任意数字。',
  // 「/」命令菜单里的行标题（图标由 app.ts 经 command-faces.ts 补上）
  'cmd.chat': '对话',
  'cmd.pet': '桌宠',
  'cmd.balance': '余额',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  confirmRemove: '确定删除宠物「{id}」吗？',
  confirmTitle: '确认操作',
  cancel: '取消',
  ok: '知道了',
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
  fixedEnabled: '宠物固定',
  fixedEnabledHint:
    '启用后随机动画不再让宠物自己转向或走开，只播原地待机与随机小动作；右键菜单点播、接口触发、余额/碎碎念/工作状态动画不受影响。',
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
  memesDir: '表情包目录（可自定义/扩充配图）',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
  extraPetsHint:
    '另 {n} 只额外宠物由 pet/ 目录文件定义（<名>-config.json + <名>-animation/ + <名>-memes/），它们不在此列表——改文件后浏览器刷新页面、桌面端右键「重载配置」即可生效。',
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
  physicsTitle: '物理（拖拽抛掷手感）',
  physicsHint:
    '全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置（不做即时写入）。浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。',
  'physics.gravity': '重力 gravity',
  'physics.gravityHint': 'px/s²，越大落得越快；0 = 无重力（抛出去匀速直线飞）',
  'physics.restitution': '弹性 restitution',
  'physics.restitutionHint': '0~1，碰壁 / 落地反弹保留的速度比例（1 = 完全弹性，0 = 撞上即停）',
  'physics.groundFriction': '地面摩擦 groundFriction',
  'physics.groundFrictionHint': '/s，落地后水平速度的衰减率；0 = 冰面不减速',
  'physics.throwPower': '总力度 throwPower',
  'physics.throwPowerHint': '> 0，弹簧跟手与甩出初速的整体倍率（1 = 默认；越大越跟手、甩得越猛）',
  physicsCeilingBounce: '顶部反弹 ceilingBounce',
  physicsCeilingBounceHint: '关掉后抛掷可飞出屏幕顶部（重力仍会把它拉回来）',
  physicsPetCollision: '宠物互撞 petCollision',
  physicsPetCollisionHint: '飞行中的宠物撞到别的宠物按动量守恒弹开（质量 ∝ 尺寸²）',
  invalidPhysics: '请检查物理参数：重力 / 地面摩擦 ≥ 0，弹性 0~1，总力度 > 0。',
  modelTitle: 'AI 模型与对话上下文',
  modelHint:
    '碎碎念与对话各自用哪个模型，以及对话每次带多少历史进上下文。选「跟随当前对话」= 用你当前对话正在用的那个模型（默认）。全局默认：对所有宠物生效，pet pack 可在自己种类文件里单独覆盖。选项与 DSH 的模型选择器同源，由宿主实时提供。',
  modelFollow: '跟随当前对话',
  modelSearch: '搜索模型…',
  modelEmpty: '没有匹配的模型。',
  modelNoModels: '没有可用的模型。',
  modelLoading: '正在刷新模型列表…',
  modelTriggerAria: '选择模型，当前 {model}',
  modelUnknown: '（当前配置，不在列表中）',
  modelNone: '该服务商没有可用模型',
  whisperModelLabel: '碎碎念模型',
  chatModelLabel: '对话模型',
  modelFieldHint: '选「跟随当前对话」= 用当前对话的模型；指定了但调用失败会自动回落到当前对话的模型重试一次。',
  invalidModel: '请检查模型设置：服务商与模型要么都选，要么都留空（跟随当前对话）。',
  modelCatalogFailed: '模型列表加载失败（刷新页面可重试）；当前配置值仍会原样保留。',
  chatMemory: '对话历史条数',
  chatMemoryHint:
    '每次对话请求携带的最近历史轮数（1 轮 = 1 问 1 答；0 = 不带历史，每句都是全新对话）。对话记忆本身全存不删，此值只决定截多少进上下文——越大越记得住，也越费 token。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。',
  invalidChatMemory: '请检查对话历史条数：需为 ≥ 0 的数字。',
  chatImageLimit: '对话配图张数上限',
  chatImageLimitHint:
    '对话时发给模型的表情包清单最多几张（「前 N 张」= 配置里写在前面的那 N 条，想让哪几张优先被发出去就把顺序往前挪）。整张清单是每条消息都要附的，token 随张数线性增长——张数一多就是纯烧钱，限制成前 N 张，模型只从这几张里挑。0 = 不限制（全部发）。内置默认 10。全局默认，所有宠物共用（pet pack 可在自己种类文件里覆盖）。只影响对话选图：碎碎念只带抽中的那一张。',
  invalidChatImageLimit: '请检查对话配图张数上限：需为 ≥ 0 的数字（0 = 不限制）。',
  notifyTest: '测试弹窗',
  notifyTestOk: '测试通知已发送，请查看桌面右下角。',
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
  // Card titles + card-level help (all hints move into the "?" bubble)
  petCardTitle: 'Pet',
  petCardHint:
    'Per-pet settings: name / size / display / corner / offsets / the four feature switches. Click "Save" at the bottom to apply instantly.',
  globalTitle: 'Global switches',
  globalHint:
    'Shared by every pet (a pet pack may override them in its own kind file). These switches only change local state and are written to the user config on "Save" (never written immediately); system notifications re-read right after saving, no page refresh needed.',
  cornerHint: 'Which screen corner the pet sticks to (per-monitor work area in desktop mode).',
  marginXHint: 'Horizontal distance from the chosen corner (px); any number.',
  marginYHint: 'Vertical distance from the chosen corner (px); any number.',
  // Row titles in the "/" command menu (icons are added by app.ts)
  'cmd.chat': 'Chat',
  'cmd.pet': 'Pet',
  'cmd.balance': 'Balance',
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
  memesDir: 'Meme images dir (add/customize images here)',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  extraPetsHint:
    '{n} extra pet(s) are file-defined in the pet/ directory (<name>-config.json + <name>-animation/ + <name>-memes/). They are not in this list — after editing the files, refresh the page (browser) or right-click a desktop pet → "Reload config".',
  notifyToggle: 'System notifications',
  notifyToggleHint:
    'OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.',
  whisperImageToggle: 'Whisper images',
  whisperImageToggleHint:
    'Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.',
  chatImageToggle: 'Chat images',
  chatImageToggleHint:
    'Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.',
  confineToggle: 'Lock throws to the current screen',
  confineToggleHint:
    'Multi-monitor: a thrown pet bounces only inside the screen it was released on (screen seams act as walls, so it never flies to the neighbouring monitor); turn this off to let it cross screens as usual. Desktop only — the browser overlay always bounces inside the viewport anyway.',
  physicsTitle: 'Physics (drag & throw feel)',
  physicsHint:
    'Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on "Save" (never written immediately). Applies instantly in the browser; on the desktop it applies once Save reloads the pet windows.',
  'physics.gravity': 'Gravity',
  'physics.gravityHint': 'px/s² — the higher, the faster it falls; 0 = weightless (flies straight forever)',
  'physics.restitution': 'Bounciness',
  'physics.restitutionHint':
    '0–1, speed kept when bouncing off a wall or the floor (1 = perfectly elastic, 0 = stops dead)',
  'physics.groundFriction': 'Ground friction',
  'physics.groundFrictionHint': 'per second, horizontal damping while on the ground; 0 = frictionless ice',
  'physics.throwPower': 'Throw power',
  'physics.throwPowerHint':
    '> 0, overall multiplier for spring tracking and release speed (1 = default; higher = tighter tracking, harder throws)',
  physicsCeilingBounce: 'Ceiling bounce',
  physicsCeilingBounceHint:
    'Turn this off to let a throw fly out through the top of the screen (gravity still pulls it back)',
  physicsPetCollision: 'Pet collisions',
  physicsPetCollisionHint: 'A flying pet bounces off the others with momentum conservation (mass ∝ size²)',
  invalidPhysics: 'Check the physics values: gravity / ground friction ≥ 0, bounciness 0–1, throw power > 0.',
  modelTitle: 'AI models & chat context',
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
 * @param rt.useRef react 的 useRef hook——「AI 模型」单下拉选择器用它拿触发器/浮层节点
 *                  （浮层定位与"点外面关闭"判定），与宠物页面同一份注入
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
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  t: (key: string) => string;
}): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, useRef, t } = rt;

  // 设置页样式（只有模型选择器用得上：hover/焦点环/箭头旋转这些伪类行内样式表达不了）
  injectSettingsCss();

  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  const inputClass = 'dsh-pet-cfg__inp';

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

  /**
   * 问号 + 悬浮说明（本页所有解释小字的唯一去处）。
   *
   * 为什么用 `<i>` 而不是 `<button>`：它只是说明入口，点了不该有任何行为，也不该被
   * Tab 当成操作项；真正的可交互入口是它旁边的输入框 / 开关。说明文字走 `data-tip`
   * 属性，由 SETTINGS_CSS 的 `::after{content:attr(data-tip)}` 画成气泡——CSS 才能
   * 表达 hover / 过渡，行内样式做不到。
   *
   * @param tip 说明正文（已翻译）
   * @param end 是否右对齐气泡（给栅格最右一列用，免得气泡顶出设置页）
   */
  const q = (tip: string, end = false): ReturnType<typeof h> =>
    h('i', {
      className: 'dsh-pet-cfg__q' + (end ? ' is-end' : ''),
      'data-tip': tip,
      'aria-label': tip,
      role: 'img',
      children: '?',
    });

  /** 卡片头：标题 + 问号说明（+ 可选右侧动作，由调用方自行 append） */
  const cardHead = (title: string, tip?: string, end = false): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__cardHead',
      children: [
        h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: title }),
        tip ? q(tip, end) : null,
      ],
    });

  /** 一个字段：标签（+ 问号）在上、控件在下 */
  const field = (label: string, control: ReturnType<typeof h>, tip?: string, end = false): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__field',
      children: [
        h('span', {
          key: 'l',
          className: 'dsh-pet-cfg__flabel',
          children: tip ? [label, q(tip, end)] : label,
        }),
        control,
      ],
    });

  /**
   * 开关的一格：勾选框 + 标题 + 问号。
   * label 为文案键：标题 = t(label)，说明 = t(label + 'Hint')（说明进问号，不再占一行小字）。
   * 说明挂在问号上而不是整格——点标题只切开关，看说明去点问号，两个动作不再抢同一次点击。
   */
  const toggleCell = (
    label: string,
    value: boolean,
    disabled: boolean,
    onToggle: (v: boolean) => void,
    end = false,
  ): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__toggle',
      children: [
        h('label', {
          key: 'l',
          children: [
            h('input', {
              key: 'i',
              type: 'checkbox',
              checked: value,
              disabled,
              onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
            }),
            h('span', { key: 't', children: t(label) }),
          ],
        }),
        q(t(label + 'Hint'), end),
      ],
    });

  /**
   * 「模型」单下拉选择器（碎碎念 / 对话各一个实例）——照 DSH 对话框右下角的模型选择器写：
   * 一个触发器按钮（当前模型 + 服务商小字 + 箭头）→ 点开一个浮层：搜索框 + 按服务商分组的
   * 模型清单（选中项打勾），最上面一项是「跟随当前对话」。
   *
   * 与 DSH 那份的对应关系：
   *  - 触发器 aria-haspopup/aria-expanded、浮层 role=menu、分组头 + role=menuitemradio[aria-checked]、
   *    搜索 role=searchbox —— 无障碍语义一致；
   *  - 浮层 position:fixed（脱离设置页滚动容器，不被 overflow 裁掉）+ 外部点击 / Esc 关闭 + 滚动跟随；
   *  - 搜索是**大小写不敏感的有序子序列**匹配（DSH 同款：输入 dsc 能命中 DeepSeek Chat）；
   *  - 数据来自 GET /models（宿主 llm 服务），与 DSH 模型选择器同一份来源。
   *
   * 为什么不用两个 <select>：DSH 自己就是"一个按钮 → 一个浮层里的分组清单"，两个下拉框既占地方，
   * 又容易留下"选了服务商没选模型"的非法组合。这里也**不再提供**"手填模型 id"的退路：
   * 列不出模型的服务商本来也没法调用，列出来只会诱人踩坑。
   *
   * 定义在工厂作用域（而非 PetConfigSection 内）：组件类型必须跨渲染稳定，否则每次渲染都会
   * 重新挂载，浮层状态（打开/搜索词/高亮）会当场丢失。
   */
  const ModelPicker: FunctionComponent<{
    label: string;
    value: ModelSelection;
    disabled: boolean;
    catalog: ModelCatalogGroup[] | null;
    failed: boolean;
    onChange: (v: ModelSelection) => void;
  }> = (props) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // 高亮行（键盘 ↑↓ 走的就是它；只停在可选项上）
    const [active, setActive] = useState(0);
    // 浮层位置：打开时按触发器实测一次，空间不够就翻到上方（DSH 也是实测 + 视口钳制）
    const [pos, setPos] = useState<null | {
      left: number;
      top?: number;
      bottom?: number;
      width: number;
      maxHeight: number;
    }>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);

    const groups = props.catalog ?? [];
    const group = groups.find((g) => g.id === props.value.provider);
    const picked = group?.models.find((m) => m.id === props.value.model);
    const isFollow = props.value.provider === '';
    const triggerLabel = isFollow ? t('modelFollow') : (picked?.name ?? props.value.model);
    // 当前配置不在清单里（服务商下线 / 模型下架）时如实标注，绝不显示成别的模型
    const triggerSub = isFollow ? '' : (group?.name ?? props.value.provider + t('modelUnknown'));

    // 搜索：大小写不敏感的有序子序列（与 DSH 同款语义）
    const q = query.trim().toLowerCase();
    const hit = (text: string): boolean => {
      if (q === '') return true;
      let i = 0;
      for (const ch of text.toLowerCase()) {
        if (ch === q[i]) i += 1;
        if (i >= q.length) return true;
      }
      return false;
    };
    // 行清单：跟随当前对话（只在没搜索词时出现，它不是模型）+ 服务商分组头 + 该组命中的模型
    const rows: ModelRow[] = [];
    if (q === '') rows.push({ kind: 'follow', key: '__follow' });
    for (const g of groups) {
      const models = g.models.filter((m) => hit(m.name + ' ' + m.id));
      if (models.length === 0 && !(q === '' && g.models.length === 0)) continue;
      rows.push({ kind: 'group', key: g.id, name: g.name });
      if (models.length === 0) {
        rows.push({ kind: 'none', key: g.id + '/__none' });
        continue;
      }
      for (const m of models) rows.push({ kind: 'model', key: g.id + '/' + m.id, provider: g.id, model: m });
    }
    // 可选项（分组头 / 提示行不参与键盘走动）
    const selectable = rows.map((r, i) => (r.kind === 'group' || r.kind === 'none' ? -1 : i)).filter((i) => i >= 0);

    const commit = (v: ModelSelection): void => {
      props.onChange(v);
      setOpen(false);
      setQuery('');
    };
    const pick = (row: ModelRow | undefined): void => {
      if (!row) return;
      if (row.kind === 'follow') commit({ provider: '', model: '' });
      else if (row.kind === 'model') commit({ provider: row.provider, model: row.model.id });
    };
    const step = (dir: number): void => {
      if (selectable.length === 0) return;
      const at = selectable.indexOf(active);
      const next = selectable[at < 0 ? 0 : (at + dir + selectable.length) % selectable.length];
      setActive(next);
      panelRef.current?.querySelector('[data-row="' + next + '"]')?.scrollIntoView({ block: 'nearest' });
    };

    useEffect(() => {
      if (!open) return;
      const el = rootRef.current;
      // 定位 + 关闭时机：与 DSH 一致——浮层脱离文档流实测定位，滚动/缩放跟着走，点外面或 Esc 关
      const place = (): void => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const below = window.innerHeight - r.bottom - 12;
        const above = r.top - 12;
        const width = Math.min(Math.max(r.width, 240), Math.max(200, Math.min(420, window.innerWidth - 16)));
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        const up = below < 240 && above > below;
        setPos(
          up
            ? { left, bottom: window.innerHeight - r.top + 4, width, maxHeight: Math.min(360, above) }
            : { left, top: r.bottom + 4, width, maxHeight: Math.min(360, below) },
        );
      };
      place();
      // 打开即聚焦搜索框（DSH 同样把焦点交给搜索）
      panelRef.current?.querySelector('input')?.focus();
      const onDown = (e: MouseEvent): void => {
        const target = e.target as Node | null;
        if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) {
          return;
        }
        setOpen(false);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      };
    }, [open]);

    const toggle = (): void => {
      if (props.disabled) return;
      if (!open) {
        setQuery('');
        // 打开时高亮停在当前选择上（DSH 打开菜单也是先定位到已选项）
        const at = rows.findIndex(
          (r) => r.kind === 'model' && r.provider === props.value.provider && r.model.id === props.value.model,
        );
        setActive(at >= 0 ? at : 0);
      }
      setOpen(!open);
    };

    const searchRow = h('input', {
      key: 'search',
      type: 'text',
      className: 'dsh-pet-mp__search',
      role: 'searchbox',
      placeholder: t('modelSearch'),
      'aria-label': t('modelSearch'),
      value: query,
      disabled: props.disabled,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        setQuery(e.target.value);
        setActive(selectable.length > 0 ? selectable[0] : 0);
      },
      onKeyDown: (e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(-1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          pick(rows[active]);
        }
      },
    });

    const rowNode = (row: ModelRow, index: number): ReturnType<typeof h> => {
      if (row.kind === 'group') {
        return h('div', { key: row.key, className: 'dsh-pet-mp__group', children: row.name });
      }
      if (row.kind === 'none') {
        return h('div', { key: row.key, className: 'dsh-pet-mp__status', children: t('modelNone') });
      }
      const checked =
        row.kind === 'follow' ? isFollow : props.value.provider === row.provider && props.value.model === row.model.id;
      return h('button', {
        key: row.key,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': checked,
        'data-row': index,
        className: 'dsh-pet-mp__item' + (index === active ? ' is-active' : ''),
        disabled: props.disabled,
        onClick: () => pick(row),
        onMouseMove: () => setActive(index),
        children: [
          h('span', {
            key: 'n',
            className: 'dsh-pet-mp__name',
            children: row.kind === 'follow' ? t('modelFollow') : row.model.name,
          }),
          h('span', { key: 'c', className: 'dsh-pet-mp__check', children: checked ? '✓' : '' }),
        ],
      });
    };

    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-mp',
      children: [
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dsh-pet-mp__trigger',
          disabled: props.disabled,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': t('modelTriggerAria').replace('{model}', triggerLabel),
          onClick: toggle,
          children: [
            h('span', { key: 'l', className: 'dsh-pet-mp__label', children: triggerLabel }),
            triggerSub ? h('span', { key: 's', className: 'dsh-pet-mp__sub', children: triggerSub }) : null,
            h('span', { key: 'c', className: 'dsh-pet-mp__chevron' + (open ? ' is-open' : ''), children: '▾' }),
          ],
        }),
        open && pos
          ? h('div', {
              key: 'panel',
              ref: panelRef,
              className: 'dsh-pet-mp__panel',
              role: 'menu',
              'aria-label': props.label,
              style: {
                left: pos.left + 'px',
                top: pos.top === undefined ? undefined : pos.top + 'px',
                bottom: pos.bottom === undefined ? undefined : pos.bottom + 'px',
                width: pos.width + 'px',
                maxHeight: pos.maxHeight + 'px',
              },
              children: [
                searchRow,
                props.catalog === null
                  ? h('div', {
                      key: 'loading',
                      className: 'dsh-pet-mp__status',
                      children: props.failed ? t('modelCatalogFailed') : t('modelLoading'),
                    })
                  : rows.length === 0
                    ? h('div', {
                        key: 'empty',
                        className: 'dsh-pet-mp__status',
                        role: 'status',
                        children: groups.length === 0 ? t('modelNoModels') : t('modelEmpty'),
                      })
                    : h('div', {
                        key: 'list',
                        className: 'dsh-pet-mp__list',
                        role: 'group',
                        children: rows.map(rowNode),
                      }),
              ],
            })
          : null,
      ],
    });
  };

  return function PetConfigSection() {
    const initPets = petBridge.current.filter((p) => !p.extra);
    // 文件定义宠物数量（pet/ 目录，不在本编辑列表；仅展示提示）
    const extraCount = petBridge.current.filter((p) => p.extra).length;
    const [pets, setPets] = useState<Pet[]>(initPets.map((p) => ({ ...p, position: { ...p.position } })));
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 确认/提示弹窗（仿官方弹窗：遮罩 + 居中卡片 + 按钮）：
    //   remove  —— 删除宠物（双按钮：取消 / 删除）
    //   lastOne —— 只剩一只、删不了：同样走弹窗（单按钮「知道了」）。
    //              以前这里是在按钮旁闪一行红字——位置在页面中段、颜色又淡，很容易被忽略，
    //              用户只看到「点了删除没反应」。
    //   sync    —— 同步（说明会用内置默认整份覆盖）
    //   corrupt —— 保存时发现用户配置**已损坏**（解析不了）：取消 = 不动文件，确认 = 强行白名单重建
    const [dialog, setDialog] = useState<
      null | { kind: 'remove' } | { kind: 'lastOne' } | { kind: 'sync' } | { kind: 'corrupt'; path: string }
    >(null);
    // 配置文件地址与存储位置清单（「高级配置」「卸载与存储」区块；读取失败仅缺省不显示，不影响表单）
    const [paths, setPaths] = useState<null | {
      user: string;
      default: string;
      animations: string;
      /** 用户表情包目录（$DSH_HOME/dsh-pet/memes：加图不必改包） */
      memes?: string;
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

    // 系统通知总开关（全局：写用户级配置 main-config.jsonc 的 notificationsEnabled）。
    // 与其余三个全局开关**完全同构**：切换只改本地 UI 状态，随「保存」一起整包写入。
    // 为什么不做即时写入：PUT /config 会触发宿主重启桌面 Helper（全部桌面宠物窗口重建——
    // 拖拽落点清空、宠物跳回配置角落），于是"改个通知开关，桌面被重置"，与其它开关行为不一致。
    // 引擎重读放在 save() 成功之后（reloadNotifications）：保存后即时生效，无需刷新页面。
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 表情包配图开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [whisperImage, setWhisperImage] = useState(false);
    const [chatImage, setChatImage] = useState(false);
    // 抛掷锁定开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [confineScreen, setConfineScreen] = useState(false);
    // 物理参数（全局：拖拽抛掷手感，写用户级配置 main-config.jsonc 的 physics 段）。
    // 与四个开关同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    // 初值 = 成品 main.physics（用户层优先、缺省回落内置默认），拉取失败时用内置默认兜底。
    const [physics, setPhysics] = useState<PhysicsParams>({ ...DEFAULT_PHYSICS });
    // AI 模型（条目级：碎碎念 / 对话各自的服务商 + 模型，两者都留空 = 跟随当前对话的模型）。
    // 与四个全局开关同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    const [whisperModel, setWhisperModel] = useState<ModelSelection>({ provider: '', model: '' });
    const [chatModel, setChatModel] = useState<ModelSelection>({ provider: '', model: '' });
    // 对话历史条数（全局默认：每次对话请求带多少历史进上下文，写用户级配置的 chatMemoryRounds）。
    // 与两个模型 / 四个开关同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    // 初值 5 = 内置默认（assets/config.jsonc）；下面的加载效应会用成品 main.chatMemoryRounds 覆盖。
    const [chatMemory, setChatMemory] = useState(5);
    // 对话配图张数上限（全局默认：对话时发给模型的表情包清单最多几张，写用户级配置的 chatImageLimit）。
    // 同上：只改本地状态，随「保存」整包写入。初值 10 = 内置默认（砍掉整张清单的约 2/3 开销）；
    // 加载效应会用成品 main.chatImageLimit 覆盖。
    const [chatImageLimit, setChatImageLimit] = useState(10);
    // 候选清单（GET /models：宿主 llm 服务的实时服务商 + 各自模型，与 DSH 的模型选择器同源）。
    // null = 还没拉到（下拉框只剩「跟随当前对话」）；拉失败置 catalogErr 显示一行提示。
    const [catalog, setCatalog] = useState<ModelCatalogGroup[] | null>(null);
    const [catalogErr, setCatalogErr] = useState(false);
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
          // physics 段：成品已按「内置默认 ← 用户层」整段填满，直接取用（缺子键再用默认兜底一次）
          if (m.physics && typeof m.physics === 'object') {
            setPhysics({ ...DEFAULT_PHYSICS, ...(m.physics as PhysicsParams) });
          }
          // 模型选择：成品同样已填满（内置默认 = 两者都空 = 跟随当前对话），读得出就原样上屏
          const wm = m.whisperModel as Partial<ModelSelection> | undefined;
          if (wm && typeof wm.provider === 'string' && typeof wm.model === 'string') {
            setWhisperModel({ provider: wm.provider, model: wm.model });
          }
          const cm = m.chatModel as Partial<ModelSelection> | undefined;
          if (cm && typeof cm.provider === 'string' && typeof cm.model === 'string') {
            setChatModel({ provider: cm.provider, model: cm.model });
          }
          // 对话历史条数：成品同样已填满（内置默认 5 ← 用户层），合法就原样上屏
          const cmr = Number(m.chatMemoryRounds);
          if (Number.isFinite(cmr) && cmr >= 0) setChatMemory(cmr);
          // 对话配图张数上限：同上（内置默认 0 = 不限制）
          const cil = Number(m.chatImageLimit);
          if (Number.isFinite(cil) && cil >= 0) setChatImageLimit(cil);
        })
        .catch(() => {
          /* 成品拉取失败时保持默认（通知开、配图关） */
        });
      return () => {
        alive = false;
      };
    }, []);

    // 候选模型清单：一次性拉取（下拉框数据源）。失败只提示、不阻塞——已有配置值照常显示与保存。
    useEffect(() => {
      let alive = true;
      fetch('/dsh-pet-7340/models')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((d) => {
          if (!alive) return;
          if (d && Array.isArray(d.providers)) setCatalog(d.providers as ModelCatalogGroup[]);
          else setCatalogErr(true);
        })
        .catch(() => {
          if (alive) setCatalogErr(true);
        });
      return () => {
        alive = false;
      };
    }, []);

    // 切换系统通知：与配图/抛掷锁定开关同构——只改本地状态（开启时顺带借这次用户手势申请权限），
    // 配置在点「保存」时整包写入；保存成功后由 save() 调 reloadNotifications() 让引擎即时重读。
    const toggleNotify = async (v: boolean) => {
      setNotifyEnabled(v);
      // 开启时借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）
      if (v) await requestNotificationPermission();
    };

    /**
     * 「测试弹窗」按钮：发一条测试系统通知，验证整条链路通不通。
     *
     * 顺带承担申请权限的职责——没授权时先申请（借这次用户手势，无手势的自动申请可能被浏览器
     * 静默压制），授权成功再发测试通知。所以这一个按钮同时是「拿权限」和「验链路」的入口，
     * 不需要再单独摆一个「获取权限」按钮。
     */
    const testNotification = async () => {
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
      setPermMsg({ kind: 'ok', text: t('notifyTestOk') });
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
      // 物理参数：与宿主 physicsValid 同一套规则（非法宿主会回 400，这里先就地给红字提示）
      if (
        !Number.isFinite(physics.gravity) ||
        physics.gravity < 0 ||
        !Number.isFinite(physics.restitution) ||
        physics.restitution < 0 ||
        physics.restitution > 1 ||
        !Number.isFinite(physics.groundFriction) ||
        physics.groundFriction < 0 ||
        !Number.isFinite(physics.throwPower) ||
        physics.throwPower <= 0
      ) {
        setMsg({ kind: 'err', text: t('invalidPhysics') });
        return false;
      }
      // 模型选择：与宿主 modelSelectionValid 同一套规则——只填一半（选了服务商没选模型，或反之）非法
      if (!modelPairValid(whisperModel) || !modelPairValid(chatModel)) {
        setMsg({ kind: 'err', text: t('invalidModel') });
        return false;
      }
      // 对话历史条数：与宿主 topFieldValid 同一套规则（有限且 ≥ 0）
      if (!Number.isFinite(chatMemory) || chatMemory < 0) {
        setMsg({ kind: 'err', text: t('invalidChatMemory') });
        return false;
      }
      // 对话配图张数上限：同上（0 = 不限制，合法）
      if (!Number.isFinite(chatImageLimit) || chatImageLimit < 0) {
        setMsg({ kind: 'err', text: t('invalidChatImageLimit') });
        return false;
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
          // 物理参数整段提交（白名单字段，未传即走宿主透传保留）：宿主用 physicsValid 整段校验
          physics: physics,
          // 碎碎念 / 对话的模型（条目级白名单字段，同上）：宿主用 modelSelectionValid 整段校验，
          // 两者都空 = 跟随当前对话的模型
          whisperModel: whisperModel,
          chatModel: chatModel,
          // 对话历史条数（全局默认白名单字段）：宿主用 topFieldValid 校验（有限且 ≥ 0）
          chatMemoryRounds: chatMemory,
          // 对话配图张数上限（同上；0 = 不限制）
          chatImageLimit: chatImageLimit,
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
        void reloadNotifications(); // 通知引擎重读开关：保存后即时生效，无需刷新页面
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
          fixedEnabled: tpl.fixedEnabled,
          display: tpl.display,
          position: { ...tpl.position },
        },
      ]);
      setSelId(id);
    };

    const removeSel = () => {
      // 两种情形都走弹窗：能删 → 确认删除；只剩一只 → 说明删不了。
      // 不再把「至少保留一个宠物」塞进按钮旁的消息行（那里离删除按钮很远，等于没提示）。
      setDialog({ kind: pets.length <= 1 ? 'lastOne' : 'remove' });
    };

    const doRemove = () => {
      const list = pets.filter((p) => p.id !== selId);
      setPets(list);
      setSelId(list[0].id);
    };

    /** 宠物数值输入（大小 / 水平偏移 / 垂直偏移）——宽度交给栅格，不再各自写死 */
    const numInput = (
      key: 'size' | 'marginX' | 'marginY',
      value: number,
      setter: (v: number) => void,
    ): ReturnType<typeof h> =>
      h('input', {
        type: 'number',
        className: inputClass,
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
      });

    /** 物理参数的一格：标签 + 问号在上、数字输入在下（说明进问号） */
    const physField = (
      key: 'gravity' | 'restitution' | 'groundFriction' | 'throwPower',
      step: string,
      min: string,
      end = false,
    ): ReturnType<typeof h> =>
      field(
        t('physics.' + key),
        h('input', {
          type: 'number',
          className: inputClass,
          step,
          min,
          value: String(physics[key]),
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) =>
            setPhysics((p) => ({ ...p, [key]: Number(e.target.value) }) as PhysicsParams),
        }),
        t('physics.' + key + 'Hint'),
        end,
      );

    /** 「全局默认」的一个数字格：标签 + 问号在上、数字输入在下（说明 = t(label + 'Hint') 进问号） */
    const globalNumField = (label: string, value: number, setter: (v: number) => void): ReturnType<typeof h> =>
      field(
        t(label),
        h('input', {
          type: 'number',
          className: inputClass,
          step: '1',
          min: '0',
          value: String(value),
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
        }),
        t(label + 'Hint'),
      );

    /** 「AI 模型」的一格：标签 + 问号在上、单下拉选择器在下 */
    const modelCell = (
      key: 'whisperModel' | 'chatModel',
      value: ModelSelection,
      setter: (v: ModelSelection) => void,
      end = false,
    ): ReturnType<typeof h> => {
      const label = t(key === 'whisperModel' ? 'whisperModelLabel' : 'chatModelLabel');
      return field(
        label,
        h(ModelPicker, { label, value, disabled: busy, catalog, failed: catalogErr, onChange: setter }),
        t('modelFieldHint'),
        end,
      );
    };

    return h('section', {
      className: 'dsh-pet-cfg',
      style: { maxWidth: '720px' },
      children: [
        // 标题：intro 与「额外宠物」说明都收进问号，不再各占一行小字
        h('h2', {
          className: 'dsh-pet-cfg__title',
          children: [
            t('nav'),
            q(extraCount > 0 ? t('intro') + '\n' + t('extraPetsHint').replace('{n}', String(extraCount)) : t('intro')),
          ],
        }),

        // 宠物列表 + 添加
        h('div', {
          className: 'dsh-pet-cfg__tabs',
          children: [
            h('span', { key: 'label', className: 'dsh-pet-cfg__tabsLabel', children: t('petsLabel') }),
            ...pets.map((p) =>
              h('button', {
                key: p.id,
                type: 'button',
                onClick: () => setSelId(p.id),
                className: 'dsh-pet-cfg__tab' + (p.id === selId ? ' is-active' : ''),
                children: (p.name || p.id) + ' (' + p.size + 'px)',
              }),
            ),
            h('button', {
              key: 'add',
              type: 'button',
              onClick: addPet,
              disabled: busy,
              className: 'dsh-pet-cfg__tab is-ghost',
              children: '+ ' + t('add'),
            }),
          ],
        }),

        // 选中宠物配置卡：第 1 行 名字/大小/显示位置、第 2 行 位置/偏移、第 3 行 四个开关
        cur
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                h('div', {
                  className: 'dsh-pet-cfg__cardHead',
                  children: [
                    h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: t('petCardTitle') }),
                    q(t('petCardHint')),
                    h('button', {
                      key: 'rm',
                      type: 'button',
                      onClick: removeSel,
                      disabled: busy,
                      className: 'dsh-pet-cfg__btn is-danger is-sm',
                      style: { marginLeft: 'auto' },
                      children: t('remove'),
                    }),
                  ],
                }),

                h('div', {
                  className: 'dsh-pet-cfg__grid3',
                  children: [
                    field(
                      t('nameLabel'),
                      h('input', {
                        type: 'text',
                        className: inputClass,
                        value: String(cur.name ?? ''),
                        disabled: busy,
                        maxLength: 50,
                        onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ name: e.target.value }),
                      }),
                      t('nameHint'),
                    ),
                    field(
                      t('sizeLabel'),
                      numInput('size', cur.size, (v) => updateSel({ size: v })),
                      t('sizeHint'),
                    ),
                    field(
                      t('displayLabel'),
                      h('select', {
                        className: inputClass,
                        value: cur.display,
                        disabled: busy,
                        onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                          updateSel({ display: e.target.value as PetDisplay }),
                        children: PET_DISPLAYS.map((d) =>
                          h('option', {
                            key: d,
                            value: d,
                            children: t('display.' + d),
                          }),
                        ),
                      }),
                      t('displayHint'),
                      true,
                    ),
                  ],
                }),

                h('div', {
                  className: 'dsh-pet-cfg__grid3',
                  children: [
                    field(
                      t('cornerLabel'),
                      h('select', {
                        className: inputClass,
                        value: cur.position.corner,
                        disabled: busy,
                        onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                          updateSel({ position: { corner: e.target.value as Corner } }),
                        children: CORNERS.map((c) =>
                          h('option', {
                            key: c,
                            value: c,
                            children: cornerLabel(c),
                          }),
                        ),
                      }),
                      t('cornerHint'),
                    ),
                    field(
                      t('marginX'),
                      numInput('marginX', cur.position.marginX, (v) => updateSel({ position: { marginX: v } })),
                      t('marginXHint'),
                    ),
                    field(
                      t('marginY'),
                      numInput('marginY', cur.position.marginY, (v) => updateSel({ position: { marginY: v } })),
                      t('marginYHint'),
                      true,
                    ),
                  ],
                }),

                h('div', {
                  className: 'dsh-pet-cfg__grid4',
                  children: [
                    toggleCell('balanceEnabled', !!cur.balanceEnabled, busy, (v) => updateSel({ balanceEnabled: v })),
                    toggleCell('whisperEnabled', !!cur.whisperEnabled, busy, (v) => updateSel({ whisperEnabled: v })),
                    toggleCell('workStatusEnabled', !!cur.workStatusEnabled, busy, (v) =>
                      updateSel({ workStatusEnabled: v }),
                    ),
                    toggleCell('fixedEnabled', !!cur.fixedEnabled, busy, (v) => updateSel({ fixedEnabled: v }), true),
                  ],
                }),
              ],
            })
          : h('p', {
              className: 'dsh-pet-cfg__note',
              children: t('emptyPets'),
            }),

        // 全局开关卡（需求 4：四个开关一行）。
        // 四个开关行为**一致**：切换只改本地状态，随「保存」整包写入用户级配置——不做即时写入
        // （即时写盘会触发宿主重启桌面 Helper，把全部桌面宠物窗口重建一遍）。系统通知额外在保存后
        // 由 save() 调 reloadNotifications() 让通知引擎即时重读。
        // 「测试弹窗」按钮不在这里——它是个动作，跟「保存 / 同步」同一行（见下面的操作区）。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('globalTitle'), t('globalHint')),
            h('div', {
              className: 'dsh-pet-cfg__grid4',
              children: [
                toggleCell('notifyToggle', notifyEnabled, busy, (v) => void toggleNotify(v)),
                toggleCell('whisperImageToggle', whisperImage, busy, setWhisperImage),
                toggleCell('chatImageToggle', chatImage, busy, setChatImage),
                toggleCell('confineToggle', confineScreen, busy, setConfineScreen, true),
              ],
            }),
          ],
        }),

        // AI 模型与对话上下文卡（需求 5）：碎碎念 / 对话各自的服务商 + 模型，条目级——与四个开关
        // 同一套语义，只改本地状态、随「保存」整包写入。host 侧生成时优先用它，失败自动回落。
        // 第二行是对话历史条数（全局默认）：与两个模型同属「对话的上下文 / token 成本」，
        // 所以同卡而不是塞进「全局开关」（那里是布尔开关）。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('modelTitle'), t('modelHint')),
            catalogErr
              ? h('p', {
                  className: 'dsh-pet-cfg__note',
                  style: { color: 'var(--dsw-alias-state-error-primary)' },
                  children: t('modelCatalogFailed'),
                })
              : null,
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                modelCell('whisperModel', whisperModel, setWhisperModel),
                modelCell('chatModel', chatModel, setChatModel, true),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid4',
              children: [
                globalNumField('chatMemory', chatMemory, setChatMemory),
                globalNumField('chatImageLimit', chatImageLimit, setChatImageLimit),
              ],
            }),
          ],
        }),

        // 物理卡（需求 6）：四个数字输入一行 + 两个开关一行。
        // 与上面四个开关同一套语义（只改本地状态，随「保存」整包写入；不做即时写入）。
        // 浏览器保存后即时生效；桌面端由保存触发的 Helper 重启重新读取——physics 在 sprite 构造时只读一次。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('physicsTitle'), t('physicsHint')),
            h('div', {
              className: 'dsh-pet-cfg__grid4',
              children: [
                physField('gravity', '50', '0'),
                physField('restitution', '0.01', '0'),
                physField('groundFriction', '0.1', '0'),
                physField('throwPower', '0.05', '0.05', true),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                toggleCell('physicsCeilingBounce', physics.ceilingBounce, busy, (v) =>
                  setPhysics((p) => ({ ...p, ceilingBounce: v })),
                ),
                toggleCell(
                  'physicsPetCollision',
                  physics.petCollision,
                  busy,
                  (v) => setPhysics((p) => ({ ...p, petCollision: v })),
                  true,
                ),
              ],
            }),
          ],
        }),

        // 操作区：「测试弹窗」与「保存 / 同步」同一行（都是动作）；「同步」的副作用说明收进问号
        h('div', {
          className: 'dsh-pet-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => void save(),
              className: 'dsh-pet-cfg__btn is-primary',
              children: t('save'),
            }),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: sync,
              className: 'dsh-pet-cfg__btn',
              children: t('sync'),
            }),
            h('button', {
              type: 'button',
              onClick: () => void testNotification(),
              className: 'dsh-pet-cfg__btn',
              children: t('notifyTest'),
            }),
            q(t('syncHint')),
            // 两个反馈各归各的：msg = 保存/同步结果，permMsg = 测试通知结果
            msg.text
              ? h('span', {
                  className: 'dsh-pet-cfg__msg' + (msg.kind === 'err' ? ' is-err' : ''),
                  children: msg.text,
                })
              : null,
            permMsg.text
              ? h('span', {
                  className: 'dsh-pet-cfg__msg' + (permMsg.kind === 'err' ? ' is-err' : ''),
                  children: permMsg.text,
                })
              : null,
          ],
        }),

        // 高级配置（文件地址）：供高级用户直接编辑配置文件自定义；说明收进问号
        paths
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                cardHead(t('configMeta'), t('configMetaHint')),
                h('div', { className: 'dsh-pet-cfg__path', children: t('defaultConfig') + '：' + paths.default }),
                h('div', { className: 'dsh-pet-cfg__path', children: t('userConfig') + '：' + paths.user }),
                h('div', { className: 'dsh-pet-cfg__path', children: t('animationDir') + '：' + paths.animations }),
                paths.memes
                  ? h('div', { className: 'dsh-pet-cfg__path', children: t('memesDir') + '：' + paths.memes })
                  : null,
              ],
            })
          : null,

        // 卸载与存储：先列出插件落盘的全部位置（路径在前、作用在后），再给出卸载方法；说明收进问号
        paths && paths.storage && paths.storage.length > 0
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                cardHead(t('storageTitle'), t('storageHint')),
                // 存储位置清单：每条都是「路径（等宽、可选中复制）→ 作用」
                ...paths.storage.map((s) =>
                  h('div', {
                    key: s.key,
                    className: 'dsh-pet-cfg__path',
                    children: [
                      h('b', { key: 'p', style: { fontFamily: MONO }, children: s.path }),
                      // 尚未产生的目录（如从未启用桌面模式的 Electron）标一下，避免用户去找不存在的文件夹
                      h('span', {
                        key: 'd',
                        children: ' — ' + t('storage.' + s.key) + (s.exists === false ? t('storageMissing') : ''),
                      }),
                    ],
                  }),
                ),
                h('div', {
                  key: 'ut',
                  className: 'dsh-pet-cfg__cardTitle',
                  style: { marginTop: '4px' },
                  children: t('uninstallTitle'),
                }),
                h('div', { key: 'u1', className: 'dsh-pet-cfg__note', children: t('uninstallStep1') }),
                h('div', { key: 'u2', className: 'dsh-pet-cfg__note', children: t('uninstallStep2') }),
                h('div', {
                  key: 'cmd',
                  className: 'dsh-pet-cfg__cmd',
                  children: t('uninstallCmd').replace('{profile}', paths.profile || '<profile>'),
                }),
                h('div', { key: 'u3', className: 'dsh-pet-cfg__note', children: t('uninstallStep3') }),
              ],
            })
          : null,

        // 确认/提示弹窗（仿官方弹窗视觉：遮罩 + 居中卡片 + 按钮）
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
                        : dialog.kind === 'lastOne'
                          ? t('atLeastOne')
                          : dialog.kind === 'corrupt'
                            ? t('corruptBody').replace('{path}', dialog.path)
                            : t('confirmSync'),
                  }),
                  h('div', {
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
                    // 只剩一只 = 没有可确认的动作，只给一个「知道了」；其余都是 取消 + 确认 双按钮
                    children:
                      dialog.kind === 'lastOne'
                        ? [
                            h('button', {
                              key: 'ok',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-pet-cfg__btn is-primary',
                              children: t('ok'),
                            }),
                          ]
                        : [
                            h('button', {
                              key: 'cancel',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-pet-cfg__btn',
                              children: t('cancel'),
                            }),
                            h('button', {
                              key: 'confirm',
                              type: 'button',
                              onClick: () => {
                                const d = dialog;
                                setDialog(null);
                                if (d.kind === 'remove') doRemove();
                                else if (d.kind === 'corrupt')
                                  void save(true); // 确认：带 ?force=1 强行重建
                                else void doSync();
                              },
                              className: 'dsh-pet-cfg__btn ' + (dialog.kind === 'sync' ? 'is-primary' : 'is-danger'),
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
