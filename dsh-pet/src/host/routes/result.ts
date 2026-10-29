/**
 * 路由应答的两种结论：业务失败一律 200，协议失败保留真实状态码，体永远是同一个实体。
 *
 * 「请求进了处理器」之后的判断（缺参、未知宠物、被占用、生成失败）是业务结论，用 {@link failResult}；
 * 请求没进业务（方法不对、JSON 坏了、体超限）用 {@link methodNotAllowed} 一类的协议构造器。
 * 不判断业务、不解析输入：只把 reason 与文案包成 RouteResult，状态码由结论类型决定。
 * @module dsh-pet/src/host/routes/result
 */
import type { RouteResult } from '../http.ts';

/**
 * 失败原因（wire 词汇）：域层各自的窄联合必须能赋值到这里。
 * 新增取值等同接口变更——消费方按 reason 分支，漏处理会拿到未命中的分支。
 */
export type ResultReason =
  | 'bad-request'
  | 'generate-error'
  | 'internal-error'
  | 'invalid-json'
  | 'invalid-label'
  | 'invalid-labels'
  | 'invalid-owner'
  | 'invalid-target'
  | 'lock-lost'
  | 'lock-required'
  | 'locked'
  | 'method-not-allowed'
  | 'payload-too-large'
  | 'pet-not-displayed'
  | 'pet-required'
  | 'pose-unavailable'
  | 'provider-missing'
  | 'todo-not-found'
  | 'too-many-items'
  | 'too-many-owners'
  | 'unknown-animation'
  | 'unknown-entry'
  | 'unknown-image'
  | 'unknown-owner'
  | 'unknown-pet'
  | 'unknown-playback'
  | 'unsupported'
  | 'user-config-unparsable'
  | 'voice-busy';

/** 失败实体：状态码不参与判断，200 与 4xx 共用这个形状。 */
export interface FailureEntity {
  readonly ok: false;
  readonly reason: ResultReason;
  readonly message: string;
}

/**
 * 构造失败实体。
 *
 * @param reason - 失败原因，由处理器决定，不接受从状态码反推。
 * @param message - 给人看的说明。
 * @param extra - 附加字段（如 `cause`、`needConfirm`）；不能覆盖 `ok`/`reason`/`message`。
 */
export function failureBody(reason: ResultReason, message: string, extra?: Record<string, unknown>): FailureEntity {
  return { ...extra, ok: false, reason, message } as FailureEntity;
}

/** 成功应答：状态码 200，响应体就是结果本身（不包一层 data）。 */
export function okResult(obj: unknown = {}, headers?: Record<string, string>): RouteResult {
  return { kind: 'json', status: 200, obj, headers };
}

/**
 * 业务失败：请求已进到处理器并给出了结论，一律 200 + 失败实体。
 *
 * @param reason - 失败原因，由处理器决定，不接受从状态码反推。
 * @param message - 给人看的说明。
 * @param extra - 附加字段（如 `cause`、`needConfirm`）；不能覆盖 `ok`/`reason`/`message`。
 */
export function failResult(reason: ResultReason, message: string, extra?: Record<string, unknown>): RouteResult {
  return { kind: 'json', status: 200, obj: failureBody(reason, message, extra) };
}

/** 请求体不是合法 JSON：400。 */
export function invalidJson(message = 'invalid JSON body'): RouteResult {
  return rejected(400, 'invalid-json', message);
}

/** 该路径不接受这个方法：405。 */
export function methodNotAllowed(message = 'method not allowed'): RouteResult {
  return rejected(405, 'method-not-allowed', message);
}

/** 请求体超过上限：413。 */
export function payloadTooLarge(message = 'request body too large'): RouteResult {
  return rejected(413, 'payload-too-large', message);
}

/** 未预期异常：500。文案固定，真实原因只进日志，不外泄路径与内部细节。 */
export function internalError(): RouteResult {
  return rejected(500, 'internal-error', 'dsh-pet: internal error');
}

/** 协议失败：真实状态码 + 与业务失败同一形状的体。 */
function rejected(status: number, reason: ResultReason, message: string): RouteResult {
  return { kind: 'json', status, obj: failureBody(reason, message) };
}
