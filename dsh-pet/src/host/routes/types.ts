/**
 * 路由层的依赖契约：`apply` 在挂载时构造一次，各路由模块只读消费。
 *
 * 显式依赖是这一层的全部意义——路由不再从 `apply` 的闭包里"抓"变量，
 * 于是每个领域模块都能单独读、单独改、单独测，改路由不必改装配。
 * 不负责生命周期：store 的创建与销毁归 `apply`，路由只调用。
 * @module dsh-pet/src/host/routes/types
 */
import type { ChatMemoryMessage } from '../chat.ts';
import type { ConfigPaths } from '../config.ts';
import type { RouteResult } from '../http.ts';
import type { PetImageRef } from '../image-attachment.ts';
import type { LockStore } from '../lock.ts';
import type { FileLogger } from '../log-file.ts';
import type { MenuRegistry } from '../menu.ts';
import type { PlaybackStore } from '../playback.ts';
import type { PoseStore } from '../pose.ts';
import type { PollStateStore } from '../state.ts';
import type { VoiceTarget } from '../surface.ts';
import type { TodoStore } from '../todo/store.ts';
import type { VoiceService } from '../voice/speak.ts';
import type { WorkStatusStore } from '../work-status.ts';

/** 一次路由调用的输入：URL 已解析，`rest` 是去掉前缀并解码后的路径。 */
export interface RouteInput {
  /** 完整请求 URL（含查询串）。 */
  readonly url: URL;
  /** 去掉 `/dsh-pet-7340/` 前缀后的剩余路径（已解码）。 */
  readonly rest: string;
  /** HTTP 方法（大写）。 */
  readonly method: string;
  /** 请求体文本；只有 PUT/POST 才有值。 */
  readonly body?: string;
  /** 调用方断开信号：挂起等待的路由据此提前收尾。 */
  readonly signal?: AbortSignal;
}

/** 碎碎念与对话共用的生成结果。 */
export type GeneratedReply =
  | { ok: true; text: string; image?: string }
  | {
      ok: false;
      reason: 'provider-missing' | 'generate-error' | 'unknown-pet' | 'unknown-image';
      message?: string;
    };

/** 宠物定位结果：命中给出所在层与条目，未命中给出可直接返回的应答。 */
export type PetLookup =
  | {
      ok: true;
      petId: string;
      entry: string;
      conf: Record<string, unknown>;
      pet: Record<string, unknown>;
    }
  | { ok: false; res: RouteResult };

/** 单个路由处理函数：未命中返回 undefined，命中返回应答。 */
export type RouteHandler = (deps: PetRouteDeps, input: RouteInput) => Promise<RouteResult | undefined>;

/**
 * 路由层需要的全部外部能力。
 *
 * 字段分三类：只读路径与配置、进程内 store、`apply` 里已有的动作函数。
 * 唯一有副作用的是 `nextExternalWorkSeq`：它推进外部写入序号并返回新值。
 */
export interface PetRouteDeps {
  /** 配置路径集（内置默认 + 用户主配置 + 文件宠物目录）。 */
  readonly configPaths: ConfigPaths;
  /** 第三方右键菜单注册表（进程内存态）。 */
  readonly menuRegistry: MenuRegistry;
  /** 轮询快照（前端 1s 轮询的唯一数据源）。 */
  readonly state: PollStateStore;
  /** 待办清单（单个 JSON 文件，读改写串行）。 */
  readonly todos: TodoStore;
  /** 工作状态联动快照。 */
  readonly workStatus: WorkStatusStore;
  /** 外部写入用的固定会话 id。 */
  readonly EXTERNAL_WORK_SESSION: string;
  /** 占用锁拦截：被别的会话占着时直接给出应答。 */
  readonly surfaceBlocked: (
    cfg: Record<string, Record<string, unknown>>,
    petId: string,
    params: URLSearchParams,
  ) => RouteResult | null;
  /** 同上，按 petId 判定。 */
  readonly lockBlocked: (petId: string, params: URLSearchParams) => RouteResult | null;
  /** 用户主配置路径。 */
  readonly userConfigPath: string;
  /** 请求重载桌面 Helper：是否真的重启、如何串行与退避由桌面侧决定（调用方只表达意图）。 */
  readonly requestRestart: () => Promise<void>;
  /** 按 `?pet=` 定位宠物；缺参/未知宠物给出可直接返回的应答。 */
  readonly requirePet: (
    params: URLSearchParams,
    cfg: () => Record<string, Record<string, unknown>>,
    opts?: { surface?: boolean },
  ) => PetLookup;
  /** 播放记录表。 */
  readonly playback: PlaybackStore;
  /** 用户数据根。 */
  readonly userRoot: string;
  /** 占用锁。 */
  readonly lock: LockStore;
  /** 插件日志出口（文件 + 终端）。 */
  readonly log: FileLogger;
  /** 宿主上下文的最小结构：路由只用到 logger 与 llm 服务。 */
  readonly ctx: { logger?: { warn?(message: string): void }; llm?: unknown };
  /** 文件宠物目录（`pet/`）。 */
  readonly petConfigDir: string;
  /** 把最新工作状态写进轮询快照。 */
  readonly publishWorkStatus: () => void;
  /** 推进外部写入序号并返回新值（前端据此判断是否新的一拍）。 */
  readonly nextExternalWorkSeq: () => number;
  /** 表情包目录链（与 /thumb 同一套归属语义）。 */
  readonly memeDirsFor: (assetRoot: string) => string[];
  /** 姿态上报存储。 */
  readonly pose: PoseStore;
  /** 软取宿主可选服务（缺失返回 undefined）。 */
  readonly optionalService: (name: string) => unknown;
  /** 用户动画目录。 */
  readonly thumbUserRoot: string;
  /** 用户表情包目录。 */
  readonly memesUserRoot: string;
  /** 刷新余额（manual 表示用户主动触发）。 */
  readonly refreshBalance: (manual?: boolean) => Promise<void>;
  /** 生成一条碎碎念；image 给了就用这张图（需在池内），缺省 = 按配置随机抽一张或纯文本。
   *  voiceTo 由带 `?surface=` 的路由传请求面；kind=whisper 时按 voiceWhisperEnabled 决定要不要念。 */
  readonly publishWhisper: (
    petId: string,
    image?: string,
    voiceTo?: VoiceTarget,
    kind?: 'whisper' | 'manual',
  ) => Promise<GeneratedReply>;
  /** 读取对话记忆文件。 */
  readonly readMemory: () => Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>>;
  /** 对话记忆文件路径。 */
  readonly memoryPath: string;
  /** 单次对话保留的轮数。 */
  readonly memoryRounds: (conf: Record<string, unknown>) => number;
  /** 与本机宠物对话；image 缺省 = 纯文本，数据路径与加入图片前一致。 */
  readonly chatWithPet: (petId: string, text: string, image?: PetImageRef) => Promise<GeneratedReply>;
  /** 删除该宠物的对话记忆：ts 缺省 = 清空全部，否则只删命中的轮（成对）。 */
  readonly deleteHistory: (
    petId: string,
    ts?: readonly number[],
  ) => Promise<{ ok: true; removed: number } | { ok: false; reason: 'unknown-pet'; message: string }>;
  /** 已删宠物残留的记忆桶（配置里已没有这只宠物）。 */
  readonly orphanHistory: () => Promise<{ entry: string; petId: string; messages: number; lastTs: number }[]>;
  /** 清掉所有已删宠物的历史。 */
  readonly deleteOrphans: () => Promise<{ ok: true; pets: number; messages: number }>;
  /** 用户动画目录（按扩展名）。 */
  readonly userRootFor: (ext: string) => string;
  /** 包内动画目录（按扩展名）。 */
  readonly assetRootFor: (ext: string) => string;
  /** 语音合成服务（校验、排队、缓存与上游调用都在里面）。 */
  readonly voice: VoiceService;
}
