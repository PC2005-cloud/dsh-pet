/**
 * 生成通道：把一次请求跑成文本增量序列，途中守住忙状态与额度上限。
 *
 * 不组装请求（归 ./request）、不定义限额（归 ./limits）、不管服务生命周期（归 ./create）。
 * 失败一律归一成固定文案：SDK 错误可能带地址、请求头或正文，只能进 cause 与日志。
 * 必须始终成立：同一时刻只有一个在途请求；返回或抛错前一定释放控制器并关闭传输。
 * @module dsh-pet/src/standalone/ai-provider/stream
 */
import { isAuthenticationFailure, isRateLimitFailure, sdkTextStream, type AiTransportEvent } from '../ai-transport.ts';
import { MAX_EVENTS, MAX_OUTPUT_CHARS } from './limits.ts';
import { abortable, parseRequest } from './request.ts';
import type { AiRuntime } from './types.ts';

/** 本层自己写的固定文案：只有这些能原样透出给调用方。 */
const OWN_MESSAGES: readonly string[] = [
  'Standalone AI could not answer this request.',
  'Standalone AI returned no text.',
  'Standalone AI response exceeds limits.',
];

/** 把传输层异常归一成可示人的错误；鉴权失败顺带置位暂停，等用户重新保存设置。 */
function normalizeFailure(runtime: AiRuntime, controller: AbortController, error: unknown): Error {
  if (isAuthenticationFailure(error)) {
    runtime.paused = true;
    runtime.logger.warn('Standalone AI authentication failed; save settings again to resume.');
    return new Error('Standalone AI authentication failed. Check credentials and save settings again.', {
      cause: error,
    });
  }
  if (controller.signal.aborted) {
    return new Error('Standalone AI request cancelled or timed out.', { cause: error });
  }
  if (isRateLimitFailure(error)) {
    return new Error('Standalone AI provider rate limit reached. Please wait.', { cause: error });
  }
  if (error instanceof Error && OWN_MESSAGES.includes(error.message)) return error;
  runtime.logger.warn('Standalone AI request failed.');
  return new Error('Standalone AI request failed. Check the endpoint and model settings.', { cause: error });
}

/**
 * 造生成函数。
 * @param runtime - 共享运行态（就绪判定、限流窗口、在途控制器）。
 * @returns 接受 DSH 请求对象、产出文本增量的异步序列。
 */
export function createTextStream(
  runtime: AiRuntime,
): (options: unknown) => AsyncIterable<{ type: 'text'; text: string }> {
  return async function* stream(options) {
    if (!runtime.ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = runtime.store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings.model);
    if (callerSignal?.aborted) throw new Error('Standalone AI request cancelled.');
    if (runtime.active) throw new Error('Standalone AI is busy. Please wait.');
    const controller = new AbortController();
    runtime.active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const iterator = sdkTextStream(settings, request, controller.signal, runtime.fetcher)[Symbol.asyncIterator]();
    let emitted = 0;
    let events = 0;
    try {
      while (true) {
        const part: IteratorResult<AiTransportEvent> = await abortable(iterator.next(), controller.signal);
        // 流式过程中设置可能被保存、服务也可能被释放，每次都重新确认。
        if (controller.signal.aborted || !runtime.ready()) throw new Error('Standalone AI request cancelled.');
        if (part.done) break;
        // 事件数也要有上限，防止对端用大量空块拖住进程。
        if (++events > MAX_EVENTS) throw new Error('Standalone AI response exceeds limits.');
        if (part.value.refusal) throw new Error('Standalone AI could not answer this request.');
        const text = part.value.text;
        if (!text) continue;
        emitted += text.length;
        if (emitted > MAX_OUTPUT_CHARS) throw new Error('Standalone AI response exceeds limits.');
        yield { type: 'text', text };
      }
      if (emitted === 0) throw new Error('Standalone AI returned no text.');
    } catch (error) {
      throw normalizeFailure(runtime, controller, error);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      controller.abort();
      if (runtime.active === controller) runtime.active = undefined;
      // return() 可能等待挂起的读取；只观察结果，绝不阻塞取消。
      void iterator.return?.().catch(() => runtime.logger.debug('Standalone AI transport closed.'));
    }
  };
}
