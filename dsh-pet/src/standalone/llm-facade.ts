/**
 * ctx.llm 替身：有独立 AI 服务时转调，没有时显式不可用。
 *
 * 形状必须与 DSH 的 llm 服务一致（路由与设置页只认这几个方法）；不实现生成逻辑（归 ./ai-provider）。
 * 必须始终成立：未接入模型时每个调用都抛错或给空清单，绝不假装成功。
 * @module dsh-pet/src/standalone/llm-facade
 */

/** ctx.llm 替身的契约，形状必须与 DSH 一致。 */
export interface StandaloneModelService {
  currentSelection(): { provider: string; model: string };
  listProviders(): unknown[];
  listModels(provider: string): Promise<unknown[]>;
  resolveModelInfo(provider?: string, model?: string, signal?: AbortSignal): Promise<unknown>;
  stream(options: unknown): AsyncIterable<unknown>;
  isReady(): boolean;
  dispose(): void;
}

/** 宿主路由实际用到的 llm 面。 */
export interface LlmFacade {
  listProviders(): unknown[];
  listModels(provider: string): Promise<unknown[]>;
  resolveModelInfo(provider?: string, model?: string, signal?: AbortSignal): Promise<unknown>;
  stream(request: unknown): AsyncIterable<unknown>;
}

/** 有 AI 服务：直接转调，不做任何转换。 */
export function createLlmFacade(ai: StandaloneModelService): LlmFacade {
  return {
    listProviders: () => ai.listProviders(),
    listModels: (provider) => ai.listModels(provider),
    resolveModelInfo: (provider, model, signal) => ai.resolveModelInfo(provider, model, signal),
    stream: (request) => ai.stream(request),
  };
}

/** 没有 AI 服务：模型能力明确不可用，让调用方拿到可读原因而不是空结果。 */
export function createOfflineLlm(): LlmFacade {
  return {
    listProviders: () => [],
    listModels: async () => [],
    // 契约是异步的，替身也必须返回 Promise：同步返回 undefined 时，任何 .then() 都会立刻炸。
    resolveModelInfo: async () => undefined,
    // 契约要求 AsyncIterable：写成 async 函数会让 for await 立刻抛 TypeError，且被拒的 Promise
    // 无人接管，可能直接终止进程。不用 async function*：只抛错不 yield 会被 require-yield 拦下。
    stream: () => ({
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next: async (): Promise<IteratorResult<never>> => {
            throw new Error('dsh-pet standalone: 独立模式未接入模型（碎碎念/对话不可用）');
          },
        };
      },
    }),
  };
}
