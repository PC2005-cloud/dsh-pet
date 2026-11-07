/** 聊天推荐报告的显示边界与显式安装请求，不参与搜索或文件选择。 */
import type { AddonRecommendationReport } from '../../host/wow/shared/wow-addon-recommendations.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';
import { object, text } from '../../shared/wow-panel/api.ts';

/** 推荐卡优先跟随请求语言，极短无语言输入才参考浏览器偏好。 */
export function recommendationText(report: Pick<AddonRecommendationReport, 'query'>, zh: string, en: string): string {
  const chinese =
    /\p{Script=Han}/u.test(report.query) ||
    (!/[a-z]{2,}/i.test(report.query) && typeof navigator !== 'undefined' && navigator.language.startsWith('zh'));
  return chinese ? zh : en;
}

/** 只允许报告中官方 CurseForge 项目链接，避免旧历史携带可执行链接。 */
export function recommendationProjectUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['www.curseforge.com', 'curseforge.com'].includes(url.hostname) &&
      /^\/wow\/addons\/[a-z0-9-]+\/?$/i.test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** 从旧版或损坏历史安全读取报告；坏报告不会影响普通消息。 */
export function toWowRecommendationReport(value: unknown): AddonRecommendationReport | undefined {
  const report = object(value);
  if (
    report.kind !== 'wow-addon-recommendations' ||
    report.version !== 1 ||
    !boundedString(report.id, 100, true) ||
    !['retail', 'classic', 'forever'].includes(text(report.game)) ||
    !boundedString(report.query, 128) ||
    !boundedString(report.versionName, 256) ||
    !positiveId(report.versionTypeId) ||
    !count(report.createdAt) ||
    !count(report.expiresAt) ||
    !Array.isArray(report.addons) ||
    report.addons.length > 5
  )
    return undefined;
  const addons = report.addons.map(toAddon);
  if (addons.some((addon) => addon === undefined)) return undefined;
  return {
    kind: 'wow-addon-recommendations',
    version: 1,
    id: report.id as string,
    game: report.game as AddonRecommendationReport['game'],
    query: report.query as string,
    versionName: report.versionName as string,
    versionTypeId: report.versionTypeId as number,
    createdAt: report.createdAt as number,
    expiresAt: report.expiresAt as number,
    addons: addons as AddonRecommendationReport['addons'],
  };
}

/** 安装只提交报告标识与项目标识，最终文件及有效期由宿主决定。 */
export async function installWowRecommendation(
  report: AddonRecommendationReport,
  modId: number,
  signal: AbortSignal,
): Promise<void> {
  const addon = report.addons.find((item) => item.id === modId);
  if (!addon?.installable)
    throw new Error(recommendationText(report, '该推荐当前不可安装。', 'This recommendation is not installable.'));
  if (report.expiresAt <= Date.now())
    throw new Error(
      recommendationText(
        report,
        '推荐已过期，请重新请求推荐。',
        'This recommendation expired. Ask for new recommendations.',
      ),
    );
  const response = await fetch(ROUTE_PATH + '/wow/action', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'addons.installRecommendation',
      game: report.game,
      data: { recommendationId: report.id, modId },
    }),
  });
  const result = object(await response.json().catch(() => null));
  if (!response.ok || result.ok !== true) {
    throw new Error(text(result.error ?? result.message ?? result.code, `HTTP ${response.status}`));
  }
}

/** 收紧仅供显示的项目字段，网址非法时仅隐藏链接。 */
function toAddon(value: unknown): AddonRecommendationReport['addons'][number] | undefined {
  const addon = object(value);
  if (
    !positiveId(addon.id) ||
    !positiveId(addon.fileId) ||
    !boundedString(addon.name, 512) ||
    !boundedString(addon.summary, 4096) ||
    !boundedString(addon.fileVersion, 512) ||
    !count(addon.downloadCount) ||
    !count(addon.relevance) ||
    typeof addon.installable !== 'boolean' ||
    !Array.isArray(addon.gameVersions) ||
    addon.gameVersions.length > 100 ||
    !addon.gameVersions.every((version) => boundedString(version, 128)) ||
    !(
      addon.unavailableReason === null ||
      ['curseforge-distribution-disabled', 'curseforge-download-unavailable', 'curseforge-download-integrity'].includes(
        text(addon.unavailableReason),
      )
    )
  )
    return undefined;
  return {
    id: addon.id as number,
    fileId: addon.fileId as number,
    name: addon.name as string,
    summary: addon.summary as string,
    fileVersion: addon.fileVersion as string,
    websiteUrl: recommendationProjectUrl(addon.websiteUrl) ?? '',
    downloadCount: addon.downloadCount as number,
    relevance: addon.relevance as number,
    gameVersions: addon.gameVersions as string[],
    installable: addon.installable,
    unavailableReason: addon.unavailableReason as AddonRecommendationReport['addons'][number]['unavailableReason'],
  };
}

function boundedString(value: unknown, max: number, nonempty = false): boolean {
  return typeof value === 'string' && value.length <= max && (!nonempty || value.length > 0);
}

function count(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function positiveId(value: unknown): boolean {
  return count(value) && Number.isInteger(value) && (value as number) > 0 && (value as number) <= 2147483647;
}
