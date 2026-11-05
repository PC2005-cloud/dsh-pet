/** Model checks for guided setup. Provider response bodies never become user-facing errors. */
import type { MemoryModels } from './managed-memory.ts';

export const setupErrors: Record<string, string> = {
  chat_authentication: '聊天密钥验证失败。请检查 Key 是否有效，以及地址和 Key 是否属于同一地域。',
  chat_quota: '聊天服务额度或调用频率受限。请检查账户余额，稍后重试。',
  chat_not_found: '找不到聊天模型或接口。请检查模型名与接口地址。',
  chat_timeout: '聊天服务响应超时。请检查网络后重试。',
  chat_connection: '无法连接聊天服务。请检查接口地址、端口与网络。',
  chat_unknown: '聊天检查未通过。请检查模型、地址和密钥；原有配置保留。',
  chat_key_required: '请填写此聊天服务的 API 密钥。更换地址后不能沿用其他服务的密钥。',
  embedding_key_required: '请填写 Embedding 服务的密钥；只有相同地址才可复用聊天密钥。',
  embedding_authentication: 'Embedding 密钥验证失败。请检查它的 Key 与地域。',
  embedding_quota: 'Embedding 服务额度或调用频率受限。请检查账户后重试。',
  embedding_not_found: '找不到 Embedding 模型或接口。请展开高级选项检查，或填写另一家服务。',
  embedding_dimension: 'Embedding 返回的向量维度不匹配。请核对高级选项中的维度。',
  embedding_unavailable: 'Embedding 检查未通过。请检查接口是否支持所选模型与维度。',
  embedding_timeout: 'Embedding 服务响应超时。请检查网络后重试。',
  embedding_connection: '无法连接 Embedding 服务。请检查地址和网络。',
  embedding_change_requires_new_store: '已有记忆库的 Embedding 地址、模型和维度不能更换；请保留原值。密钥可以更新。',
  memory_already_owned: '另一个桌宠进程正在管理此记忆库，请从原来的桌宠窗口继续使用。',
  unsupported_platform: '此系统暂不支持自动安装，请在配置页连接已有 PowerContext 服务。',
  memory_not_ready: '记忆服务启动检查超时。请重试；如仍失败，请检查模型连接和本机环境。',
  memory_start_failed: '记忆服务已退出。请按已保存配置重试，记忆数据保留。',
  memory_port_in_use: '记忆服务端口已被占用。请退出占用程序后重试，原地址和记忆保留。',
  runtime_command_failed: '运行环境安装失败。请检查网络和磁盘空间后重试。',
  runtime_tool_missing: '缺少自动安装需要的 curl 或 tar。请安装后重试，或连接已有服务。',
  runtime_command_timeout: '下载或安装等待超时。请检查网络后重试，已保存的记忆保留。',
  download_checksum_failed: '下载校验未通过，未执行安装。请检查网络后重试。',
  invalid_setup: '请补全模型信息；自定义服务还需填写 Embedding 模型和维度。',
  setup_not_configured: '尚未保存记忆服务配置，请先完成上方设置。',
  invalid_memory_settings: '本机记忆配置无法读取，原文件保留。请检查本机配置后重试。',
  recovery_failed: '准备失败，恢复未完成。请检查本机配置和服务状态后重试。',
};

export function setupErrorMessage(error: unknown): string {
  return (
    setupErrors[error instanceof Error ? error.message : ''] ??
    '准备未完成。请检查网络、模型配置和磁盘空间后重试；已有记忆保留。'
  );
}

/** Compare the whole endpoint, not just its origin, before reusing a stored credential. */
export function sameModelEndpoint(left: string, right: string): boolean {
  return !!left && left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

export async function checkEmbedding(models: MemoryModels, signal: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(models.embeddingBaseUrl.replace(/\/+$/, '') + '/embeddings', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, timeout]),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + models.embeddingApiKey },
      body: JSON.stringify({
        model: models.embeddingModel,
        input: ['memory connection check'],
        dimensions: models.embeddingDimension,
        encoding_format: 'float',
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code =
        response.status === 401 || response.status === 403
          ? 'authentication'
          : response.status === 429
            ? 'quota'
            : response.status === 404
              ? 'not_found'
              : 'unavailable';
      throw new Error('embedding_' + code);
    }
    if (!response.body) throw new Error('embedding_unavailable');
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2_000_000) throw new Error('embedding_unavailable');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: { embedding?: unknown }[] };
    const vector = data.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.every((n) => typeof n === 'number' && Number.isFinite(n)))
      throw new Error('embedding_unavailable');
    if (vector.length !== models.embeddingDimension) throw new Error('embedding_dimension');
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error('embedding_timeout', { cause: error });
    if (error instanceof Error && setupErrors[error.message]) throw error;
    throw new Error('embedding_connection', { cause: error });
  }
}
