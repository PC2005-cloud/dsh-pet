/** 从新鲜像素桥观测绘制归一化坐标图示，缺失坐标不推断地形或路线。 */
import { object, text, type JsonObject } from './api.ts';
import { el, type PanelContext } from './dom.ts';

/** 真实在线观测的有效坐标，保留地图边界上的零坐标。 */
export function currentPosition(bridge: JsonObject, error: unknown): { x: number; y: number } | null {
  const snapshot = object(bridge.snapshot);
  if (
    error ||
    bridge.error ||
    bridge.status !== 'live' ||
    bridge.source !== 'screen' ||
    !snapshot.online ||
    !snapshot.map ||
    typeof bridge.ageSeconds !== 'number' ||
    !Number.isFinite(bridge.ageSeconds) ||
    bridge.ageSeconds < 0 ||
    bridge.ageSeconds > 5
  )
    return null;
  const { px, py } = snapshot;
  return typeof px === 'number' &&
    typeof py === 'number' &&
    Number.isFinite(px) &&
    Number.isFinite(py) &&
    px >= 0 &&
    px <= 10000 &&
    py >= 0 &&
    py <= 10000
    ? { x: px / 100, y: py / 100 }
    : null;
}

/** 绘制带横纵轴与当前位置标记的坐标网格，使用 SVG 属性以兼容设置页 CSP。 */
export function mapDiagram(ctx: PanelContext, bridge: JsonObject, error: unknown): HTMLElement {
  const { t } = ctx;
  const result = el('div', '', 'dsh-wow-output');
  const snapshot = object(bridge.snapshot);
  result.append(el('p', t('坐标图示（不是地形底图）', 'Coordinate diagram (no terrain map)'), 'dsh-wow-hint'));
  const point = currentPosition(bridge, error);
  if (!point) {
    result.append(
      el(
        'p',
        t(
          '等待 5 秒内的真实在线地图坐标；断线、演示和缺失坐标不显示当前位置。',
          'Waiting for live map coordinates less than 5 seconds old. Disconnected, demo and missing data do not show a current position.',
        ),
        'dsh-wow-hint',
      ),
    );
    return result;
  }
  const svg = shape('svg', {
    viewBox: '-10 -10 125 125',
    role: 'img',
    'aria-label': `${text(snapshot.zone)} · ${text(snapshot.map)} · X ${point.x.toFixed(2)}%, Y ${point.y.toFixed(2)}%`,
    class: 'dsh-wow-map',
  });
  for (let coordinate = 0; coordinate <= 100; coordinate += 25) {
    svg.append(
      shape('line', { x1: coordinate, y1: 0, x2: coordinate, y2: 100 }),
      shape('line', { x1: 0, y1: coordinate, x2: 100, y2: coordinate }),
    );
  }
  svg.append(shape('circle', { cx: point.x, cy: point.y, r: 2.2, class: 'dsh-wow-map-point' }));
  for (const [x, y, label] of [
    [0, -3, '0'],
    [94, -3, '100% X'],
    [102, 100, 'Y 100%'],
  ] as const) {
    const mark = shape('text', { x, y });
    mark.textContent = label;
    svg.append(mark);
  }
  result.append(svg);
  return result;
}

/** SVG 文本只经 textContent 写入，数值与枚举经属性写入。 */
function shape<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const result = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, String(value));
  return result;
}
