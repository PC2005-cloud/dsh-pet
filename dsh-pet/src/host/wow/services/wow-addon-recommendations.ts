import type {
  AddonRecommendationReport,
  AddonRecommendationRequest,
  AddonRecommendationSelection,
} from '../shared/wow-addon-recommendations';
import type { AddonFile, AddonMetadata, AddonSummary, AddonVersionType } from '../shared/wow-addons';
import type { CurseForgeCatalog } from './wow-addons-catalog';

import { randomUUID } from 'node:crypto';

import { errorMessageFrom } from './errors';
import { parse } from 'valibot';

import {
  addonRecommendationReportSchema,
  addonRecommendationRequestSchema,
  addonRecommendationSelectionSchema,
} from '../shared/wow-addon-recommendations';

const intents = [
  {
    match: /背包|物品栏|仓库|银行|\b(?:bags?|inventory|bank)\b/iu,
    slug: 'bags-inventory',
    words: ['bag', 'bags', 'inventory', 'bank'],
  },
  { match: /拍卖|金币|经济|\b(?:auction|economy)\b/iu, slug: 'auction-economy', words: ['auction', 'economy'] },
  {
    match: /增益|减益|光环|\b(?:buffs?|debuffs?|auras?)\b/iu,
    slug: 'buffs-debuffs',
    words: ['buff', 'buffs', 'debuff', 'debuffs', 'aura', 'auras'],
  },
  {
    match: /任务|练级|升级路线|\b(?:quests?|leveling)\b/iu,
    slug: 'quests-leveling',
    words: ['quest', 'quests', 'leveling'],
  },
  { match: /地图|小地图|\b(?:maps?|minimap)\b/iu, slug: 'map-minimap', words: ['map', 'maps', 'minimap'] },
  { match: /动作条|技能条|\baction bars?\b/iu, slug: 'action-bars', words: ['action', 'bar', 'bars'] },
  { match: /单位框体|头像|血条|\bunit frames?\b/iu, slug: 'unit-frames', words: ['unit', 'frame', 'frames'] },
  { match: /伤害统计|输出统计|\b(?:damage meter|dps meter)\b/iu, slug: 'combat', words: ['damage', 'meter', 'dps'] },
  {
    match: /首领|副本预警|\b(?:boss|raid warnings?)\b/iu,
    slug: 'raid-boss-encounters',
    words: ['boss', 'raid', 'warning', 'warnings'],
  },
  { match: /聊天|\bchat\b/iu, slug: 'chat-communication', words: ['chat', 'communication'] },
  { match: /鼠标提示|\btooltip\b/iu, slug: 'tooltip', words: ['tooltip'] },
  {
    match: /界面美化|皮肤|界面|\b(?:ui|artwork|skins?)\b/iu,
    slug: 'artwork',
    words: ['ui', 'artwork', 'skin', 'skins'],
  },
];

function searchPlan(query: string, metadata: AddonMetadata) {
  const normalized = query.trim().toLowerCase();
  const intent = intents.find((intent) => intent.match.test(normalized));
  const category = intent && metadata.categories.find((category) => category.slug === intent.slug);
  const tokens =
    normalized
      .match(/[a-z0-9]+/g)
      ?.filter((token) => !['wow', 'addon', 'addons', 'plugin', 'plugins', ...(intent?.words ?? [])].includes(token)) ??
    [];
  return { categoryId: category?.id, search: category ? '' : normalized, tokens, featureWords: intent?.words ?? [] };
}

function relevance(
  addon: AddonSummary,
  query: string,
  categoryId: number | undefined,
  tokens: string[],
  featureWords: string[],
) {
  const name = addon.name.toLowerCase();
  const summary = addon.summary.toLowerCase();
  let score = categoryId !== undefined && addon.categories.includes(categoryId) ? 100 : 0;
  if (query.toLowerCase().trim() === name) score += 1000;
  // Categories contain supporting utilities too. Prefer a project that names the requested feature.
  if (featureWords.some((word) => name.includes(word))) score += 60;
  else if (featureWords.some((word) => summary.includes(word))) score += 20;
  for (const token of tokens) score += name.includes(token) ? 40 : summary.includes(token) ? 10 : 0;
  return score;
}

/** Binds read-only recommendations to expiring, main-owned installation selections. */
export class WowAddonRecommendations {
  private readonly reports = new Map<string, AddonRecommendationReport>();

  private readonly catalog: Pick<CurseForgeCatalog, 'search' | 'getLatestCompatibleFiles'>;

  constructor(catalog: Pick<CurseForgeCatalog, 'search' | 'getLatestCompatibleFiles'>) {
    this.catalog = catalog;
  }

  async search(
    input: AddonRecommendationRequest,
    metadata: AddonMetadata,
    version: AddonVersionType,
  ): Promise<AddonRecommendationReport> {
    const request = parse(addonRecommendationRequestSchema, input);
    if (version.group !== request.game) throw new Error('curseforge-incompatible-version');
    const plan = searchPlan(request.query, metadata);
    const searches = await Promise.all(
      (['downloads', 'popular'] as const).map((sort) =>
        this.catalog.search({
          game: request.game,
          gameVersionTypeId: version.id,
          search: plan.search,
          categoryId: plan.categoryId,
          index: 0,
          sort,
        }),
      ),
    );
    const unique = new Map(searches.flatMap((search) => search.addons).map((addon) => [addon.id, addon]));
    const ranked = [...unique.values()]
      .filter((addon) => plan.categoryId === undefined || addon.categories.includes(plan.categoryId))
      .map((addon) => ({
        addon,
        relevance: relevance(addon, request.query, plan.categoryId, plan.tokens, plan.featureWords),
      }))
      .sort(
        (a, b) => b.relevance - a.relevance || b.addon.downloadCount - a.addon.downloadCount || a.addon.id - b.addon.id,
      )
      .slice(0, 20);
    const checked: Array<{ addon: AddonSummary; relevance: number; file: AddonFile }> = [];
    // Bound network work while checking authoritative file tags for each candidate.
    for (let index = 0; index < ranked.length && checked.length < 5; index += 4) {
      const batch = await Promise.all(
        ranked.slice(index, index + 4).map(async (candidate) => {
          try {
            const files = await this.catalog.getLatestCompatibleFiles(candidate.addon.id, version.id);
            const file = files.find((file) => file.releaseType === 1) ?? files.find((file) => file.releaseType === 2);
            return file ? { ...candidate, file } : undefined;
          } catch (error) {
            // A removed project cannot occupy a recommendation. Authentication and network failures remain visible.
            if (errorMessageFrom(error) === 'curseforge-not-found') return undefined;
            throw error;
          }
        }),
      );
      checked.push(...batch.filter((item): item is NonNullable<typeof item> => !!item));
    }
    const now = Date.now();
    const report = parse(addonRecommendationReportSchema, {
      kind: 'wow-addon-recommendations',
      version: 1,
      id: randomUUID(),
      game: request.game,
      query: request.query.trim(),
      versionTypeId: version.id,
      versionName: version.name,
      createdAt: now,
      expiresAt: now + 10 * 60_000,
      addons: checked.slice(0, 5).map(({ addon, relevance, file }) => {
        const unavailableReason = !addon.allowDistribution
          ? 'curseforge-distribution-disabled'
          : file.downloadUrl === null
            ? 'curseforge-download-unavailable'
            : !file.sha1 || file.fileLength <= 0 || file.fileLength > 100 * 1024 * 1024
              ? 'curseforge-download-integrity'
              : null;
        return {
          id: addon.id,
          name: addon.name,
          summary: addon.summary,
          websiteUrl: addon.websiteUrl,
          downloadCount: addon.downloadCount,
          relevance,
          fileId: file.id,
          fileVersion: file.displayName,
          gameVersions: file.gameVersions,
          installable: unavailableReason === null,
          unavailableReason,
        };
      }),
    });
    for (const [id, prior] of this.reports) {
      if (prior.expiresAt <= now || this.reports.size >= 20) this.reports.delete(id);
    }
    this.reports.set(report.id, report);
    return structuredClone(report);
  }

  /** Selects only a file returned in this session. Installation still rechecks configuration and live API metadata. */
  select(input: AddonRecommendationSelection) {
    const selection = parse(addonRecommendationSelectionSchema, input);
    const report = this.reports.get(selection.recommendationId);
    if (!report || report.expiresAt <= Date.now()) throw new Error('wow-addons-recommendation-expired');
    const addon = report.addons.find((addon) => addon.id === selection.modId);
    if (!addon) throw new Error('wow-addons-recommendation-invalid');
    if (!addon.installable) throw new Error(addon.unavailableReason ?? 'curseforge-download-unavailable');
    return { game: report.game, modId: addon.id, fileId: addon.fileId, versionTypeId: report.versionTypeId };
  }
}
