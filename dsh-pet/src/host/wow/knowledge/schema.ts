import type { InferOutput } from 'valibot';

import { array, check, maxLength, minLength, optional, picklist, pipe, regex, strictObject, string } from 'valibot';

const text = pipe(string(), minLength(1), maxLength(2000));

/** Curated reference data. Provenance describes evidence, not a claim that community usage is official. */
export const knowledgeEntrySchema = pipe(
  strictObject({
    id: pipe(string(), regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
    kind: picklist(['fact', 'abbreviation', 'meme']),
    title: text,
    aliases: pipe(array(pipe(string(), minLength(1), maxLength(100))), minLength(1)),
    text,
    usage: text,
    tags: optional(array(pipe(string(), minLength(2), maxLength(100))), []),
    provenance: strictObject({
      status: picklist(['verified', 'community', 'user-example', 'project']),
      sources: pipe(
        array(
          strictObject({
            title: text,
            url: optional(pipe(string(), regex(/^https:\/\//))),
            path: optional(text),
          }),
        ),
        minLength(1),
      ),
      reviewedAt: pipe(string(), regex(/^\d{4}-\d{2}-\d{2}$/)),
    }),
  }),
  check(
    (entry) =>
      entry.provenance.status === 'user-example' ||
      entry.provenance.sources.every((source) => source.url || source.path),
    'References need a URL or repository path.',
  ),
);

export type KnowledgeEntry = InferOutput<typeof knowledgeEntrySchema>;
export type KnowledgeGame = 'retail' | 'forever' | 'classic';
export type KnowledgeLocale = 'und' | 'zh-CN' | 'en';

/** A source file declares scope once. Shared entries apply across versions without copying their text. */
export interface KnowledgeRecord extends KnowledgeEntry {
  game: KnowledgeGame | 'shared';
  locale: KnowledgeLocale;
}

/** Explicit game names in text take precedence over the observed game. Unknown games use shared records only. */
export interface KnowledgeQuery {
  text: string;
  game?: KnowledgeGame;
  /** Message language takes precedence. This locale resolves short inputs such as DZ. */
  locale?: string;
  /** Maximum returned records. @default 6 */
  limit?: number;
}

export interface KnowledgeMatch extends KnowledgeRecord {
  matchedAliases: string[];
}
