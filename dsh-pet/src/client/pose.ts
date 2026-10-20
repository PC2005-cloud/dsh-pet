/**
 * 「实况」（位置 + 朝向）的**页面内**注册表 —— 给 Cordis 只读服务 `petApi7340` 用。
 *
 * 为什么网页端只能走页面内（issue #122 第 1 条）：
 *
 *   1. **网页端的宠物位置天生是每个页面一份**——宠物在各自页面的视口里，开两个标签页时两边的
 *      位置本来就不同。把它塞进宿主的一份快照，语义上就是错的（后写者覆盖先写者）。
 *   2. 而"页面内读"恰好把**实例身份**这件事一起解决了：读到的就是这个页面里的这只——不需要
 *      额外的实例 id，也不可能串到另一个标签页或桌面端。
 *
 * 两种形态的对称（字段名与坐标口径**完全一致**，只是"取"的方式不同）：
 *
 *   网页 → `ctx.get('petApi7340').pose(petId)`：页面内、**按需**、零请求、读到就能直接喂回
 *          `POST /position`（同一套归一化中心坐标）
 *   桌面 → `GET /pose?pet=<id>`：宿主侧快照（桌面宠物一窗一只，全局唯一一份，语义干净）
 *
 * **本模块是 client-only**：`src/shared/` 会被打进 `shared-core.js` 供桌面端共用，而桌面端不走
 * 这条路（它有自己的上报：`POST /pose/report`）。
 */

/** 一次实况：宠物**中心**的归一化坐标 + 朝向（与 `POST /position` 同一套坐标口径） */
export type Pose = { x: number; y: number; facing: 'left' | 'right' };

/** petId → 取当前实况的函数（PetCard 挂载时注册、卸载时摘除） */
const readers = new Map<string, () => Pose>();

/**
 * 注册一只宠物**在这一页**的实况读法。
 *
 * @returns 摘除函数（PetCard 卸载时调；重复调用无害）
 */
export function registerPose(petId: string, read: () => Pose): () => void {
  readers.set(petId, read);
  return () => {
    // 只摘掉**自己那一份**：同一 id 被重新挂载（StrictMode 双挂载 / 切换页面）时，后注册的那份
    // 不能被前一个的清理函数误摘掉——否则口子会静默失效
    if (readers.get(petId) === read) readers.delete(petId);
  };
}

/**
 * 读某只宠物**在这一页**的实况。
 *
 * `null` = 这一页没有它：不存在该 id / 尚未挂载 / `display` 不含 `web`。这与桌面端
 * `GET /pose` 的"明确不可用"是同一个语义（那边是 `ok:false` + `reason`）。
 *
 * **按需读**：每次调用都取当前值（不是快照），所以走位、抛掷、拖拽**中途**也能读到。
 */
export function readPose(petId: string): Pose | null {
  if (typeof petId !== 'string' || petId === '') return null;
  const read = readers.get(petId);
  return read === undefined ? null : read();
}

/** 当前注册了几只（测试 / 观测用：验证卸载不泄漏） */
export function poseReaderCount(): number {
  return readers.size;
}
