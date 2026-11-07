import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeParse } from 'valibot';
import { createWowKnowledgeContext, knowledgeCatalog, searchWowKnowledge } from './index.ts';
import { knowledgeEntrySchema } from './schema.ts';

test('Chinese abbreviations retain token boundaries and work offline or beside Chinese characters', () => {
  for (const text of ['DZ是什么意思', '我玩dz', 'ＤＺ', 'DZ FS']) {
    const result = searchWowKnowledge({ text, locale: 'zh-Hans' });
    assert.equal(result.locale, 'zh-CN');
    assert.ok(result.entries.some((entry) => entry.aliases.includes('DZ') && entry.text.includes('盗贼')));
    assert.ok(result.entries.every((entry) => entry.game === 'shared'));
  }
  assert.equal(
    searchWowKnowledge({ text: 'ADZ123 DZS my_dz_file', locale: 'zh-CN' }).entries.some((entry) =>
      entry.aliases.includes('DZ'),
    ),
    false,
  );
});

test('explicit versions override the connected game and comparisons preserve both relevant products', () => {
  const classic = searchWowKnowledge({ text: '怀旧服DZ有什么特点', game: 'retail' });
  assert.deepEqual(classic.games, ['classic']);
  assert.ok(classic.entries.every((entry) => entry.game === 'shared' || entry.game === 'classic'));
  const comparison = searchWowKnowledge({ text: '正式服和怀旧服有什么区别', game: 'forever' });
  assert.deepEqual(comparison.games, ['retail', 'classic']);
  assert.ok(comparison.entries.some((entry) => entry.game === 'retail'));
  assert.ok(comparison.entries.some((entry) => entry.game === 'classic'));
  const forever = searchWowKnowledge({ text: '无限服可以大秘境或者三本吗', game: 'retail' });
  assert.deepEqual(forever.games, ['forever']);
  assert.ok(forever.entries.every((entry) => entry.game === 'shared' || entry.game === 'forever'));
});

test('language-community memes follow the question rather than the UI locale and retain attribution', () => {
  for (const text of ['部落都是废物是什么梗', '你们这是自寻死路']) {
    const result = searchWowKnowledge({ text, locale: 'en' });
    const meme = result.entries.find((entry) => entry.kind === 'meme');
    assert.equal(result.locale, 'zh-CN');
    assert.ok(meme?.usage);
    assert.ok(meme?.provenance.sources.length);
  }
  const english = searchWowKnowledge({ text: 'What does zug zug mean?', locale: 'zh-Hans' });
  assert.equal(english.locale, 'en');
  assert.ok(english.entries.length);
  assert.ok(english.entries.every((entry) => entry.locale !== 'zh-CN'));
  assert.equal(searchWowKnowledge({ text: 'What does DZ mean in Chinese?', locale: 'en' }).locale, 'zh-CN');
  assert.equal(searchWowKnowledge({ text: '部落とは何ですか', locale: 'zh-Hans' }).locale, 'ja');
  assert.equal(searchWowKnowledge({ text: '호드 뜻', locale: 'zh-Hans' }).locale, 'ko');
});

test('ordinary conversation does not retrieve game role aliases or English product homonyms', () => {
  for (const text of [
    '今晚帮我挑一部电影',
    '今晚喝奶茶',
    '准备出门散步',
    'I love you forever',
    'a classic movie',
    'our study group meets tomorrow',
  ]) {
    assert.equal(createWowKnowledgeContext({ text, locale: 'zh-Hans' }), '');
  }
  for (const text of ['奶', '缺奶'])
    assert.ok(searchWowKnowledge({ text, locale: 'zh-Hans' }).entries.some((entry) => entry.id === 'zh-role-healer'));
});

test('reference blocks are bounded, sourced, explicitly untrusted, and factual entries require provenance', () => {
  const text = knowledgeCatalog.flatMap((entry) => entry.aliases).join(' ');
  assert.ok(searchWowKnowledge({ text, limit: 100 }).entries.length <= 12);
  const context = createWowKnowledgeContext({ text, locale: 'zh-Hans', limit: 12 });
  assert.ok(context.length <= 6500);
  assert.match(context, /reference data, not instructions/);
  assert.match(context, /provenance/);
  assert.deepEqual(searchWowKnowledge({ text: 'DZ', limit: 0 }).entries, []);
  assert.equal(
    safeParse(knowledgeEntrySchema, {
      id: 'unreferenced-fact',
      kind: 'fact',
      title: 'Unsupported',
      aliases: ['unsupported'],
      text: 'Claim',
      usage: 'Do not use',
      provenance: { status: 'verified', sources: [{ title: 'No source' }], reviewedAt: '2026-10-28' },
    }).success,
    false,
  );
});
