/**
 * 开关路由：`GET` 读当前状态、`POST` 翻转。
 *
 * 语音合成、语音识别与记忆各有一个开关，三者的路由行为完全一样、只有路径不同，
 * 所以这里按路径造 handler，不各写一份。
 * 存在的理由：注册在宿主（Node），按钮在页面——两半没有直接通道，只能由宿主开一个最小路由。
 * 只服务本示例，不进 dsh-pet 的接口面。
 * @module dsh-cordis-probe/toggle-route
 */

/** 语音合成开关的路径（与 dsh-pet 的 `/dsh-pet-7340` 并列，互不干扰）。 */
export const VOICE_ROUTE = '/cordis-probe-voice';
/** 语音识别开关的路径。 */
export const SPEECH_ROUTE = '/cordis-probe-speech';
/** 记忆开关的路径。 */
export const MEMORY_ROUTE = '/cordis-probe-memory';

/**
 * 造一个开关处理器。
 *
 * @param control - 读写开关的两个函数；`setOn` 返回生效后的状态。
 * @returns 可直接交给 `webServer.register` 的 handler。
 */
export function createToggleHandler(control) {
  /** 附加状态（如记忆的 capture 计数）；没实现就返回空对象。 */
  const extra = () => (typeof control.extra === 'function' ? control.extra() : {});
  return (req, res) => {
    if (req.method === 'GET') {
      respond(res, 200, { ok: true, on: control.isOn(), ...extra() });
      return;
    }
    if (req.method !== 'POST') {
      respond(res, 405, { ok: false, reason: 'method-not-allowed' });
      return;
    }
    // 不带请求体：点一次就是翻转一次，省掉解析与校验
    const on = control.setOn(!control.isOn());
    respond(res, 200, { ok: true, on, ...extra() });
  };
}

/** 写一个 JSON 响应。 */
function respond(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
