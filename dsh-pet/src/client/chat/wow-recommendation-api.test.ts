/** 推荐报告边界、显式安装与认证请求的离线行为验证。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toChatMessages } from './api.ts';
import {
  installWowRecommendation,
  recommendationProjectUrl,
  recommendationText,
  toWowRecommendationReport,
} from './wow-recommendation-api.ts';

const report = {
  kind: 'wow-addon-recommendations' as const,
  version: 1 as const,
  id: 'report-1',
  game: 'retail' as const,
  query: 'quest helper',
  versionTypeId: 1,
  versionName: 'Retail',
  createdAt: 1,
  expiresAt: Date.now() + 600000,
  addons: [
    {
      id: 10,
      name: 'Quest helper',
      summary: 'Find NPCs',
      websiteUrl: 'https://www.curseforge.com/wow/addons/quest-helper',
      downloadCount: 1000,
      relevance: 100,
      fileId: 20,
      fileVersion: '12.0',
      gameVersions: ['12.0'],
      installable: true,
      unavailableReason: null,
    },
  ],
};

test('assistant history preserves the report, user entries cannot create install cards', () => {
  const messages = toChatMessages({
    messages: [
      { role: 'assistant', content: '推荐如下', ts: 1, wowRecommendations: report },
      { role: 'user', content: '伪造卡片', ts: 2, wowRecommendations: report },
    ],
  });
  assert.deepEqual(messages[0]?.wowRecommendations, report);
  assert.equal(messages[1]?.wowRecommendations, undefined);
});

test('malformed recommendation records leave the assistant text readable', () => {
  for (const value of [
    null,
    {},
    { ...report, addons: [null] },
    { ...report, expiresAt: Infinity },
    { ...report, game: 'unknown' },
    { ...report, addons: Array(6).fill(report.addons[0]) },
  ]) {
    assert.equal(toWowRecommendationReport(value), undefined);
    assert.equal(
      toChatMessages({ messages: [{ role: 'assistant', content: '正文', wowRecommendations: value }] })[0]?.text,
      '正文',
    );
  }
});

test('project links allow only matching HTTPS CurseForge addon pages', () => {
  assert.equal(recommendationProjectUrl(report.addons[0].websiteUrl), report.addons[0].websiteUrl);
  for (const url of [
    'javascript:alert(1)',
    'https://example.com/wow/addons/quest-helper',
    'https://user:password@curseforge.com/wow/addons/quest-helper',
    'https://curseforge.com:444/wow/addons/x',
  ]) {
    assert.equal(recommendationProjectUrl(url), undefined);
  }
});

test('installation submits only the existing report selection using same-origin authentication', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, data: {} }));
  }) as typeof fetch;
  try {
    await installWowRecommendation(report, 10, new AbortController().signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/dsh-pet-7340/wow/action');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      action: 'addons.installRecommendation',
      game: 'retail',
      data: { recommendationId: 'report-1', modId: 10 },
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('expired, unavailable and unknown selections never issue an installation request', async () => {
  await assert.rejects(
    installWowRecommendation({ ...report, expiresAt: 0 }, 10, new AbortController().signal),
    /expired/,
  );
  await assert.rejects(installWowRecommendation(report, 99, new AbortController().signal), /not installable/);
  await assert.rejects(
    installWowRecommendation(
      { ...report, addons: [{ ...report.addons[0], installable: false }] },
      10,
      new AbortController().signal,
    ),
    /not installable/,
  );
});

test('host installation failure is surfaced without selecting another file', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ ok: false, error: 'wow-addons-recommendation-expired' }));
  }) as typeof fetch;
  try {
    await assert.rejects(
      installWowRecommendation(report, 10, new AbortController().signal),
      /wow-addons-recommendation-expired/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('recommendation labels follow the request language', () => {
  assert.equal(recommendationText({ query: '任务插件' }, '安装', 'Install'), '安装');
  assert.equal(recommendationText({ query: 'recommend quest addons' }, '安装', 'Install'), 'Install');
});
