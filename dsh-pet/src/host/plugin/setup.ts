/**
 * 宿主环境装配：日志出口、用户目录、配置路径与进程内 store。
 *
 * 只创建对象、算路径、注册可选服务，不启动任何循环，也不碰网络；
 * 需要 ctx 的两处（日志收尾 effect、petApi7340 服务）一并在这里注册。
 * 必须始终成立：日志只创建一次——复用到 standalone 挂上的 logger 时不得再建第二个。
 * @module dsh-pet/src/host/plugin/setup
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { listBalanceProviders, registerBalanceProvider } from '../balance/index.ts';
import { listVoiceProviders, registerVoiceProvider } from '../voice/registry.ts';
import { listSpeechProviders, registerSpeechProvider } from '../voice/speech-registry.ts';
import { listChatMemoryProviders, registerChatMemoryProvider } from '../chat-memory-provider.ts';
import { migrateUserConfig, type ConfigPaths } from '../config.ts';
import { createFileLogger, isFileLogger, setDefaultLogger, type FileLogger, type LoggerLike } from '../log-file.ts';
import { MenuRegistry } from '../menu.ts';
import { PACKAGE_MEMES_DIR, PACKAGE_ROOT } from '../paths.ts';
import { PlaybackStore } from '../playback.ts';
import { resolveAsset } from '../http.ts';
import { PollStateStore } from '../state.ts';
import { WorkStatusStore } from '../work-status.ts';
import type { StandaloneWhisperPolicy } from '../whisper-policy.ts';

/** 装配期需要的宿主上下文：只有 logger / effect / provide 三处能力。 */
export interface HostSetupContext {
  /** 宿主日志（可能已被 standalone 换成文件 logger）。 */
  readonly logger?: LoggerLike;
  /** 注册随插件卸载自动清理的副作用。 */
  effect(setup: () => (() => void) | void, label: string): void;
  /** 对外提供 Cordis 服务。 */
  provide(name: string, value: unknown): void;
}

/** 独立模式余额查询要用的服务商与密钥（由 standalone 的 standaloneAi 服务提供）。 */
export interface StandaloneBalanceAuth {
  /** 设置页选中的余额服务商 id；空串表示未选择。 */
  provider: string;
  /** 设置页保存的密钥；空串表示未保存。 */
  apiKey: string;
}

/** 装配产物：apply 后续逻辑与路由层共用的对象。 */
export interface HostSetup {
  /** 本插件的数据根（配置与用户素材都收敛于此） */
  readonly userRoot: string;
  /** 插件日志出口（文件 + 终端） */
  readonly log: FileLogger;
  /** 配置路径集 */
  readonly configPaths: ConfigPaths;
  /** 用户主配置路径 */
  readonly userConfigPath: string;
  /** 文件宠物目录 */
  readonly petConfigDir: string;
  /** 用户动画目录 */
  readonly thumbUserRoot: string;
  /** 用户表情包目录 */
  readonly memesUserRoot: string;
  /** 表情包目录链 */
  readonly memeDirsFor: (assetRoot: string) => string[];
  /** 软取宿主可选服务 */
  readonly optionalService: (name: string) => unknown;
  /** 独立模式的碎碎念授权策略 */
  readonly standaloneAiPolicy: () => StandaloneWhisperPolicy | undefined;
  /** 独立模式的余额凭证；DSH 宿主里是 undefined → 余额走 currentSelection 与 credential store。 */
  readonly standaloneAiBalance: () => StandaloneBalanceAuth | undefined;
  /** 轮询快照 */
  readonly state: PollStateStore;
  /** 第三方菜单注册表 */
  readonly menuRegistry: MenuRegistry;
  /** 播放记录表 */
  readonly playback: PlaybackStore;
  /** 工作状态快照 */
  readonly workStatus: WorkStatusStore;
  /** 外部写入的固定会话 id */
  readonly EXTERNAL_WORK_SESSION: string;
  /** 推进外部写入序号 */
  readonly nextExternalWorkSeq: () => number;
}

/**
 * 创建宿主运行期对象。
 * @param ctx - 宿主上下文（apply 收到的那一个）。
 * @returns 日志、路径、store 与两个工具函数。
 */
export function createHostSetup(ctx: HostSetupContext): HostSetup {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const dshHome = resolveDshHome();

  const userRoot = join(dshHome, 'dsh-pet');

  // 统一日志出口（单文件、按大小截断，见 ./log-file）：桌面版 DSH 没有控制台，ctx.logger 只写
  // stdout 等于把排障信息丢掉；base 保留终端输出。
  // standalone 已把自己的文件 logger 挂在 ctx.logger 上时必须复用，否则两个 logger 各自的缓冲
  // 与截断会写同一个文件、互相踩。
  const reusedLog = isFileLogger(ctx.logger) ? ctx.logger : undefined;

  const log =
    reusedLog ??
    createFileLogger({
      file: join(userRoot, 'logs.txt'),
      base: ctx.logger,
      debugEnabled: process.env.DSH_PET_LOG_DEBUG === '1',
    });

  // 纯模块（./config、./chat、./whisper）拿不到 ctx.logger，用这个默认出口落盘
  setDefaultLogger(log);

  // 只在自己创建时负责收尾：复用的 logger 归 standalone/app 生命周期管，插件卸载不该把它关掉。
  if (!reusedLog) {
    ctx.effect(
      () => () => {
        void log.flush();
        log.dispose();
      },
      'dsh-pet: log file',
    );
  }

  /**
   * 软取宿主提供的可选服务（DSH 的 `ctx.get(name, required)` 语义：缺失返回 undefined，不抛）。
   *
   * 不能直接读 `ctx.xxx`：DSH 的 ctx 是严格 getter，读未写进 inject 的服务会抛异常而非返回 undefined
   * ——独立模式独有的 standaloneAi / shutdownApp 都没进 inject，裸读会让碎碎念 tick 每拍抛错、
   * /quit 回 500 而不是 {canQuit:false}。测试里的 fake ctx 没有 get，回落成属性读取即可。
   */
  const optionalService = (name: string): unknown => {
    const get = (ctx as { get?: (n: string, required?: boolean) => unknown }).get;
    if (typeof get === 'function') return get.call(ctx, name, false);
    return (ctx as unknown as Record<string, unknown>)[name];
  };

  /** 独立模式的碎碎念授权策略（可选能力）：DSH 宿主里是 undefined → 回落到只看 pet.whisperEnabled。 */
  const standaloneAiPolicy = (): StandaloneWhisperPolicy | undefined =>
    optionalService('standaloneAi') as StandaloneWhisperPolicy | undefined;

  /** 独立模式的余额凭证（可选能力）：DSH 宿主里是 undefined → 回落到模型服务商与 credential store。 */
  const standaloneAiBalance = (): StandaloneBalanceAuth | undefined => {
    const service = optionalService('standaloneAi') as { balanceAuth?: () => StandaloneBalanceAuth } | undefined;
    return service?.balanceAuth?.();
  };

  // 用户主配置（可编辑层）与文件宠物目录；配置读取/合并统一走 readAllConfig（./config）。
  // 主配置是 JSONC（main-config.jsonc）——与包内默认 config.jsonc 同名同格式：
  // 「同步」写进去的就是带注释的原文，扩展名如实反映内容（main-config.json 只读回落 + 启动迁移）
  const userConfigPath = join(userRoot, 'main-config.jsonc');

  const legacyUserConfigPath = join(userRoot, 'main-config.json');

  const petConfigDir = join(userRoot, 'pet');

  // 配置路径集（readAllConfig 的唯一输入：内置默认 + 用户主配置 + 文件宠物目录）
  const configPaths: ConfigPaths = {
    defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
    userFile: userConfigPath,
    legacyUserFile: legacyUserConfigPath,
    petDir: petConfigDir,
  };

  // 老用户一次性迁移：main-config.json → main-config.jsonc（重命名，内容一字不动；
  // 新文件已存在则不动旧文件）。失败不影响运行——读取侧对旧路径有回落。
  migrateUserConfig(configPaths, (msg) => log.info('[dsh-pet] ' + msg));

  // 用户动画目录（thumb 播放时优先于包内素材；webm 放 main-animation/webm/，mov（macOS 定制）放 main-animation/mov/）
  const thumbUserRoot = join(userRoot, 'main-animation');

  // 用户表情包目录（碎碎念/对话配图的图片：优先于包内 assets/memes，加图不必改包）
  const memesUserRoot = join(userRoot, 'memes');

  /**
   * 表情包目录链，与动画素材（/thumb）同一套归属语义：`pet/<素材根>-memes/` 存在则只查它；
   * 否则用户目录优先、包内兜底。池（readMemePool）与路由（/pic/memes）必须走同一个函数，
   * 否则池里能选的名字路由取不到，气泡配图会图裂。
   * 素材根来自 URL 段，必须先过 resolveAsset，避免 Windows 上 %5C 解出的反斜杠逃出用户根。
   */
  const memeDirsFor = (assetRoot: string): string[] => {
    const own = resolveAsset(petConfigDir, assetRoot + '-memes');
    if (own !== undefined && existsSync(own)) return [own];
    return [memesUserRoot, PACKAGE_MEMES_DIR];
  };

  // 轮询状态（/state）：前端 1s 轮询的唯一数据源（余额 / 工作状态 / 通知 / 宠物说话）。
  // 所有写入走 state.writeSection / writePet（统一更新 counter）。
  const state = new PollStateStore();

  // 第三方右键菜单注册表：进程内存态，不落盘，重启即空。
  // 注册表写进 S 的 sections.menu；点击事件不进 S——它是触发不是状态，走 /menu/events 读取即消费。
  const menuRegistry = new MenuRegistry();

  // 对外 Cordis 服务（宿主半侧）：与页面侧的 petApi7340 同名，但分属两个容器，互不可见也互不覆盖。
  // 只暴露 register（返回注销函数，配合 ctx.effect 在卸载时自动清理）与 list（排障用）；
  // 不暴露 unregister：注销走返回值，避免任何插件都能注销别人的 provider。
  ctx.provide('petApi7340', {
    balance: {
      register: registerBalanceProvider,
      list: listBalanceProviders,
    },
    // 语音：第三方注册自己的合成实现，非空时合成走它、空则走内置 edge。
    // 同样只给 register（返回 disposer）与 list，不给 unregister。
    voice: {
      register: registerVoiceProvider,
      list: listVoiceProviders,
    },
    // 识别：与合成对称的一槽；注册后 /voice/hear 只走它，不再看宿主自带的 speechToText。
    speech: {
      register: registerSpeechProvider,
      list: listSpeechProviders,
    },
    // 记忆：第三方注册自己的长期记忆后端（单槽）；只给 register 与 list，注销走返回值。
    memory: {
      register: registerChatMemoryProvider,
      list: listChatMemoryProviders,
    },
  });

  // 播放记录表（issue #122 第 3 项）：由渲染端上报驱动的状态机 + 等待者。
  // 与 S 无关：播放记录是 per-caller 资源（只有发起那次点播的调用方关心、有生命周期），
  // 塞进 1s 全局广播会让每个窗口为每个功能付流量。
  const playback = new PlaybackStore();

  // 工作状态联动快照（/work-status 端点响应，浏览器 1s 轮询）：state = 当前活动状态（null = 空闲），
  // task = 当前任务详情。state 与 task 都按会话存——全局单值会让一次任务详情跟着此后所有会话活动
  // 一直显示（issue #59）。气泡文案不在此：浏览器读配置 events.workStatusTexts。
  // 进程内内存态：重启回空闲；每次会话事件有实际状态变化才更新。
  const workStatus = new WorkStatusStore();

  /** 外部写入槽：固定会话 id，最后写入者生效；不做多写者仲裁/租约/会话管理 */
  const EXTERNAL_WORK_SESSION = 'api';

  let externalWorkSeq = 0;

  /** 推进外部写入序号并返回新值：每发生一次外部写入前进一拍，前端据此判断是否新的一次写入。 */
  const nextExternalWorkSeq = (): number => (externalWorkSeq += 1);

  return {
    userRoot,
    log,
    configPaths,
    userConfigPath,
    petConfigDir,
    thumbUserRoot,
    memesUserRoot,
    memeDirsFor,
    optionalService,
    standaloneAiPolicy,
    standaloneAiBalance,
    state,
    menuRegistry,
    playback,
    workStatus,
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
  };
}
