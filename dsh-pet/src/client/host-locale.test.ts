/**
 * 宿主语言上报：id 变化会再送一次，请求不写宠物配置。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { postHostLocale, watchHostLocale, type LocaleService } from './host-locale.ts';

describe('watchHostLocale', () => {
  test('启动送一次，id 变化再送一次，不写配置', () => {
    let current = 'zh';
    const listeners = new Set<() => void>();
    const sent: string[] = [];
    const locale: LocaleService = {
      id: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const stop = watchHostLocale(locale, (id) => sent.push(id));
    assert.deepEqual(sent, ['zh']);
    current = 'ru';
    for (const listener of listeners) listener();
    assert.deepEqual(sent, ['zh', 'ru']);
    current = 'ru';
    for (const listener of listeners) listener();
    assert.deepEqual(sent, ['zh', 'ru'], '同一个 id 不重复送');
    stop();
  });

  test('没有读取器时用设置字典的 localeId', () => {
    const dicts: Record<string, string> = { zh: 'zh', ru: 'ru' };
    const current = 'zh';
    const sent: string[] = [];
    const locale: LocaleService = {
      bind: () => (key) => (key === 'localeId' ? dicts[current] : key),
      subscribe: () => () => {},
    };
    watchHostLocale(locale, (id) => sent.push(id));
    assert.deepEqual(sent, ['zh']);
  });
});

describe('postHostLocale', () => {
  test('只 POST /locale，体里只有 id', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('{}', { status: 200 });
    };
    await postHostLocale('ru', fetchImpl);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.url.endsWith('/locale'), calls[0]?.url);
    assert.equal(calls[0]?.url.includes('/config'), false);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { id: 'ru' });
  });
});
