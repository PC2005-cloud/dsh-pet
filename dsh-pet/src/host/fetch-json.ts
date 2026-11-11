/**
 * 出站 JSON GET 的唯一入口：带超时与一次重试，非 2xx 与解析失败一律抛错。
 *
 * 天气与定位共用这里；余额那份自带 Bearer 头，不强行合并。
 * 始终成立：成功时返回已解析的 JSON 值；错误文案只带端点名与状态码，不带完整 URL 与响应体。
 * @module dsh-pet/src/host/fetch-json
 */

/** 单次请求超时（ms）：境外接口冷启动实测 3~6s，留足余量。 */
const TIMEOUT_MS = 15_000;
/** 失败重试次数：只补一次网络抖动，再多会把一次查询拖到半分钟。 */
const RETRIES = 1;
/** 重试前的等待（ms）。 */
const RETRY_DELAY_MS = 400;

/** 出站请求失败的分类。 */
export type FetchJsonErrorCode = 'timeout' | 'http-status' | 'bad-json' | 'network';

/** 抓取失败；`code` 供调用方分支，`message` 只含端点名与状态码。 */
export class FetchJsonError extends Error {
  /** 失败分类。 */
  // declare：只声明字段、不产出类字段代码。es2020 产物会把类字段降级成 defineProperty，
  // 进而拖出一条 `@oxc-project/runtime` 裸 import，装好的用户 import 插件时直接 ERR_MODULE_NOT_FOUND。
  declare readonly code: FetchJsonErrorCode;

  /**
   * @param code - 失败分类。
   * @param message - 给日志与用户看的一句话，不得含查询参数与响应体。
   * @param cause - 原始异常，便于排查。
   */
  constructor(code: FetchJsonErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'FetchJsonError';
    this.code = code;
  }
}

/** 一次抓取的依赖与参数。 */
export interface FetchJsonOptions {
  /** 端点名，只进错误文案（如 'ip-api'）。 */
  readonly label: string;
  /** 注入的 fetch；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 注入的等待；缺省用 setTimeout。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 单次超时（ms）；缺省 {@link TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
}

/**
 * 抓一个 JSON 端点。
 *
 * 重试只发生在超时与网络错误上：4xx/5xx 是明确答复，重试只会白等一次。
 * @param url - 完整地址（含查询参数）。
 * @param options - 端点名与可注入依赖。
 * @returns 解析后的 JSON 值；类型为 unknown，字段校验交给调用方。
 * @throws {FetchJsonError} 超时、非 2xx、响应不是 JSON 或网络失败时。
 */
export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delayOf;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let last: FetchJsonError | undefined;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await fetchOnce(fetchImpl, url, timeoutMs, options.label);
    } catch (e) {
      last = e instanceof FetchJsonError ? e : new FetchJsonError('network', options.label + ' 请求失败', e);
      if (last.code === 'http-status' || attempt === RETRIES) break;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw last ?? new FetchJsonError('network', options.label + ' 请求失败');
}

/** 单次抓取：把超时、状态码与解析失败归成三类。 */
async function fetchOnce(fetchImpl: typeof fetch, url: string, timeoutMs: number, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-pet' },
    });
  } catch (e) {
    // AbortSignal.timeout 抛出的异常 name 是 TimeoutError；其余（断网、DNS）都算网络错误
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new FetchJsonError(timedOut ? 'timeout' : 'network', label + (timedOut ? ' 请求超时' : ' 请求失败'), e);
  }
  if (!response.ok) throw new FetchJsonError('http-status', label + ' 返回 HTTP ' + response.status);
  try {
    return await response.json();
  } catch (e) {
    throw new FetchJsonError('bad-json', label + ' 返回的不是 JSON', e);
  }
}

/** 缺省等待实现。 */
function delayOf(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
