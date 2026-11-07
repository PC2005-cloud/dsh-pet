import type { InferOutput } from 'valibot';

import {
  array,
  boolean,
  check,
  finite,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  object,
  picklist,
  pipe,
  string,
} from 'valibot';

const id = pipe(number(), integer(), minValue(1), maxValue(2147483647));
const count = pipe(number(), finite(), minValue(0), maxValue(Number.MAX_SAFE_INTEGER));
const game = picklist(['retail', 'classic', 'forever']);
const text = (length: number) => pipe(string(), maxLength(length));
const projectUrl = pipe(
  text(2048),
  check((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        ['www.curseforge.com', 'curseforge.com'].includes(url.hostname) &&
        /^\/wow\/addons\/[a-z0-9-]+\/?$/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  }),
);

export const addonRecommendationRequestSchema = object({ game, query: pipe(text(128), minLength(1)) });
export type AddonRecommendationRequest = InferOutput<typeof addonRecommendationRequestSchema>;

export const addonRecommendationSelectionSchema = object({
  recommendationId: pipe(text(100), minLength(1)),
  modId: id,
});
export type AddonRecommendationSelection = InferOutput<typeof addonRecommendationSelectionSchema>;

/** Display data contains no credentials, download URLs, or authority to select a different installation file. */
export const addonRecommendationReportSchema = object({
  kind: literal('wow-addon-recommendations'),
  version: literal(1),
  id: pipe(text(100), minLength(1)),
  game,
  query: text(128),
  versionTypeId: id,
  versionName: text(256),
  createdAt: count,
  expiresAt: count,
  addons: pipe(
    array(
      object({
        id,
        name: text(512),
        summary: text(4096),
        websiteUrl: projectUrl,
        downloadCount: count,
        relevance: count,
        fileId: id,
        fileVersion: text(512),
        gameVersions: pipe(array(text(128)), maxLength(100)),
        installable: boolean(),
        unavailableReason: nullable(
          picklist([
            'curseforge-distribution-disabled',
            'curseforge-download-unavailable',
            'curseforge-download-integrity',
          ]),
        ),
      }),
    ),
    maxLength(5),
  ),
});
export type AddonRecommendationReport = InferOutput<typeof addonRecommendationReportSchema>;
export const WOW_ADDON_RECOMMENDATION_TOOL_NAME = 'wow_recommend_addons';
