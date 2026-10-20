/**
 * 「播放进度」的**页面内**注册表 —— 给 Cordis 只读服务 `petApi7340` 用（issue #122 第 2 条）。
 *
 * 为什么进度不做 HTTP 接口：
 *
 *   读进度是**每帧**都要的事（侧栏跟随视频时间），做成 HTTP 就是每秒几十次回环。而它又是
 *   纯粹的只读快照、没有任何副作用，正好落在「高频只读 + 同页面」这一格：页面内直接读
 *   `<video>` 属性，零请求、零序列化。
 *
 *   低频的状态查询（`accepted / playing / ended / cancelled / failed`）仍留在 HTTP 的
 *   `GET /playback/{id}` 上 —— 那是跨进程也要能用的事实来源，两者职责不重叠。
 *
 * 与 `pose.ts` 的对称：
 *
 *   `pose`      → 位置 + 朝向，读的是 DOM 几何
 *   `progress`  → 当前播放位置 / 总长 / 暂停 / 缓冲，读的是 `<video>` 状态
 *
 * 两者都是「按需读」：消费者每次调用都走闭包取当前值，所以拿到的是**这一刻**的状态，
 * 不是注册时的快照。
 *
 * **本模块是 client-only**：`src/shared/` 会被打进 `shared-core.js` 供桌面端共用，而桌面端
 * 没有 Cordis 容器，读进度得走别的路（或者不做）。
 */

/**
 * 一次播放的进度快照。
 *
 * 字段全部取自前台 `<video>`，没有缓存、没有定时器 —— 调用方按帧读即可。
 */
export type PlaybackProgress = {
  /**
   * 本次播放的编号。
   *
   * `null` = 当前是**自播动画**（随机走位 / 点击 / 拖拽 / 碎碎念 / 余额…），不是第三方点播。
   * 第三方用它与自己发起的 `playbackId` 比对，对不上就说明被别的播放顶替了。
   */
  playbackId: string | null;
  /**
   * 当前正在播的动画名。
   *
   * 与 `anim` 接口同一套命名：播池内动作时是动作名（如 `walk`），`url` 点播时是该地址
   * （网页端不区分这两者，用 `playbackId` 是否非空来分辨是不是第三方点播）。
   */
  anim: string;
  /** 当前播放位置，秒。 */
  currentTime: number;
  /** 视频总长，秒；元数据还没就绪时为 `0`（不用 `NaN` —— 传给调用方没法处理）。 */
  duration: number;
  /** 是否暂停。**播放到结尾也是 `true`**。 */
  paused: boolean;
  /** 是否在缓冲：`readyState < 3`（HAVE_FUTURE_DATA）或正在 seek。 */
  buffering: boolean;
};

/** petId → 取当前进度的函数（PetCard 挂载时注册、卸载时摘除） */
const readers = new Map<string, () => PlaybackProgress>();

/**
 * 注册一只宠物**在这一页**的进度读法。
 *
 * @returns 摘除函数（PetCard 卸载时调；重复调用无害）
 */
export function registerProgress(petId: string, read: () => PlaybackProgress): () => void {
  readers.set(petId, read);
  return () => {
    // 只摘掉**自己那一份**：同一 id 被重新挂载（StrictMode 双挂载 / 切换页面）时，后注册的那份
    // 不能被前一个的清理函数误摘掉——否则口子会静默失效
    if (readers.get(petId) === read) readers.delete(petId);
  };
}

/**
 * 读某只宠物**在这一页**的播放进度。
 *
 * `null` = 这一页没有它：不存在该 id / 尚未挂载 / `display` 不含 `web`。
 *
 * **按需读**：每次调用都取当前值（不是快照），所以播放**中途**读到的就是那一刻的位置。
 */
export function readProgress(petId: string): PlaybackProgress | null {
  if (typeof petId !== 'string' || petId === '') return null;
  const read = readers.get(petId);
  return read === undefined ? null : read();
}

/** 当前注册了几只（测试 / 观测用：验证卸载不泄漏） */
export function progressReaderCount(): number {
  return readers.size;
}
