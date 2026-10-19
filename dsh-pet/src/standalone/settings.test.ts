import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSettings, publicSettings } from './settings.ts';
import { settingsPage, settingsScript, settingsStyle } from './settings-page.ts';

test('settings validation accepts explicit costs and write-only blank/clear key semantics', () => {
  const input = {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model',
    apiKey: '',
    enabled: false,
    automaticWhispers: false,
    whisperIntervalSec: 300,
    maxTokens: 512,
  };
  assert.deepEqual(validateSettings(input), input);
  assert.deepEqual(validateSettings({ clearApiKey: true }), { clearApiKey: true });
  for (const input of [
    null,
    [],
    { protocol: 'other' },
    { enabled: 'true' },
    { whisperIntervalSec: 59 },
    { whisperIntervalSec: 1.5 },
    { maxTokens: 99999 },
    { apiKey: 123 },
    { hasKey: true },
    { baseUrl: 'file:///a' },
    { baseUrl: 'https://user:secret@example.test/v1' },
    { baseUrl: 'https://example.test/?key=secret' },
  ]) {
    assert.throws(() => validateSettings(input), Error, JSON.stringify(input));
  }
});
test('public settings are an allowlist even if backend accidentally includes credentials', () => {
  const actual = publicSettings({
    protocol: 'anthropic',
    apiKey: 'never expose',
    token: 'never expose',
    hasKey: true,
    model: 'x',
    enabled: false,
  });
  assert.deepEqual(actual, { protocol: 'anthropic', hasKey: true, model: 'x', enabled: false });
  assert.equal(JSON.stringify(actual).includes('never expose'), false);
});
test('settings shell is accessible, self contained, and never saves browser secrets', () => {
  assert.match(settingsPage, /lang="zh-CN"/);
  assert.match(settingsPage, /type="password"/);
  assert.match(settingsPage, /aria-live="polite"/);
  assert.match(settingsPage, /automaticWhispers/);
  assert.match(settingsPage, /费用/);
  assert.match(settingsPage, /min="60"/);
  assert.match(settingsScript, /history\.replaceState/);
  assert.match(settingsScript, /X-DSH-Pet-Token/);
  assert.doesNotMatch(settingsScript, /localStorage|sessionStorage|document\.cookie|innerHTML/);
  assert.doesNotMatch(settingsPage, /https?:\/\/(?!example)/);
  assert.match(settingsStyle, /focus-visible/);
});

test('settings browser script strips fragment, keeps key write-only and explicitly clears without AI requests', async () => {
  const { runInNewContext } = await import('node:vm');
  type Element = {
    value: string;
    checked: boolean;
    disabled: boolean;
    textContent: string;
    dataset: Record<string, string>;
    listeners: Record<string, (event?: unknown) => Promise<void> | void>;
    addEventListener: (name: string, fn: (event?: unknown) => Promise<void> | void) => void;
    reportValidity: () => boolean;
  };
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        disabled: false,
        textContent: '',
        dataset: {},
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        reportValidity: () => true,
      });
    return elements.get(id)!;
  };
  const requests: Array<{ url: string; options: { method: string; body?: string; headers: Record<string, string> } }> =
    [];
  let stripped = '';
  runInNewContext(settingsScript, {
    URLSearchParams,
    location: { hash: '#token=process-capability', pathname: '/standalone-ai/' },
    history: {
      replaceState: (_a: unknown, _b: unknown, path: string) => {
        stripped = path;
      },
    },
    document: { getElementById: element },
    fetch: async (url: string, options: { method: string; body?: string; headers: Record<string, string> }) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          protocol: 'anthropic',
          baseUrl: 'https://example.test',
          model: 'x',
          hasKey: true,
          enabled: true,
          automaticWhispers: false,
          whisperIntervalSec: 300,
          maxTokens: 1024,
        }),
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stripped, '/standalone-ai/');
  assert.equal(element('apiKey').value, '');
  assert.equal(element('key-state').textContent, '已保存 · 不回显');
  element('apiKey').value = 'write-only-fake-key';
  await element('settings').listeners.submit({ preventDefault() {} });
  assert.equal(element('apiKey').value, '');
  assert.equal(JSON.parse(requests[1].options.body ?? '{}').apiKey, 'write-only-fake-key');
  element('clearApiKey').checked = true;
  element('clearApiKey').listeners.change();
  assert.equal(element('enabled').checked, false);
  assert.equal(element('apiKey').disabled, true);
  await element('settings').listeners.submit({ preventDefault() {} });
  assert.equal(JSON.parse(requests[2].options.body ?? '{}').clearApiKey, true);
  assert.equal(JSON.parse(requests[2].options.body ?? '{}').enabled, false);
  assert.equal(element('apiKey').disabled, false);
  assert.ok(
    requests.every(
      ({ url, options }) =>
        url === '/standalone-ai/settings' && options.headers['X-DSH-Pet-Token'] === 'process-capability',
    ),
  );
});
