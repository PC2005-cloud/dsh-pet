/**
 * 设置页整句替换：只有宿主语言是 ru 才把目录里的中文换成俄文，再切走时换回来。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { chromeText } from './chrome.ts';
import { chromeApplySource } from './swap.ts';

test('读到 ru 才替换整句，没有 locale 或换成别的语言时回到中文', async () => {
  const text = { nodeType: 3, nodeValue: '退出' };
  const attrs: Record<string, string> = { title: '保存' };
  const titled = {
    nodeType: 1,
    tagName: 'BUTTON',
    childNodes: [] as unknown[],
    children: [] as unknown[],
    textContent: '',
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute(name: string, value: string) {
      attrs[name] = value;
    },
  };
  const body = {
    nodeType: 1,
    tagName: 'BODY',
    childNodes: [text, titled],
    children: [] as unknown[],
    textContent: '',
    getAttribute: () => null,
    setAttribute() {},
  };
  const document = {
    body,
    documentElement: { lang: 'zh-CN' },
  };
  const run = async (snap: unknown): Promise<void> => {
    await runInNewContext(chromeApplySource() + '\nrefreshHostLocale();', {
      document,
      callApi: async () => snap,
    });
  };
  await run({ sections: {} });
  assert.equal(text.nodeValue, '退出');
  assert.equal(attrs.title, '保存');
  assert.equal(document.documentElement.lang, 'zh-CN');
  await run({ sections: { locale: { counter: 1, data: { id: 'ru' } } } });
  assert.equal(text.nodeValue, chromeText('ru', 'tray.quit'));
  assert.equal(attrs.title, chromeText('ru', 'page.save'));
  assert.equal(document.documentElement.lang, 'ru');
  await run({ sections: { locale: { counter: 2, data: { id: 'en' } } } });
  assert.equal(text.nodeValue, '退出');
  assert.equal(attrs.title, '保存');
  assert.equal(document.documentElement.lang, 'zh-CN');
});
