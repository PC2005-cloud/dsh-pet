/**
 * 当前模型是否支持 reasoning effort（含 "off"）的探测（host 半侧共用）。
 *
 * dsh-llm 对"模型无 reasoning 元数据 + 调用方显式传 effort"会直接判
 * UNSUPPORTED_REASONING_EFFORT（请求发不出去，被 adapter 折叠成空流，
 * 表现为"模型未返回文本"），因此只有在模型确实声明支持时才应传
 * reasoningEffort: 'off'；其余情况省略该字段（语义等价："off" 对无 reasoning
 * 元数据的模型本就等于"不传"）。
 */

/** 可调用的 dsh-llm resolveModelInfo 能力的最小形状（防御式：不依赖完整类型） */
interface ResolveModelInfoCapable {
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts?: ReadonlyArray<{ id: string }> } }>;
}

/**
 * 当前 provider/model 是否声明支持 reasoning effort（含 "off"）。
 * 能力缺失或查询失败一律保守返回 false（= 不传，等价于模型默认行为，避免请求失败）。
 */
export async function supportsReasoningOff(
  ctx: { llm?: unknown },
  provider: string,
  model: string,
): Promise<boolean> {
  const llm = ctx.llm as ResolveModelInfoCapable | undefined;
  if (!llm || typeof llm.resolveModelInfo !== 'function') return false;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    return info?.reasoning?.efforts?.some((e) => e.id === 'off') ?? false;
  } catch {
    return false; // 查询失败保守不传（等价于模型默认行为，不至于让请求失败）
  }
}