import type { KnowledgeGame, KnowledgeLocale, KnowledgeRecord } from './schema.ts';

import { array, parse } from 'valibot';

import classicGeneral from './data/classic/general.json' with { type: 'json' };
import classicChinese from './data/classic/locales/zh-CN.json' with { type: 'json' };
import foreverGeneral from './data/forever/general.json' with { type: 'json' };
import retailGeneral from './data/retail/general.json' with { type: 'json' };
import retailChinese from './data/retail/locales/zh-CN.json' with { type: 'json' };
import sharedGeneral from './data/shared/general.json' with { type: 'json' };
import sharedEnglish from './data/shared/locales/en.json' with { type: 'json' };
import sharedChinese from './data/shared/locales/zh-CN.json' with { type: 'json' };

import { knowledgeEntrySchema } from './schema.ts';

const bundles: { game: KnowledgeGame | 'shared'; locale: KnowledgeLocale; entries: unknown }[] = [
  { game: 'shared', locale: 'und', entries: sharedGeneral },
  { game: 'shared', locale: 'zh-CN', entries: sharedChinese },
  { game: 'shared', locale: 'en', entries: sharedEnglish },
  { game: 'retail', locale: 'und', entries: retailGeneral },
  { game: 'retail', locale: 'zh-CN', entries: retailChinese },
  { game: 'forever', locale: 'und', entries: foreverGeneral },
  { game: 'classic', locale: 'und', entries: classicGeneral },
  { game: 'classic', locale: 'zh-CN', entries: classicChinese },
];

/** Bundled, validated records. This catalog performs no network, filesystem, or model calls. */
export const knowledgeCatalog: readonly KnowledgeRecord[] = bundles.flatMap(({ game, locale, entries }) =>
  parse(array(knowledgeEntrySchema), entries).map((entry) => ({ ...entry, game, locale })),
);

const ids = new Set<string>();
for (const entry of knowledgeCatalog) {
  if (ids.has(entry.id)) throw new Error(`Duplicate Warcraft knowledge ID: ${entry.id}`);
  ids.add(entry.id);
}
