/**
 * cookie 请求头占用的换算与分级：条数 → 字节 → 百分比 → 提醒文案。
 *
 * 一条登录 cookie 在请求头里占「名字 + '=' + 值 + '; '」共 228 字节，而 Node 默认的
 * `maxHeaderSize` 是 16384 字节——所以第 72 条写进去，Host 的根请求就被 431 挡掉，
 * 桌面表现为启动时自检失败。这里只有纯计算，不读盘、不发请求。
 * @module dsh-pet/src/host/cookie/gauge
 */

/** 一条登录 cookie 在请求头里的实际字节数（含分隔用的 `; `）。 */
export const BYTES_PER_COOKIE = 228;
/** Node 默认的请求头上限；顶到它就是 431。 */
export const MAX_HEADER_BYTES = 16384;
/** 开始提醒的条数（约 50%）。 */
export const WARN_COUNT = 36;
/** 临界条数：再攒一条就越过 16384。 */
export const DANGER_COUNT = 71;

/** 提醒档位：越往上越该清理。 */
export type CookieLevel = 'ok' | 'warn' | 'danger';

/** 一次换算的结果：条数对应的占用、余量与档位。 */
export interface CookieGauge {
  /** cookie 库里的 `dsh-auth-*` 条数。 */
  readonly count: number;
  /** 这些 cookie 在请求头里占的字节数。 */
  readonly bytes: number;
  /** 占用百分比，四舍五入后夹在 0–100（库可能被外部改坏，不让负数与 NaN 传到界面）。 */
  readonly percent: number;
  /** 还能再启动几次；到临界后为 0。 */
  readonly remainingLaunches: number;
  /** 档位，决定气泡措辞。 */
  readonly level: CookieLevel;
}

/**
 * 把条数换算成占用与档位。
 * @param count - 探测到的条数；非有限数按 0 处理。
 * @returns 各字段都是有限非负值的换算结果。
 */
export function gaugeOf(count: number): CookieGauge {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const bytes = safe * BYTES_PER_COOKIE;
  const percent = Math.min(100, Math.round((bytes / MAX_HEADER_BYTES) * 100));
  return {
    count: safe,
    bytes,
    percent,
    remainingLaunches: Math.max(0, DANGER_COUNT - safe),
    level: safe >= DANGER_COUNT ? 'danger' : safe >= WARN_COUNT ? 'warn' : 'ok',
  };
}

/**
 * 给这个档位配一句气泡文案。
 *
 * danger 档没有「还能再开几次」：余量在 71 条时就是 0，再启动那一次正好写下第 72 条，
 * 所以这里只说「到了边缘」或「已经超了」，不给一个会让人误以为还有安全次数的数字。
 * @param gauge - {@link gaugeOf} 的结果。
 * @returns 一行中文提示，已含条数与百分比。
 */
export function cookieBubbleText(gauge: CookieGauge): string {
  if (gauge.level === 'danger') {
    if (gauge.count > DANGER_COUNT) {
      return `cookie 已经攒到 ${gauge.count} 条，请求头超过上限，下次启动 DSH 很可能打不开，得清理了`;
    }
    return `cookie ${gauge.count} 条，请求头占了 ${gauge.percent}%，已经到边缘了，再启动一次 DSH 就可能打不开`;
  }
  if (gauge.level === 'warn') {
    return `cookie ${gauge.count} 条，请求头占了 ${gauge.percent}%，快到上限了，记得清一下`;
  }
  return `cookie ${gauge.count} 条，请求头占了 ${gauge.percent}%，还能再开 ${gauge.remainingLaunches} 次`;
}
