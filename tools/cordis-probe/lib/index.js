/**
 * dsh-cordis-probe 的宿主半侧：注册五个 mock 服务商，验证第三方注册入口与展示层。
 *
 * 三件事，缺一不可：
 * - `ctx.llm.registerConfigurableProviders(...)` —— 让它们进入设置页的「模型」目录；
 * - `ctx.llm.registerAdapter(...)` —— 注册路由，选择器里才能选中并列出模型；
 * - `petApi7340.balance.register(...)` —— 选中后能查到余额、弹出对应气泡。
 *
 * 服务商里有两个是**自定义多页气泡**（`shape: 'custom'`）：一个把内置三种形态复刻成 4 页、
 * 一个自设计 3 页，用来验证"第三方自己决定气泡长什么样 + 点击循环切页"这条能力。
 *
 * 另有两个开关（语音合成 / 语音识别）：默认关闭，打开后各注册一个 mock 实现，
 * 用来验证 `petApi7340.voice.register` 与 `petApi7340.speech.register` 两条第三方入口。
 * 记忆同理：一个开关，打开后注册 mock 记忆，验证 `petApi7340.memory.register`。
 *
 * @module dsh-cordis-probe
 */
import { MOCK_BALANCE_PROVIDERS } from './mock-balance.js';
import { createMockAdapter } from './mock-adapter.js';
import { createMockMemoryProvider } from './mock-memory.js';
import { createMockSpeechProvider } from './mock-speech.js';
import { createMockVoiceProvider } from './mock-voice.js';
import { MEMORY_ROUTE, SPEECH_ROUTE, VOICE_ROUTE, createToggleHandler } from './toggle-route.js';

/** Cordis 插件名（诊断与日志里显示）。 */
export const name = 'cordis-probe';

/**
 * 依赖声明：Cordis 会等这些服务就绪后再执行 `apply`。
 * 缺少 `inject` 时 `apply` 会在服务提供之前跑，`ctx.get` 全部拿不到（已实测）。
 */
export const inject = ['llm', 'petApi7340'];

/** 模型选择器与设置页里显示的名字。 */
const DISPLAY_NAMES = {
  'mock-windows': 'Mock 三窗口额度',
  'mock-money': 'Mock 账户余额',
  'mock-points': 'Mock 积分',
  'mock-custom-kinds': 'Mock 自定义（4 页复刻三种形态）',
  'mock-custom-fancy': 'Mock 自定义（3 页复杂布局）',
};

/** 设置页里这几个 mock 服务商所属的命名空间（没有配置项，只用于渲染卡片）。 */
const SETTINGS_NS = 'llm-cordis-probe';

/**
 * 注册 mock 服务商。
 *
 * @param ctx - 宿主 Cordis 上下文；服务由 inject 保证在场，`petApi7340` 缺失时只跳过余额注册。
 */
export function apply(ctx) {
  const ids = MOCK_BALANCE_PROVIDERS.map((p) => p.id);

  // 1) 设置页的模型目录
  try {
    ctx.effect(() =>
      ctx.llm.registerConfigurableProviders(
        MOCK_BALANCE_PROVIDERS.map((p) => ({
          provider: p.id,
          displayName: DISPLAY_NAMES[p.id] ?? p.id,
          settingsNs: SETTINGS_NS,
          settingsPath: [],
        })),
      ),
    );
  } catch (e) {
    warn('模型目录', e);
  }

  // 2) 模型路由：让这些 id 能在选择器里选中，并广告一个模型
  try {
    ctx.effect(() => ctx.llm.registerAdapter(ids, createMockAdapter(DISPLAY_NAMES)));
  } catch (e) {
    warn('模型路由', e);
  }

  // 3) 余额注册表：选中之后能查到余额
  const balance = ctx.get('petApi7340', false)?.balance;
  if (!balance) return;
  for (const def of MOCK_BALANCE_PROVIDERS) {
    try {
      ctx.effect(() => balance.register(def));
    } catch (e) {
      warn('余额服务商 ' + def.id, e);
    }
  }

  // 4) 语音与识别：各一个开关，默认关闭，打开后 register 一个 mock 实现。
  // 注册在宿主、按钮在页面，两半没有直接通道，所以额外开两个最小路由给页面点。
  const api = ctx.get('petApi7340', false);
  /** 待挂载的开关路由：路径 → 读写控制。 */
  const toggles = [];

  const voice = api?.voice;
  if (voice) {
    /** 已打开的注销函数；null = 当前关闭。 */
    let disposeVoice = null;
    /** 打开/关闭 mock 语音；幂等，重复调用不会叠加注册。 */
    const setVoiceOn = (on) => {
      if (on && !disposeVoice) disposeVoice = voice.register(createMockVoiceProvider());
      if (!on && disposeVoice) {
        disposeVoice();
        disposeVoice = null;
      }
      return on;
    };
    // 插件卸载时确保注销：否则 mock 语音会赖在宿主里，之后的 /voice/speak 一直走提示音
    ctx.effect(() => () => {
      setVoiceOn(false);
    });
    toggles.push([VOICE_ROUTE, { isOn: () => disposeVoice !== null, setOn: setVoiceOn }]);
  }

  const speech = api?.speech;
  if (speech) {
    /** 已打开的注销函数；null = 当前关闭。 */
    let disposeSpeech = null;
    /** 打开/关闭 mock 识别；幂等，重复调用不会叠加注册。 */
    const setSpeechOn = (on) => {
      if (on && !disposeSpeech) disposeSpeech = speech.register(createMockSpeechProvider());
      if (!on && disposeSpeech) {
        disposeSpeech();
        disposeSpeech = null;
      }
      return on;
    };
    // 同上：卸载时必须注销，否则 /voice/hear 会一直回 mock 文字
    ctx.effect(() => () => {
      setSpeechOn(false);
    });
    toggles.push([SPEECH_ROUTE, { isOn: () => disposeSpeech !== null, setOn: setSpeechOn }]);
  }

  const memory = api?.memory;
  if (memory) {
    /** 已打开的注销函数；null = 当前关闭。 */
    let disposeMemory = null;
    /** 当前持有的 provider 实例；关闭后置空，计数从 0 重新开始。 */
    let memoryProvider = null;
    /** 打开/关闭 mock 记忆；幂等，重复调用不会叠加注册。 */
    const setMemoryOn = (on) => {
      if (on && !disposeMemory) {
        memoryProvider = createMockMemoryProvider();
        disposeMemory = memory.register(memoryProvider);
      }
      if (!on && disposeMemory) {
        disposeMemory();
        disposeMemory = null;
        memoryProvider = null;
      }
      return on;
    };
    // 卸载时注销：否则 mock 记忆会赖在宿主里，之后的对话一直带 mock 证据
    ctx.effect(() => () => {
      setMemoryOn(false);
    });
    toggles.push([
      MEMORY_ROUTE,
      {
        isOn: () => disposeMemory !== null,
        setOn: setMemoryOn,
        // capture 计数：聊一句后 +1，证明扩展真的收到了这一轮
        extra: () => ({ captured: memoryProvider ? memoryProvider.stats().captured : 0 }),
      },
    ]);
  }

  const webServer = ctx.get('webServer', false);
  if (!webServer) return;
  for (const [path, control] of toggles) {
    try {
      ctx.effect(() => webServer.register({ kind: 'prefix', path, handler: createToggleHandler(control) }));
    } catch (e) {
      warn('开关路由 ' + path, e);
    }
  }
}

/** 注册失败不该让整个探针起不来：记一行日志即可。 */
function warn(what, e) {
  console.warn('[cordis-probe] 注册失败 ' + what + '：' + (e instanceof Error ? e.message : String(e)));
}
