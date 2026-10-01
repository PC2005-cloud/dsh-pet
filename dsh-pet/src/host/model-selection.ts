/**
 * 碎碎念 / 对话的模型选择（host 半侧，纯逻辑、零依赖）——把「条目配置里单独指定的服务商 + 模型」
 * 与「当前对话的模型」合成一条**候选链**，供生成侧按序尝试。
 *
 * 为什么要这条链：whisperModel / chatModel 留空时行为必须与旧版**逐字一致**（跟随当前对话的模型）；
 * 填了则优先用它，但选中的模型可能已经不可用（凭据被删 / 模型下架 / 该服务商没配 key），
 * 那时**回落到当前对话的模型重试一次**，仍失败才按生成失败报错——桌宠不会因为改错一次配置就彻底哑掉。
 *
 * 依赖约束：本模块不 import @deepseek-ai/dsh-llm（生成模块才需要它），保证能在 node:test 里
 * 直接单测（与 chat.test.ts 只测 memes.ts 同一个理由）。
 */

/** 一处「服务商 + 模型」选择（与 shared/types.ts 的 ModelSelection 同构） */
export interface ModelRef {
  provider: string;
  model: string;
}

/** 读条目配置里的 whisperModel / chatModel：
 *  两个字段都非空 → 该选择；都为空（内置默认）→ undefined（= 跟随当前对话）；
 *  结构不对 / 只填一半（合并器已挡下，这里再防御一次）→ undefined。 */
export function configuredModel(
  conf: Record<string, unknown> | undefined,
  key: 'whisperModel' | 'chatModel',
): ModelRef | undefined {
  const raw = conf?.[key];
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.provider !== 'string' || typeof m.model !== 'string') return undefined;
  const provider = m.provider.trim();
  const model = m.model.trim();
  return provider && model ? { provider, model } : undefined;
}

/** 当前对话的模型（agentDefaultModel.currentSelection）；未配置 / 抛错 → undefined */
export function currentModel(ctx: { agentDefaultModel?: { currentSelection(): ModelRef } }): ModelRef | undefined {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection();
    return sel?.provider && sel?.model ? { provider: sel.provider, model: sel.model } : undefined;
  } catch {
    return undefined;
  }
}

/** 候选链：配置的模型优先，其次当前对话的模型；同一个选择只留一次。
 *  返回空数组 = 两个来源都拿不到（生成侧据此回「当前对话未配置模型」）。 */
export function modelCandidates(
  ctx: { agentDefaultModel?: { currentSelection(): ModelRef } },
  preferred?: ModelRef,
): ModelRef[] {
  const out: ModelRef[] = [];
  const push = (m: ModelRef | undefined): void => {
    if (!m) return;
    if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
    out.push(m);
  };
  push(preferred);
  push(currentModel(ctx));
  return out;
}

/** 报错/日志用的选择标签：provider/model */
export function modelLabel(m: ModelRef): string {
  return m.provider + '/' + m.model;
}
